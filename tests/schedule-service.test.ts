import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from '../src/main/database';
import {
  DatabaseBackupError,
  DatabaseIntegrityError,
  DatabaseStateError,
} from '../src/main/database/errors';
import {
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from '../src/main/database/sqlite-adapter';
import {
  ScheduleConflictError,
  ScheduleNotFoundError,
  ScheduleValidationError,
} from '../src/main/schedule';
import { WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SCHEDULE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCHEDULE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TODAY = '2026-07-22';
const TOMORROW = '2026-07-23';
const NOW = new Date('2026-07-22T12:34:56.000Z');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('schedule service', () => {
  it('creates overlapping items, updates with revision CAS, archives, and reopens', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      scheduleIds: [SCHEDULE_A, SCHEDULE_B],
    });
    await service.open();

    let snapshot = await service.createScheduleItem({
      workspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      title: '  深度工作 👩‍💻  ',
      kind: 'focus',
      startMinute: 540,
      endMinute: 660,
    });
    expect(snapshot).toMatchObject({
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      items: [
        {
          id: SCHEDULE_A,
          title: '深度工作 👩‍💻',
          kind: 'focus',
          scheduledFor: TODAY,
          startMinute: 540,
          endMinute: 660,
          revision: 1,
        },
      ],
    });
    snapshot = await service.createScheduleItem({
      workspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      title: '允许重叠会议',
      kind: 'meeting',
      startMinute: 600,
      endMinute: 720,
    });
    expect(snapshot.items.map(({ id }) => id)).toEqual([SCHEDULE_A, SCHEDULE_B]);

    snapshot = await service.updateScheduleItem({
      workspaceId: WORKSPACE_A,
      scheduleId: SCHEDULE_A,
      expectedDate: TODAY,
      expectedRevision: 1,
      title: '更新后的专注',
      kind: 'review',
      startMinute: 480,
      endMinute: 540,
    });
    expect(snapshot.items[0]).toMatchObject({
      id: SCHEDULE_A,
      revision: 2,
      kind: 'review',
      startMinute: 480,
    });
    await expect(
      service.updateScheduleItem({
        workspaceId: WORKSPACE_A,
        scheduleId: SCHEDULE_A,
        expectedDate: TODAY,
        expectedRevision: 1,
        title: '不能覆盖',
        kind: 'focus',
        startMinute: 1,
        endMinute: 2,
      }),
    ).rejects.toBeInstanceOf(ScheduleConflictError);

    snapshot = await service.archiveScheduleItem({
      workspaceId: WORKSPACE_A,
      scheduleId: SCHEDULE_A,
      expectedDate: TODAY,
      expectedRevision: 2,
    });
    expect(snapshot.items.map(({ id }) => id)).toEqual([SCHEDULE_B]);
    await service.close();

    const database = openDatabase(dataDirectory);
    expect(
      database
        .prepare(
          'SELECT revision, archived_at IS NOT NULL AS archived FROM schedule_items WHERE id = ?',
        )
        .get(SCHEDULE_A),
    ).toEqual({ revision: 3, archived: 1 });
    expect(() =>
      database
        .prepare('UPDATE schedule_items SET title = ?, revision = revision + 1 WHERE id = ?')
        .run('绕过归档保护', SCHEDULE_A),
    ).toThrow(/archived schedule item is immutable/u);
    expect(() =>
      database.prepare('DELETE FROM schedule_items WHERE id = ?').run(SCHEDULE_A),
    ).toThrow(/schedule items cannot be permanently deleted/u);
    database.close();

    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getScheduleSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject(
      {
        todayDate: TODAY,
        items: [{ id: SCHEDULE_B, revision: 1 }],
      },
    );
    await reopened.close();
  });

  it('uses Main today as authority and rejects stale dates and invalid time ranges', async () => {
    const dataDirectory = await createDataDirectory();
    let today = TODAY;
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      scheduleIds: [SCHEDULE_A],
      today: () => today,
    });
    await service.open();
    await expect(
      service.createScheduleItem({
        workspaceId: WORKSPACE_A,
        expectedDate: TOMORROW,
        title: '不能写到明天',
        kind: 'personal',
        startMinute: 0,
        endMinute: 1,
      }),
    ).rejects.toBeInstanceOf(ScheduleConflictError);
    expect(() =>
      service.createScheduleItem({
        workspaceId: WORKSPACE_A,
        expectedDate: TODAY,
        title: '非法分钟',
        kind: 'focus',
        startMinute: 60,
        endMinute: 60,
      }),
    ).toThrow(ScheduleValidationError);

    await service.createScheduleItem({
      workspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      title: '跨午夜前的日程',
      kind: 'personal',
      startMinute: 1439,
      endMinute: 1440,
    });
    today = TOMORROW;
    await expect(service.getScheduleSnapshot({ workspaceId: WORKSPACE_A })).resolves.toEqual({
      workspaceId: WORKSPACE_A,
      todayDate: TOMORROW,
      items: [],
    });
    await expect(
      service.archiveScheduleItem({
        workspaceId: WORKSPACE_A,
        scheduleId: SCHEDULE_A,
        expectedDate: TODAY,
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(ScheduleConflictError);
    await service.close();

    const database = openDatabase(dataDirectory);
    expect(
      database
        .prepare('SELECT scheduled_for, archived_at FROM schedule_items WHERE title = ?')
        .get('跨午夜前的日程'),
    ).toEqual({ scheduled_for: TODAY, archived_at: null });
    database.close();
  });

  it('isolates workspaces and protects archived workspace schedule rows', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A, WORKSPACE_B],
      scheduleIds: [SCHEDULE_A],
    });
    await service.open();
    await service.createWorkspace({ name: '空间 B', color: WORKSPACE_COLORS[1] });
    await service.createScheduleItem({
      workspaceId: WORKSPACE_B,
      expectedDate: TODAY,
      title: '空间 B 日程',
      kind: 'meeting',
      startMinute: 600,
      endMinute: 660,
    });
    await expect(service.getScheduleSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      items: [],
    });
    await expect(
      service.updateScheduleItem({
        workspaceId: WORKSPACE_A,
        scheduleId: SCHEDULE_A,
        expectedDate: TODAY,
        expectedRevision: 1,
        title: '串写',
        kind: 'meeting',
        startMinute: 600,
        endMinute: 660,
      }),
    ).rejects.toBeInstanceOf(ScheduleNotFoundError);

    await service.archiveWorkspace({ workspaceId: WORKSPACE_B });
    await expect(service.getScheduleSnapshot({ workspaceId: WORKSPACE_B })).rejects.toBeInstanceOf(
      ScheduleNotFoundError,
    );
    const database = openDatabase(dataDirectory);
    expect(() =>
      database
        .prepare('UPDATE schedule_items SET title = ?, revision = revision + 1 WHERE id = ?')
        .run('绕过 Service', SCHEDULE_A),
    ).toThrow(/archived workspace schedule is immutable/u);
    database.close();
    await service.close();
  });

  it('rejects corrupt schedule rows before publishing backups or last-opened metadata', async () => {
    const backupDirectory = await createDataDirectory();
    const backupService = createService(backupDirectory, {
      workspaceIds: [WORKSPACE_A],
      scheduleIds: [SCHEDULE_A],
    });
    await backupService.open();
    await backupService.createScheduleItem({
      workspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      title: '备份前损坏',
      kind: 'focus',
      startMinute: 540,
      endMinute: 600,
    });

    let database = openDatabase(backupDirectory);
    database
      .prepare(
        `UPDATE schedule_items
         SET created_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`,
      )
      .run('not-an-iso-date', 'not-an-iso-date', SCHEDULE_A);
    database.close();

    await expect(backupService.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
    await expect(backupService.listBackups()).resolves.toEqual([]);
    const backupFiles = await readdir(join(backupDirectory, 'backups'));
    expect(backupFiles.some((fileName) => fileName.endsWith('.partial'))).toBe(false);
    await backupService.close();

    const startupDirectory = await createDataDirectory();
    const initialService = createService(startupDirectory, {
      workspaceIds: [WORKSPACE_A],
      scheduleIds: [SCHEDULE_A],
    });
    await initialService.open();
    await initialService.createScheduleItem({
      workspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      title: '启动前损坏',
      kind: 'review',
      startMinute: 600,
      endMinute: 660,
    });
    await initialService.close();

    database = openDatabase(startupDirectory);
    const lastOpenedBefore = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'")
      .get()?.value;
    database
      .prepare(
        `UPDATE schedule_items
         SET created_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ?`,
      )
      .run('not-an-iso-date', 'not-an-iso-date', SCHEDULE_A);
    database.close();

    const corruptService = createService(startupDirectory, {
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    await expect(corruptService.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    database = openDatabase(startupDirectory);
    expect(
      database.prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'").get()?.value,
    ).toBe(lastOpenedBefore);
    database.close();
  });

  it('poisons the shared queue when a schedule transaction cannot roll back safely', async () => {
    const dataDirectory = await createDataDirectory();
    let failInsert = false;
    let failRollback = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithScheduleFailure(
            adapter,
            () => failInsert,
            () => failRollback,
          );
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      scheduleIds: [SCHEDULE_A],
      adapterFactory,
    });
    await service.open();
    failInsert = true;
    failRollback = true;
    const failed = service.createScheduleItem({
      workspaceId: WORKSPACE_A,
      expectedDate: TODAY,
      title: '失败日程',
      kind: 'focus',
      startMinute: 1,
      endMinute: 2,
    });
    const queued = service.getScheduleSnapshot({ workspaceId: WORKSPACE_A });
    await expect(failed).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(queued).rejects.toBeInstanceOf(DatabaseStateError);
    failInsert = false;
    failRollback = false;
    await service.close().catch(() => undefined);
  });

  it('rejects invalid generated ids and civil dates before mutation', async () => {
    const invalidIdDirectory = await createDataDirectory();
    const invalidId = createService(invalidIdDirectory, {
      workspaceIds: [WORKSPACE_A],
      scheduleIds: ['not-a-uuid'],
    });
    await invalidId.open();
    expect(() =>
      invalidId.createScheduleItem({
        workspaceId: WORKSPACE_A,
        expectedDate: TODAY,
        title: '不会落库',
        kind: 'focus',
        startMinute: 1,
        endMinute: 2,
      }),
    ).toThrow(ScheduleValidationError);
    await invalidId.close();

    const invalidDateDirectory = await createDataDirectory();
    const invalidDate = createService(invalidDateDirectory, {
      workspaceIds: [WORKSPACE_A],
      today: () => '2026-02-30',
    });
    await invalidDate.open();
    await expect(
      invalidDate.getScheduleSnapshot({ workspaceId: WORKSPACE_A }),
    ).rejects.toBeInstanceOf(ScheduleValidationError);
    await invalidDate.close();
  });
});

