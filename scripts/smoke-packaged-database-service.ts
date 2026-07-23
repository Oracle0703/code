import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WORKSPACE_COLORS } from '../src/shared/contracts';
import { DatabaseService } from '../src/main/database';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MetadataRepository } from '../src/main/database/metadata-repository';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
} from '../src/main/database/sqlite-adapter';
import { InboxService } from '../src/main/inbox';
import { WorkspaceService } from '../src/main/workspaces';

const DEFAULT_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const FIRST_INBOX_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_INBOX_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIRST_UNDO_TOKEN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_UNDO_TOKEN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const FIRST_TASK_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_TASK_ID = '55555555-5555-4555-8555-555555555555';
const THIRD_TASK_ID = '66666666-6666-4666-8666-666666666666';
const CONVERTED_TASK_ID = '77777777-7777-4777-8777-777777777777';
const LEGACY_CONVERTED_TASK_ID = '88888888-8888-4888-8888-888888888888';
const FIXED_NOW = new Date('2026-07-22T12:34:56.000Z');
const FIXED_TODAY = '2026-07-22';

async function main(): Promise<void> {
  assert.ok(
    process.versions.electron,
    'Run this bundle with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.',
  );

  const root = await mkdtemp(join(tmpdir(), 'daily workbench 服务 smoke-'));
  try {
    await smokeCurrentService(join(root, 'current 数据'));
    await smokeVersionOneUpgrade(join(root, 'legacy v1 数据'));
    await smokeVersionTwoUpgrade(join(root, 'legacy v2 数据'));
    await smokeVersionThreeUpgrade(join(root, 'legacy v3 数据'));
    console.log(
      `Packaged DatabaseService workspace/inbox/task/migration/backup/reopen smoke test passed ` +
        `(Electron ${process.versions.electron}, Node ${process.versions.node}, ` +
        `SQLite ${process.versions.sqlite}).`,
    );
  } finally {
    await removeSmokeDirectory(root);
  }
}

