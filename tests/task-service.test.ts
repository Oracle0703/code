import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/main/database/database-service';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import {
  DatabaseBackupError,
  DatabaseIntegrityError,
  DatabaseStateError,
} from '../src/main/database/errors';
import { MetadataRepository } from '../src/main/database/metadata-repository';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from '../src/main/database/sqlite-adapter';
import { InboxService } from '../src/main/inbox';
import { TaskNotFoundError, TaskValidationError } from '../src/main/tasks';
import { WorkspaceService } from '../src/main/workspaces';
import { PLANNING_DAY_TOKENS, WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TASK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TASK_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-07-22T12:00:00.000Z');
const TODAY = '2026-07-22';
const PLANNING_DATES = [
  '2026-07-22',
  '2026-07-23',
  '2026-07-24',
  '2026-07-25',
  '2026-07-26',
  '2026-07-27',
  '2026-07-28',
] as const;
const PLANNING_DAYS = PLANNING_DAY_TOKENS.map((token, index) => ({
  token,
  date: PLANNING_DATES[index]!,
}));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

describe('task service', () => {
  it('creates, renames, plans, advances, completes, reopens, and persists tasks', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      taskIds: [TASK_A],
    });
    const initialized = await service.open();
    expect(initialized.migration).toMatchObject({ fromVersion: 0, toVersion: 10 });
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toEqual({
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      planningDays: PLANNING_DAYS,
      tasks: [],
    });

    const original = '  完成 ＡPI / e\u0301 / 👩‍💻  ';
    let snapshot = await service.createTask({
      workspaceId: WORKSPACE_A,
      title: original,
      planning: 'day-0',
    });
    expect(snapshot.tasks).toMatchObject([
      {
        id: TASK_A,
        title: original.trim(),
        status: 'todo',
        plannedFor: TODAY,
        sourceInboxEntryId: null,
        completedAt: null,
      },
    ]);
    expect(snapshot.tasks[0]?.title).not.toBe(original.trim().normalize('NFKC'));

    snapshot = await service.renameTask({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
      title: '  更新后的任务  ',
    });
    expect(snapshot.tasks[0]?.title).toBe('更新后的任务');
    snapshot = await service.updateTaskStatus({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
      status: 'in_progress',
    });
    expect(snapshot.tasks[0]).toMatchObject({ status: 'in_progress', completedAt: null });
    snapshot = await service.updateTaskStatus({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
      status: 'completed',
    });
    expect(snapshot.tasks[0]?.completedAt).toBe(NOW.toISOString());
    snapshot = await service.updateTaskPlanning({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
      planning: 'none',
    });
    expect(snapshot.tasks[0]?.plannedFor).toBeNull();
    snapshot = await service.updateTaskStatus({
      workspaceId: WORKSPACE_A,
      taskId: TASK_A,
      status: 'todo',
    });
    expect(snapshot.tasks[0]).toMatchObject({ status: 'todo', completedAt: null });
    await service.close();

    const reopened = createService(dataDirectory);
    const result = await reopened.open();
    expect(result.migration).toEqual({ fromVersion: 10, toVersion: 10, applied: [] });
    await expect(reopened.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      todayDate: TODAY,
      tasks: [{ id: TASK_A, title: '更新后的任务', status: 'todo', plannedFor: null }],
    });
    await reopened.close();
  });

  it('maps all seven fixed planning tokens for creation, updates, and inbox conversion', async () => {
    const dataDirectory = await createDataDirectory();
    const taskIds = Array.from(
      { length: 15 },
      (_, index) => `10000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
    );
    const inboxIds = Array.from(
      { length: 7 },
      (_, index) => `20000000-0000-4000-8000-${(index + 1).toString().padStart(12, '0')}`,
    );
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds,
      taskIds,
    });
    await service.open();

    for (const [index, planning] of PLANNING_DAY_TOKENS.entries()) {
      const snapshot = await service.createTask({
        workspaceId: WORKSPACE_A,
        title: `创建 ${planning}`,
        planning,
      });
      expect(snapshot.planningDays).toEqual(PLANNING_DAYS);
      expect(snapshot.tasks.find(({ id }) => id === taskIds[index])).toMatchObject({
        plannedFor: PLANNING_DATES[index],
      });
    }

    const updateTaskId = taskIds[7]!;
    await service.createTask({
      workspaceId: WORKSPACE_A,
      title: '逐日移动',
      planning: 'none',
    });
    for (const [index, planning] of PLANNING_DAY_TOKENS.entries()) {
      const snapshot = await service.updateTaskPlanning({
        workspaceId: WORKSPACE_A,
        taskId: updateTaskId,
        planning,
      });
      expect(snapshot.tasks.find(({ id }) => id === updateTaskId)).toMatchObject({
        plannedFor: PLANNING_DATES[index],
      });
    }

    for (const [index, planning] of PLANNING_DAY_TOKENS.entries()) {
      await service.createInboxEntry({
        workspaceId: WORKSPACE_A,
        content: `转换 ${planning}`,
        category: 'task',
      });
      const converted = await service.convertInboxToTask({
        workspaceId: WORKSPACE_A,
        entryId: inboxIds[index]!,
        planning,
      });
      expect(
        converted.taskSnapshot.tasks.find(({ id }) => id === taskIds[index + 8]),
      ).toMatchObject({
        plannedFor: PLANNING_DATES[index],
        sourceInboxEntryId: inboxIds[index],
      });
    }

    await service.close();
  });

  it('keeps dates that fall outside the current rolling window readable', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      taskIds: [TASK_A],
    });
    await service.open();
    await service.createTask({
      workspaceId: WORKSPACE_A,
      title: '窗口外仍保留',
      planning: 'day-6',
    });
    await service.close();

    const reopened = createService(dataDirectory, { today: () => '2026-08-01' });
    await reopened.open();
    const snapshot = await reopened.getTaskSnapshot({ workspaceId: WORKSPACE_A });
    expect(snapshot).toMatchObject({
      todayDate: '2026-08-01',
      tasks: [{ id: TASK_A, plannedFor: '2026-07-28' }],
    });
    expect(snapshot.planningDays).toEqual([
      { token: 'day-0', date: '2026-08-01' },
      { token: 'day-1', date: '2026-08-02' },
      { token: 'day-2', date: '2026-08-03' },
      { token: 'day-3', date: '2026-08-04' },
      { token: 'day-4', date: '2026-08-05' },
      { token: 'day-5', date: '2026-08-06' },
      { token: 'day-6', date: '2026-08-07' },
    ]);
    await reopened.close();
  });

  it('isolates workspaces and makes archived workspace tasks immutable', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A, WORKSPACE_B],
      taskIds: [TASK_A, TASK_B],
    });
    await service.open();
    await service.createTask({ workspaceId: WORKSPACE_A, title: '空间 A', planning: 'day-0' });
    await service.createWorkspace({ name: '空间 B', color: WORKSPACE_COLORS[1] });
    await service.createTask({ workspaceId: WORKSPACE_B, title: '空间 B', planning: 'none' });

    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      tasks: [{ id: TASK_A }],
    });
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_B })).resolves.toMatchObject({
      tasks: [{ id: TASK_B }],
    });
    await expect(
      service.renameTask({ workspaceId: WORKSPACE_A, taskId: TASK_B, title: '串写' }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);

    await service.archiveWorkspace({ workspaceId: WORKSPACE_B });
    await expect(
      service.updateTaskStatus({
        workspaceId: WORKSPACE_B,
        taskId: TASK_B,
        status: 'completed',
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);

    const database = openDatabase(dataDirectory);
    expect(() =>
      database
        .prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?')
        .run('绕过 Service', NOW.toISOString(), TASK_B),
    ).toThrow(/archived workspace tasks are immutable/u);
    expect(() => database.prepare('DELETE FROM tasks WHERE id = ?').run(TASK_B)).toThrow(
      /archived workspace tasks are immutable/u,
    );
    database.close();
    await service.close();
  });

  it('atomically converts one active inbox entry and keeps its unique source archived', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      taskIds: [TASK_A, TASK_B],
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '  从收件箱转换 👩‍💻  ',
      category: 'task',
    });

    const converted = await service.convertInboxToTask({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_A,
      planning: 'day-0',
    });
    expect(converted.inboxSnapshot.entries).toEqual([]);
    expect(converted.taskSnapshot.tasks).toMatchObject([
      {
        id: TASK_A,
        title: '从收件箱转换 👩‍💻',
        plannedFor: TODAY,
        sourceInboxEntryId: ENTRY_A,
      },
    ]);
    await expect(
      service.convertInboxToTask({
        workspaceId: WORKSPACE_A,
        entryId: ENTRY_A,
        planning: 'none',
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);

    const database = openDatabase(dataDirectory);
    expect(
      database.prepare('SELECT archived_at IS NOT NULL AS archived FROM inbox_entries').get(),
    ).toEqual({ archived: 1 });
    expect(() =>
      database
        .prepare('UPDATE inbox_entries SET archived_at = NULL, updated_at = ? WHERE id = ?')
        .run(NOW.toISOString(), ENTRY_A),
    ).toThrow(/task inbox source must remain archived/u);
    database.close();
    await service.close();
  });

  it('rolls back inbox archival when task insertion fails', async () => {
    const dataDirectory = await createDataDirectory();
    let failTaskInsert = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithTaskFailure(
            adapter,
            () => failTaskInsert,
            () => false,
          );
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      taskIds: [TASK_A],
      adapterFactory,
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '必须整笔回滚',
      category: 'task',
    });
    failTaskInsert = true;
    await expect(
      service.convertInboxToTask({
        workspaceId: WORKSPACE_A,
        entryId: ENTRY_A,
        planning: 'day-0',
      }),
    ).rejects.toThrow();
    failTaskInsert = false;
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A }],
    });
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      tasks: [],
    });
    await service.close();
  });

  it('rolls back a conversion when COMMIT fails before SQLite commits', async () => {
    const dataDirectory = await createDataDirectory();
    let failCommit = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithCommitFailure(adapter, () => (failCommit ? 'before' : 'none'));
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      taskIds: [TASK_A],
      adapterFactory,
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '提交前失败必须回滚',
      category: 'task',
    });
    failCommit = true;
    await expect(
      service.convertInboxToTask({
        workspaceId: WORKSPACE_A,
        entryId: ENTRY_A,
        planning: 'day-0',
      }),
    ).rejects.toThrow();
    failCommit = false;
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A }],
    });
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      tasks: [],
    });
    await service.close();
  });

  it('poisons the queue when COMMIT succeeds before the adapter throws', async () => {
    const dataDirectory = await createDataDirectory();
    let failCommit = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithCommitFailure(adapter, () => (failCommit ? 'after' : 'none'));
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      taskIds: [TASK_A],
      adapterFactory,
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '提交结果未知必须隔离',
      category: 'task',
    });
    failCommit = true;
    const failed = service.convertInboxToTask({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_A,
      planning: 'day-0',
    });
    const queued = service.getTaskSnapshot({ workspaceId: WORKSPACE_A });
    await expect(failed).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(queued).rejects.toBeInstanceOf(DatabaseStateError);
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      DatabaseStateError,
    );
    failCommit = false;
    await service.close();

    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [],
    });
    await expect(reopened.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      tasks: [{ id: TASK_A, sourceInboxEntryId: ENTRY_A }],
    });
    await reopened.close();
  });

  it('poisons the shared queue when a task transaction cannot roll back safely', async () => {
    const dataDirectory = await createDataDirectory();
    let failTaskInsert = false;
    let failRollback = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithTaskFailure(
            adapter,
            () => failTaskInsert,
            () => failRollback,
          );
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      taskIds: [TASK_A],
      adapterFactory,
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '毒化保护',
      category: 'task',
    });
    failTaskInsert = true;
    failRollback = true;
    const failed = service.convertInboxToTask({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_A,
      planning: 'day-0',
    });
    const queued = service.createBackup();
    await expect(failed).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(queued).rejects.toBeInstanceOf(DatabaseStateError);
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      DatabaseStateError,
    );
    failTaskInsert = false;
    failRollback = false;
    await service.close().catch(() => undefined);

    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A }],
    });
    await reopened.close();
  });

  it('upgrades v3 without implicitly converting task-category inbox entries', async () => {
    const dataDirectory = await createDataDirectory();
    await createVersionThreeDatabase(dataDirectory);
    const service = createService(dataDirectory, { taskIds: [TASK_A] });
    const result = await service.open();
    expect(result.migration).toMatchObject({ fromVersion: 3, toVersion: 10 });
    expect(result.preMigrationBackup).toMatchObject({
      reason: 'pre-migration',
      schemaVersion: 3,
    });
    await expect(service.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      tasks: [],
    });
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A, category: 'task' }],
    });

    const backup = result.preMigrationBackup!;
    const legacy = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(legacy.prepare('PRAGMA user_version').get()).toEqual({ user_version: 3 });
      expect(
        legacy.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'tasks'").get(),
      ).toEqual({ count: 0 });
      expect(legacy.prepare('SELECT COUNT(*) AS count FROM inbox_entries').get()).toEqual({
        count: 1,
      });
    } finally {
      legacy.close();
    }
    await service.close();
  });

  it('rejects corrupt task rows without committing last-opened metadata', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      taskIds: [TASK_A],
    });
    await service.open();
    await service.createTask({ workspaceId: WORKSPACE_A, title: '即将损坏', planning: 'day-0' });
    await service.close();

    let database = openDatabase(dataDirectory);
    const before = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'")
      .get()?.value;
    database
      .prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('not-an-iso-date', 'not-an-iso-date', TASK_A);
    database.close();

    const corrupt = createService(dataDirectory, { now: () => new Date('2030-01-01T00:00:00Z') });
    await expect(corrupt.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    database = openDatabase(dataDirectory);
    expect(
      database.prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'").get()?.value,
    ).toBe(before);
    database.close();
  });

  it('rejects corrupt task backups and unpublished partial files', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      taskIds: [TASK_A],
    });
    await service.open();
    await service.createTask({ workspaceId: WORKSPACE_A, title: '备份前损坏', planning: 'none' });
    const database = openDatabase(dataDirectory);
    database
      .prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('not-an-iso-date', 'not-an-iso-date', TASK_A);
    database.close();

    await expect(service.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
    await expect(service.listBackups()).resolves.toEqual([]);
    const backupFiles = await readdir(join(dataDirectory, 'backups'));
    expect(backupFiles.some((fileName) => fileName.endsWith('.partial'))).toBe(false);
    await service.close();
  });

  it('validates generated ids, natural dates, and renderer-owned fields at the service boundary', async () => {
    const invalidIdDirectory = await createDataDirectory();
    const invalidId = createService(invalidIdDirectory, {
      workspaceIds: [WORKSPACE_A],
      taskIds: ['NOT-A-UUID'],
    });
    await invalidId.open();
    expect(() =>
      invalidId.createTask({ workspaceId: WORKSPACE_A, title: 'invalid id', planning: 'none' }),
    ).toThrow(TaskValidationError);
    await invalidId.close();

    const legacyPlanningDirectory = await createDataDirectory();
    const legacyPlanning = createService(legacyPlanningDirectory, {
      workspaceIds: [WORKSPACE_A],
      taskIds: [TASK_A],
    });
    await legacyPlanning.open();
    expect(() =>
      legacyPlanning.createTask({
        workspaceId: WORKSPACE_A,
        title: 'legacy planning',
        planning: 'today' as never,
      }),
    ).toThrow(TaskValidationError);
    await expect(
      legacyPlanning.getTaskSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({ tasks: [] });
    await legacyPlanning.close();

    const invalidDateDirectory = await createDataDirectory();
    const invalidDate = createService(invalidDateDirectory, {
      workspaceIds: [WORKSPACE_A],
      today: () => '2026-02-30',
    });
    await invalidDate.open();
    await expect(invalidDate.getTaskSnapshot({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      TaskValidationError,
    );
    await invalidDate.close();

    const lowYearDirectory = await createDataDirectory();
    const lowYear = createService(lowYearDirectory, {
      workspaceIds: [WORKSPACE_A],
      today: () => '0001-01-01',
    });
    await lowYear.open();
    await expect(lowYear.getTaskSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      todayDate: '0001-01-01',
    });
    await lowYear.close();
  });

  it('rejects invalid civil dates at the SQLite boundary', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      taskIds: [TASK_A],
    });
    await service.open();
    await service.createTask({ workspaceId: WORKSPACE_A, title: '日期约束', planning: 'day-0' });

    const database = openDatabase(dataDirectory);
    for (const invalidDate of ['0000-01-01', '2026-00-10', '2026-02-30', '2026-99-99']) {
      expect(() =>
        database.prepare('UPDATE tasks SET planned_for = ? WHERE id = ?').run(invalidDate, TASK_A),
      ).toThrow();
    }
    expect(database.prepare('SELECT planned_for FROM tasks WHERE id = ?').get(TASK_A)).toEqual({
      planned_for: TODAY,
    });
    database.close();
    await service.close();
  });
});

interface ServiceOptions {
  workspaceIds?: string[];
  inboxIds?: string[];
  taskIds?: string[];
  now?: () => Date;
  today?: () => string;
  adapterFactory?: SqliteAdapterFactory;
}

function createService(dataDirectory: string, options: ServiceOptions = {}): DatabaseService {
  const workspaceIds = [...(options.workspaceIds ?? [])];
  const inboxIds = [...(options.inboxIds ?? [])];
  const taskIds = [...(options.taskIds ?? [])];
  return new DatabaseService({
    dataDirectory,
    now: options.now ?? (() => new Date(NOW)),
    workspaceIdFactory: () => workspaceIds.shift() ?? WORKSPACE_A,
    inboxIdFactory: () => inboxIds.shift() ?? ENTRY_A,
    taskIdFactory: () => taskIds.shift() ?? TASK_C,
    taskTodayFactory: options.today ?? (() => TODAY),
    adapterFactory: options.adapterFactory,
  });
}

async function createDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-tasks-'));
  temporaryDirectories.push(root);
  return join(root, 'data');
}

function openDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'));
}

async function createVersionThreeDatabase(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 3)).apply(database);
  new MetadataRepository(database).initialize(
    NOW.toISOString(),
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  );
  new WorkspaceService({
    execute: async (operation) => operation(database),
    now: () => new Date(NOW),
    idFactory: () => WORKSPACE_A,
  }).initialize(database, NOW.toISOString());
  const inbox = new InboxService({
    execute: async (operation) => operation(database),
    now: () => new Date(NOW),
    idFactory: () => ENTRY_A,
  });
  await inbox.create({
    workspaceId: WORKSPACE_A,
    content: 'v3 任务线索不会自动转换',
    category: 'task',
  });
  database.close();
}

function bindAdapterWithTaskFailure(
  adapter: SqliteAdapter,
  shouldFailInsert: () => boolean,
  shouldFailRollback: () => boolean,
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, parameters: readonly SQLInputValue[] = []) => {
          if (shouldFailInsert() && sql.includes('INSERT INTO tasks')) {
            throw new Error('injected task insertion failure');
          }
          return target.run(sql, parameters);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          if (shouldFailRollback() && sql === 'ROLLBACK') {
            throw new Error('injected task rollback failure');
          }
          target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function bindAdapterWithCommitFailure(
  adapter: SqliteAdapter,
  failureMode: () => 'none' | 'before' | 'after',
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'exec') {
        return (sql: string) => {
          const mode = sql === 'COMMIT' ? failureMode() : 'none';
          if (mode === 'before') throw new Error('injected pre-commit failure');
          target.exec(sql);
          if (mode === 'after') throw new Error('injected post-commit failure');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