interface ServiceOptions {
  workspaceIds?: string[];
  scheduleIds?: string[];
  today?: () => string;
  now?: () => Date;
  adapterFactory?: SqliteAdapterFactory;
}

function createService(dataDirectory: string, options: ServiceOptions = {}): DatabaseService {
  const workspaceIds = [...(options.workspaceIds ?? [])];
  const scheduleIds = [...(options.scheduleIds ?? [])];
  return new DatabaseService({
    dataDirectory,
    now: options.now ?? (() => new Date(NOW)),
    workspaceIdFactory: () => workspaceIds.shift() ?? WORKSPACE_A,
    noteIdFactory: () => SCHEDULE_B,
    scheduleIdFactory: () => scheduleIds.shift() ?? SCHEDULE_B,
    taskTodayFactory: () => TODAY,
    scheduleTodayFactory: options.today ?? (() => TODAY),
    adapterFactory: options.adapterFactory,
  });
}

async function createDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-schedule-'));
  temporaryDirectories.push(root);
  return join(root, 'data');
}

function openDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'));
}

function bindAdapterWithScheduleFailure(
  adapter: SqliteAdapter,
  shouldFailInsert: () => boolean,
  shouldFailRollback: () => boolean,
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, parameters: readonly unknown[] = []) => {
          if (shouldFailInsert() && /^\s*INSERT INTO schedule_items\b/u.test(sql)) {
            throw new Error('Injected schedule insert failure.');
          }
          return target.run(sql, parameters as never[]);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          if (shouldFailRollback() && sql === 'ROLLBACK') {
            throw new Error('Injected schedule rollback failure.');
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