async function smokeCurrentService(dataDirectory: string): Promise<void> {
  const ids = [DEFAULT_WORKSPACE_ID, SECOND_WORKSPACE_ID];
  const inboxIds = [FIRST_INBOX_ID, SECOND_INBOX_ID];
  const undoTokens = [FIRST_UNDO_TOKEN, SECOND_UNDO_TOKEN];
  const taskIds = [FIRST_TASK_ID, SECOND_TASK_ID, THIRD_TASK_ID, CONVERTED_TASK_ID];
  let service: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    workspaceIdFactory: () => ids.shift() ?? '33333333-3333-4333-8333-333333333333',
    inboxIdFactory: () => inboxIds.shift() ?? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    inboxUndoTokenFactory: () => undoTokens.shift() ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    taskIdFactory: () => taskIds.shift() ?? '99999999-9999-4999-8999-999999999999',
    taskTodayFactory: () => FIXED_TODAY,
  });

  try {
    const initialized = await service.open();
    assert.equal(initialized.migration.fromVersion, 0);
    assert.equal(initialized.migration.toVersion, 4);
    assert.equal(initialized.preMigrationBackup, undefined);

    const status = await service.getStatus();
    assert.deepEqual(
      {
        schemaVersion: status.schemaVersion,
        appliedMigrations: status.appliedMigrations,
        journalMode: status.journalMode,
        integrityCheck: status.integrityCheck,
        backupCount: status.backupCount,
      },
      {
        schemaVersion: 4,
        appliedMigrations: 4,
        journalMode: 'wal',
        integrityCheck: 'ok',
        backupCount: 0,
      },
    );
    assert.equal(status.sqliteVersion, process.versions.sqlite);
    assert.equal('databasePath' in status, false);

    let snapshot = await service.getWorkspaceSnapshot();
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0]?.name, '我的工作台');
    let inbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(inbox.entries, []);
    inbox = await service.createInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      content: '  打包后的 ＡPI / e\u0301 / 👩‍💻  ',
      category: 'uncategorized',
    });
    assert.equal(inbox.entries[0]?.id, FIRST_INBOX_ID);
    assert.equal(inbox.entries[0]?.content, '打包后的 ＡPI / e\u0301 / 👩‍💻');
    inbox = await service.categorizeInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: FIRST_INBOX_ID,
      category: 'task',
    });
    assert.equal(inbox.entries[0]?.category, 'task');
    await service.updateWorkspacePreferences({
      workspaceId: DEFAULT_WORKSPACE_ID,
      patch: { theme: 'light', activeView: 'notes', browserWidth: 518 },
    });

    let tasks = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(tasks.todayDate, FIXED_TODAY);
    assert.deepEqual(tasks.tasks, []);
    tasks = await service.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '  打包后的任务 / e\u0301 / 👩‍💻  ',
      planning: 'today',
    });
    let task = tasks.tasks.find(({ id }) => id === FIRST_TASK_ID);
    assert.ok(task);
    assert.equal(task.title, '打包后的任务 / e\u0301 / 👩‍💻');
    assert.equal(task.status, 'todo');
    assert.equal(task.plannedFor, FIXED_TODAY);
    assert.equal(task.sourceInboxEntryId, null);
    assert.equal(task.completedAt, null);

    tasks = await service.createTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      title: '稍后处理的任务',
      planning: 'none',
    });
    task = tasks.tasks.find(({ id }) => id === SECOND_TASK_ID);
    assert.ok(task);
    assert.equal(task.plannedFor, null);
    tasks = await service.renameTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: FIRST_TASK_ID,
      title: '已重命名的打包任务',
    });
    tasks = await service.updateTaskStatus({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: FIRST_TASK_ID,
      status: 'in_progress',
    });
    tasks = await service.updateTaskStatus({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: FIRST_TASK_ID,
      status: 'completed',
    });
    task = tasks.tasks.find(({ id }) => id === FIRST_TASK_ID);
    assert.ok(task);
    assert.equal(task.title, '已重命名的打包任务');
    assert.equal(task.status, 'completed');
    assert.equal(task.completedAt, FIXED_NOW.toISOString());
    tasks = await service.updateTaskPlanning({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: SECOND_TASK_ID,
      planning: 'today',
    });
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, FIXED_TODAY);
    tasks = await service.updateTaskPlanning({
      workspaceId: DEFAULT_WORKSPACE_ID,
      taskId: SECOND_TASK_ID,
      planning: 'none',
    });
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, null);

    snapshot = await service.createWorkspace({
      name: '开发 与 探索 🧪',
      color: WORKSPACE_COLORS[2],
    });
    assert.equal(snapshot.currentWorkspaceId, SECOND_WORKSPACE_ID);
    inbox = await service.createInboxEntry({
      workspaceId: SECOND_WORKSPACE_ID,
      content: 'https://example.com/工作区隔离',
      category: 'link',
    });
    assert.equal(inbox.entries[0]?.id, SECOND_INBOX_ID);
    tasks = await service.createTask({
      workspaceId: SECOND_WORKSPACE_ID,
      title: '第二工作区任务',
      planning: 'none',
    });
    assert.equal(tasks.workspaceId, SECOND_WORKSPACE_ID);
    assert.equal(tasks.tasks[0]?.id, THIRD_TASK_ID);
    tasks = await service.updateTaskStatus({
      workspaceId: SECOND_WORKSPACE_ID,
      taskId: THIRD_TASK_ID,
      status: 'in_progress',
    });
    assert.equal(tasks.tasks[0]?.status, 'in_progress');
    assert.equal(
      (await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).entries.length,
      1,
    );
    assert.deepEqual(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks
        .map(({ id }) => id)
        .sort(),
      [FIRST_TASK_ID, SECOND_TASK_ID],
    );
    let archivedInbox = await service.archiveInboxEntry({
      workspaceId: SECOND_WORKSPACE_ID,
      entryId: SECOND_INBOX_ID,
    });
    assert.equal(archivedInbox.undoToken, FIRST_UNDO_TOKEN);
    assert.equal(archivedInbox.snapshot.entries.length, 0);
    inbox = await service.undoInboxArchive({
      workspaceId: SECOND_WORKSPACE_ID,
      undoToken: archivedInbox.undoToken,
    });
    assert.equal(inbox.entries[0]?.id, SECOND_INBOX_ID);
    archivedInbox = await service.archiveInboxEntry({
      workspaceId: SECOND_WORKSPACE_ID,
      entryId: SECOND_INBOX_ID,
    });
    assert.equal(archivedInbox.undoToken, SECOND_UNDO_TOKEN);
    await service.renameWorkspace({ workspaceId: SECOND_WORKSPACE_ID, name: '研发工作区 🧪' });
    await service.updateWorkspacePreferences({
      workspaceId: SECOND_WORKSPACE_ID,
      patch: { activeView: 'tasks', browserOpen: false, terminalHeight: 472 },
    });

    snapshot = await service.activateWorkspace({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(
      {
        theme: snapshot.preferences.theme,
        activeView: snapshot.preferences.activeView,
        browserWidth: snapshot.preferences.browserWidth,
      },
      { theme: 'light', activeView: 'notes', browserWidth: 518 },
    );
    const conversion = await service.convertInboxToTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: FIRST_INBOX_ID,
      planning: 'today',
    });
    assert.equal(conversion.inboxSnapshot.workspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(conversion.inboxSnapshot.entries, []);
    task = conversion.taskSnapshot.tasks.find(({ id }) => id === CONVERTED_TASK_ID);
    assert.ok(task);
    assert.equal(task.title, '打包后的 ＡPI / e\u0301 / 👩‍💻');
    assert.equal(task.sourceInboxEntryId, FIRST_INBOX_ID);
    assert.equal(task.plannedFor, FIXED_TODAY);
    const taskCountAfterConversion = conversion.taskSnapshot.tasks.length;
    await assert.rejects(
      service.convertInboxToTask({
        workspaceId: DEFAULT_WORKSPACE_ID,
        entryId: FIRST_INBOX_ID,
        planning: 'none',
      }),
    );
    assert.equal(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks.length,
      taskCountAfterConversion,
    );
    assert.deepEqual(
      (await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).entries,
      [],
    );
    snapshot = await service.activateWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    assert.deepEqual(
      {
        activeView: snapshot.preferences.activeView,
        browserOpen: snapshot.preferences.browserOpen,
        terminalHeight: snapshot.preferences.terminalHeight,
      },
      { activeView: 'tasks', browserOpen: false, terminalHeight: 472 },
    );

    snapshot = await service.archiveWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      snapshot.workspaces.map(({ id }) => id),
      [DEFAULT_WORKSPACE_ID],
    );

    const created = await service.createBackup();
    assert.equal(created.reason, 'manual');
    assert.equal(created.schemaVersion, 4);
    assert.equal('path' in created, false);
    assert.deepEqual(await service.listBackups(), [created]);
    await service.close();
    service = undefined;

    const backupPath = join(dataDirectory, 'backups', created.fileName);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 4);
      assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM workspaces').get()?.count, 2);
      assert.equal(
        backup.prepare('SELECT current_workspace_id FROM workspace_app_state').get()
          ?.current_workspace_id,
        DEFAULT_WORKSPACE_ID,
      );
      assert.equal(
        backup.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(SECOND_WORKSPACE_ID)
          ?.archived_at !== null,
        true,
      );
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM inbox_entries').get()?.count, 2);
      const archivedInboxRow = backup
        .prepare(
          'SELECT category, archived_at IS NOT NULL AS archived FROM inbox_entries WHERE id = ?',
        )
        .get(SECOND_INBOX_ID);
      assert.equal(archivedInboxRow?.category, 'link');
      assert.equal(archivedInboxRow?.archived, 1);
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count, 4);
      const convertedTaskRow = backup
        .prepare(
          `SELECT title, status, planned_for, source_inbox_entry_id,
                  completed_at IS NOT NULL AS completed
           FROM tasks
           WHERE id = ?`,
        )
        .get(CONVERTED_TASK_ID);
      assert.equal(convertedTaskRow?.title, '打包后的 ＡPI / e\u0301 / 👩‍💻');
      assert.equal(convertedTaskRow?.status, 'todo');
      assert.equal(convertedTaskRow?.planned_for, FIXED_TODAY);
      assert.equal(convertedTaskRow?.source_inbox_entry_id, FIRST_INBOX_ID);
      assert.equal(convertedTaskRow?.completed, 0);
      const completedTaskRow = backup
        .prepare('SELECT status, completed_at, planned_for FROM tasks WHERE id = ?')
        .get(FIRST_TASK_ID);
      assert.equal(completedTaskRow?.status, 'completed');
      assert.equal(completedTaskRow?.completed_at, FIXED_NOW.toISOString());
      assert.equal(completedTaskRow?.planned_for, FIXED_TODAY);
    } finally {
      backup.close();
    }

    service = new DatabaseService({ dataDirectory, taskTodayFactory: () => FIXED_TODAY });
    const reopened = await service.open();
    assert.equal(reopened.migration.fromVersion, 4);
    assert.equal(reopened.migration.toVersion, 4);
    assert.equal(reopened.migration.applied.length, 0);
    snapshot = await service.getWorkspaceSnapshot();
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.preferences.theme, 'light');
    inbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(inbox.entries, []);
    tasks = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(tasks.todayDate, FIXED_TODAY);
    assert.equal(tasks.tasks.length, 3);
    assert.equal(tasks.tasks.find(({ id }) => id === FIRST_TASK_ID)?.status, 'completed');
    assert.equal(
      tasks.tasks.find(({ id }) => id === CONVERTED_TASK_ID)?.sourceInboxEntryId,
      FIRST_INBOX_ID,
    );
    assert.equal(tasks.tasks.find(({ id }) => id === SECOND_TASK_ID)?.plannedFor, null);
    assert.equal((await service.getStatus()).backupCount, 1);
  } finally {
    await service?.close().catch(() => undefined);
  }
}

async function smokeVersionOneUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner([DEFAULT_MIGRATIONS[0]]).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    workspaceIdFactory: () => DEFAULT_WORKSPACE_ID,
    taskTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 1);
    assert.equal(upgraded.migration.toVersion, 4);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 1);
    assert.equal((await service.getWorkspaceSnapshot()).currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks,
      [],
    );
    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'workspaces'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function smokeVersionTwoUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 2)).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  new WorkspaceService({
    execute: async (operation) => operation(database),
    now: () => FIXED_NOW,
    idFactory: () => DEFAULT_WORKSPACE_ID,
  }).initialize(database);
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    inboxIdFactory: () => FIRST_INBOX_ID,
    taskTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 2);
    assert.equal(upgraded.migration.toVersion, 4);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 2);
    assert.deepEqual(
      (await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).entries,
      [],
    );
    await service.createInboxEntry({
      workspaceId: DEFAULT_WORKSPACE_ID,
      content: 'v2 → v4 打包升级',
      category: 'note',
    });
    assert.deepEqual(
      (await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID })).tasks,
      [],
    );

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'inbox_entries'")
          .get()?.count,
        0,
      );
      assert.equal(
        legacySnapshot.prepare('SELECT COUNT(*) AS count FROM workspaces').get()?.count,
        1,
      );
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'tasks'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function smokeVersionThreeUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 3)).apply(database);
  new MetadataRepository(database).initialize(
    FIXED_NOW.toISOString(),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  new WorkspaceService({
    execute: async (operation) => operation(database),
    now: () => FIXED_NOW,
    idFactory: () => DEFAULT_WORKSPACE_ID,
  }).initialize(database);
  const legacyInbox = new InboxService({
    execute: async (operation) => operation(database),
    now: () => FIXED_NOW,
    idFactory: () => FIRST_INBOX_ID,
  });
  await legacyInbox.create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    content: 'v3 保留到显式转换的任务线索 👩‍💻',
    category: 'task',
  });
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    now: () => FIXED_NOW,
    taskIdFactory: () => LEGACY_CONVERTED_TASK_ID,
    taskTodayFactory: () => FIXED_TODAY,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 3);
    assert.equal(upgraded.migration.toVersion, 4);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 3);
    const beforeConversion = await service.getTaskSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(beforeConversion.todayDate, FIXED_TODAY);
    assert.deepEqual(beforeConversion.tasks, []);
    const preservedInbox = await service.getInboxSnapshot({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.equal(preservedInbox.entries.length, 1);
    assert.equal(preservedInbox.entries[0]?.id, FIRST_INBOX_ID);
    assert.equal(preservedInbox.entries[0]?.category, 'task');

    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 3);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'tasks'")
          .get()?.count,
        0,
      );
      const inboxRow = legacySnapshot
        .prepare('SELECT category, archived_at IS NULL AS active FROM inbox_entries WHERE id = ?')
        .get(FIRST_INBOX_ID);
      assert.equal(inboxRow?.category, 'task');
      assert.equal(inboxRow?.active, 1);
    } finally {
      legacySnapshot.close();
    }

    const converted = await service.convertInboxToTask({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entryId: FIRST_INBOX_ID,
      planning: 'today',
    });
    assert.deepEqual(converted.inboxSnapshot.entries, []);
    assert.equal(converted.taskSnapshot.tasks.length, 1);
    assert.equal(converted.taskSnapshot.tasks[0]?.id, LEGACY_CONVERTED_TASK_ID);
    assert.equal(converted.taskSnapshot.tasks[0]?.title, 'v3 保留到显式转换的任务线索 👩‍💻');
    assert.equal(converted.taskSnapshot.tasks[0]?.sourceInboxEntryId, FIRST_INBOX_ID);
    assert.equal(converted.taskSnapshot.tasks[0]?.plannedFor, FIXED_TODAY);
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function removeSmokeDirectory(root: string): Promise<void> {
  const expectedPrefix = join(tmpdir(), 'daily workbench 服务 smoke-');
  assert.ok(root.startsWith(expectedPrefix), `Refusing to clean an unexpected path: ${root}`);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 200,
  });
}

void main().catch((error: unknown) => {
  console.error('Packaged DatabaseService smoke test failed.', error);
  process.exitCode = 1;
});
