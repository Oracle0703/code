import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_COLORS } from '../src/shared/contracts';
import { DatabaseService } from '../src/main/database/database-service';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { DatabaseIntegrityError, DatabaseStateError } from '../src/main/database/errors';
import { MetadataRepository } from '../src/main/database/metadata-repository';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from '../src/main/database/sqlite-adapter';
import { WorkspaceConflictError, WorkspaceNotFoundError } from '../src/main/workspaces';

const DEFAULT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-22T12:00:00.000Z');
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

describe('workspace service', () => {
  it('bootstraps exactly one default workspace and reopens idempotently', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID]);
    const initialized = await service.open();
    expect(initialized.migration).toMatchObject({ fromVersion: 0, toVersion: 10 });
    await expect(service.getWorkspaceSnapshot()).resolves.toMatchObject({
      currentWorkspaceId: DEFAULT_ID,
      workspaces: [
        {
          id: DEFAULT_ID,
          name: '我的工作台',
          color: WORKSPACE_COLORS[0],
        },
      ],
      preferences: {
        activeView: 'today',
        theme: 'dark',
        sidebarCollapsed: false,
        browserOpen: true,
        browserWidth: 430,
        terminalOpen: true,
        terminalHeight: 260,
      },
    });
    await service.close();

    const reopened = createService(dataDirectory, [SECOND_ID]);
    await reopened.open();
    const snapshot = await reopened.getWorkspaceSnapshot();
    expect(snapshot.currentWorkspaceId).toBe(DEFAULT_ID);
    expect(snapshot.workspaces).toHaveLength(1);
    await reopened.close();
  });

  it('creates, renames, switches, and restores isolated preferences after restart', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID, SECOND_ID]);
    await service.open();

    await service.updateWorkspacePreferences({
      workspaceId: DEFAULT_ID,
      patch: { theme: 'light', browserWidth: 512, activeView: 'notes' },
    });
    const created = await service.createWorkspace({
      name: '研发与探索',
      color: WORKSPACE_COLORS[2],
    });
    expect(created.currentWorkspaceId).toBe(SECOND_ID);
    expect(created.preferences).toMatchObject({ theme: 'dark', activeView: 'today' });
    await service.updateWorkspacePreferences({
      workspaceId: SECOND_ID,
      patch: {
        activeView: 'tasks',
        sidebarCollapsed: true,
        browserOpen: false,
        terminalHeight: 480,
      },
    });
    await service.renameWorkspace({ workspaceId: SECOND_ID, name: '研发 空间 🧪' });

    const first = await service.activateWorkspace({ workspaceId: DEFAULT_ID });
    expect(first.preferences).toMatchObject({
      theme: 'light',
      browserWidth: 512,
      activeView: 'notes',
    });
    await service.close();

    const reopened = createService(dataDirectory, []);
    await reopened.open();
    const restoredFirst = await reopened.getWorkspaceSnapshot();
    expect(restoredFirst.currentWorkspaceId).toBe(DEFAULT_ID);
    expect(restoredFirst.preferences).toMatchObject({ theme: 'light', activeView: 'notes' });
    const restoredSecond = await reopened.activateWorkspace({ workspaceId: SECOND_ID });
    expect(restoredSecond.workspaces.find(({ id }) => id === SECOND_ID)?.name).toBe('研发 空间 🧪');
    expect(restoredSecond.preferences).toMatchObject({
      activeView: 'tasks',
      sidebarCollapsed: true,
      browserOpen: false,
      terminalHeight: 480,
    });
    await reopened.close();
  });

  it('normalizes Unicode names and rejects active name collisions', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID, SECOND_ID, THIRD_ID]);
    await service.open();
    const created = await service.createWorkspace({
      name: '  Ａlpha  ',
      color: WORKSPACE_COLORS[1],
    });
    expect(created.workspaces.find(({ id }) => id === SECOND_ID)?.name).toBe('Alpha');
    await expect(
      service.createWorkspace({ name: 'alpha', color: WORKSPACE_COLORS[2] }),
    ).rejects.toBeInstanceOf(WorkspaceConflictError);
    await service.close();
  });

  it('archives the current workspace by atomically selecting a deterministic fallback', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID, SECOND_ID, THIRD_ID]);
    await service.open();
    await service.createWorkspace({ name: '第二空间', color: WORKSPACE_COLORS[1] });
    await service.createWorkspace({ name: '第三空间', color: WORKSPACE_COLORS[2] });
    await service.activateWorkspace({ workspaceId: SECOND_ID });

    const archived = await service.archiveWorkspace({ workspaceId: SECOND_ID });
    expect(archived.currentWorkspaceId).toBe(DEFAULT_ID);
    expect(archived.workspaces.map(({ id }) => id)).toEqual([DEFAULT_ID, THIRD_ID]);
    await expect(service.activateWorkspace({ workspaceId: SECOND_ID })).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    await expect(
      service.updateWorkspacePreferences({
        workspaceId: SECOND_ID,
        patch: { theme: 'light' },
      }),
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      expect(
        database.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(SECOND_ID),
      ).toMatchObject({ archived_at: NOW.toISOString() });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM workspace_preferences WHERE workspace_id = ?')
          .get(SECOND_ID),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('refuses to archive the final active workspace without changing state', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID]);
    await service.open();
    const before = await service.getWorkspaceSnapshot();
    await expect(service.archiveWorkspace({ workspaceId: DEFAULT_ID })).rejects.toBeInstanceOf(
      WorkspaceConflictError,
    );
    await expect(service.getWorkspaceSnapshot()).resolves.toEqual(before);
    await service.close();
  });

  it('rolls back the fallback switch when archiving fails midway', async () => {
    const dataDirectory = await createDataDirectory();
    let failArchive = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithFailingArchive(adapter, () => failArchive);
    };
    const ids = [DEFAULT_ID, SECOND_ID];
    const service = new DatabaseService({
      dataDirectory,
      now: () => NOW,
      workspaceIdFactory: () => ids.shift() ?? THIRD_ID,
      adapterFactory,
    });
    await service.open();
    await service.createWorkspace({ name: '将失败的归档', color: WORKSPACE_COLORS[1] });
    failArchive = true;

    await expect(service.archiveWorkspace({ workspaceId: SECOND_ID })).rejects.toThrow();
    const snapshot = await service.getWorkspaceSnapshot();
    expect(snapshot.currentWorkspaceId).toBe(SECOND_ID);
    expect(snapshot.workspaces.map(({ id }) => id)).toEqual([DEFAULT_ID, SECOND_ID]);
    failArchive = false;
    await service.close();
  });

  it.each(['throw', 'remain-active'] as const)(
    'poisons the database when a failed workspace transaction cannot roll back safely: %s',
    async (rollbackFailure) => {
      const dataDirectory = await createDataDirectory();
      let failTransaction = false;
      const adapterFactory: SqliteAdapterFactory = (path, options) => {
        const adapter = createNodeSqliteAdapter(path, options);
        return options?.readOnly
          ? adapter
          : bindAdapterWithUnsafeRollback(adapter, () => failTransaction, rollbackFailure);
      };
      const ids = [DEFAULT_ID, SECOND_ID];
      const service = new DatabaseService({
        dataDirectory,
        now: () => NOW,
        workspaceIdFactory: () => ids.shift() ?? THIRD_ID,
        adapterFactory,
      });
      await service.open();
      await service.createWorkspace({ name: '回滚保护', color: WORKSPACE_COLORS[1] });
      failTransaction = true;

      const failedArchive = service.archiveWorkspace({ workspaceId: SECOND_ID });
      const alreadyQueuedBackup = service.createBackup();
      await expect(failedArchive).rejects.toBeInstanceOf(DatabaseIntegrityError);
      await expect(alreadyQueuedBackup).rejects.toBeInstanceOf(DatabaseStateError);
      await expect(service.getWorkspaceSnapshot()).rejects.toBeInstanceOf(DatabaseStateError);
      await expect(service.createBackup()).rejects.toBeInstanceOf(DatabaseStateError);

      failTransaction = false;
      await service.close().catch(() => undefined);

      const reopened = createService(dataDirectory, []);
      await reopened.open();
      await expect(reopened.getWorkspaceSnapshot()).resolves.toMatchObject({
        currentWorkspaceId: SECOND_ID,
        workspaces: [{ id: DEFAULT_ID }, { id: SECOND_ID }],
      });
      await expect(reopened.listBackups()).resolves.toEqual([]);
      await reopened.close();
    },
  );

  it('archives safely when the system clock moves behind workspace timestamps', async () => {
    const dataDirectory = await createDataDirectory();
    let currentTime = new Date('2030-01-02T03:04:05.000Z');
    const ids = [DEFAULT_ID, SECOND_ID];
    const service = new DatabaseService({
      dataDirectory,
      now: () => currentTime,
      workspaceIdFactory: () => ids.shift() ?? THIRD_ID,
    });
    await service.open();
    currentTime = new Date('2031-02-03T04:05:06.000Z');
    await service.createWorkspace({ name: '未来创建', color: WORKSPACE_COLORS[1] });

    currentTime = new Date('2029-01-01T00:00:00.000Z');
    await expect(service.archiveWorkspace({ workspaceId: SECOND_ID })).resolves.toMatchObject({
      currentWorkspaceId: DEFAULT_ID,
    });
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      expect(
        database
          .prepare('SELECT archived_at, updated_at FROM workspaces WHERE id = ?')
          .get(SECOND_ID),
      ).toEqual({
        archived_at: '2031-02-03T04:05:06.000Z',
        updated_at: '2031-02-03T04:05:06.000Z',
      });
    } finally {
      database.close();
    }
  });

  it('enforces active-workspace state triggers for direct inserts and updates', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID, SECOND_ID]);
    await service.open();
    await service.createWorkspace({ name: '将归档', color: WORKSPACE_COLORS[1] });
    await service.activateWorkspace({ workspaceId: DEFAULT_ID });
    await service.archiveWorkspace({ workspaceId: SECOND_ID });
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      expect(() =>
        database
          .prepare(
            'UPDATE workspace_app_state SET current_workspace_id = ?, updated_at = ? WHERE singleton = 1',
          )
          .run(SECOND_ID, NOW.toISOString()),
      ).toThrow(/current workspace must be active/u);

      database.exec('DELETE FROM workspace_app_state');
      expect(() =>
        database
          .prepare(
            'INSERT INTO workspace_app_state (singleton, current_workspace_id, updated_at) VALUES (1, ?, ?)',
          )
          .run(SECOND_ID, NOW.toISOString()),
      ).toThrow(/current workspace must be active/u);
    } finally {
      database.close();
    }
  });

  it('prevents a direct SQL archive of the current workspace', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID, SECOND_ID]);
    await service.open();
    await service.createWorkspace({ name: '当前空间', color: WORKSPACE_COLORS[1] });
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      expect(() =>
        database
          .prepare('UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?')
          .run(NOW.toISOString(), NOW.toISOString(), SECOND_ID),
      ).toThrow(/current workspace must be switched before archive/u);
    } finally {
      database.close();
    }
  });

  it('prevents a direct SQL archive of the last active workspace', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID]);
    await service.open();
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      database.exec('DELETE FROM workspace_app_state');
      expect(() =>
        database
          .prepare('UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?')
          .run(NOW.toISOString(), NOW.toISOString(), DEFAULT_ID),
      ).toThrow(/at least one active workspace is required/u);
    } finally {
      database.close();
    }
  });

  it('keeps every shared workspace palette color writable under the schema contract', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID]);
    await service.open();
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      const insert = database.prepare(
        `INSERT INTO workspaces (
           id, name, name_key, color, created_at, updated_at, archived_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      );
      for (const [index, color] of WORKSPACE_COLORS.entries()) {
        const suffix = String(index + 1).padStart(12, '0');
        const name = `schema-color-${index + 1}`;
        expect(() =>
          insert.run(
            `00000000-0000-4000-8000-${suffix}`,
            name,
            name,
            color,
            NOW.toISOString(),
            NOW.toISOString(),
          ),
        ).not.toThrow();
      }
    } finally {
      database.close();
    }
  });

  it('merges queued preference patches without losing unrelated fields', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID]);
    await service.open();
    await Promise.all([
      service.updateWorkspacePreferences({
        workspaceId: DEFAULT_ID,
        patch: { activeView: 'inbox', browserWidth: 604 },
      }),
      service.updateWorkspacePreferences({
        workspaceId: DEFAULT_ID,
        patch: { theme: 'light', terminalOpen: false },
      }),
    ]);
    await expect(service.getWorkspaceSnapshot()).resolves.toMatchObject({
      preferences: {
        activeView: 'inbox',
        theme: 'light',
        browserWidth: 604,
        terminalOpen: false,
      },
    });
    await service.close();
  });

  it('persists accepted queued writes before close and rejects operations after close begins', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID]);
    await service.open();
    const write = service.updateWorkspacePreferences({
      workspaceId: DEFAULT_ID,
      patch: { terminalHeight: 540 },
    });
    const close = service.close();
    await write;
    await close;
    await expect(service.getWorkspaceSnapshot()).rejects.toBeInstanceOf(DatabaseStateError);

    const reopened = createService(dataDirectory, []);
    await reopened.open();
    expect((await reopened.getWorkspaceSnapshot()).preferences.terminalHeight).toBe(540);
    await reopened.close();
  });

  it('rejects malformed service inputs before changing persisted state', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID, SECOND_ID]);
    await service.open();
    const before = await service.getWorkspaceSnapshot();
    expect(() => service.createWorkspace({ name: '\n', color: WORKSPACE_COLORS[0] })).toThrow();
    expect(() =>
      service.createWorkspace({ name: '非法颜色', color: '#ffffff' as never }),
    ).toThrow();
    expect(() =>
      service.updateWorkspacePreferences({
        workspaceId: DEFAULT_ID,
        patch: { browserWidth: 10 } as never,
      }),
    ).toThrow();
    await expect(service.getWorkspaceSnapshot()).resolves.toEqual(before);
    await service.close();
  });

  it('fails closed when current workspace integrity or preference coverage is corrupted', async () => {
    const currentCorruptDirectory = await createDataDirectory();
    const currentService = createService(currentCorruptDirectory, [DEFAULT_ID, SECOND_ID]);
    await currentService.open();
    await currentService.createWorkspace({ name: '备用', color: WORKSPACE_COLORS[1] });
    await currentService.close();

    let database = openDatabase(currentCorruptDirectory);
    database.exec('DROP TRIGGER workspace_prevent_current_archive');
    database
      .prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?')
      .run(NOW.toISOString(), SECOND_ID);
    database.close();
    await expect(createService(currentCorruptDirectory, []).open()).rejects.toBeInstanceOf(
      DatabaseIntegrityError,
    );

    const missingPreferencesDirectory = await createDataDirectory();
    const preferenceService = createService(missingPreferencesDirectory, [DEFAULT_ID]);
    await preferenceService.open();
    await preferenceService.close();
    database = openDatabase(missingPreferencesDirectory);
    const lastOpenedBeforeFailure = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'")
      .get()?.value;
    database.prepare('DELETE FROM workspace_preferences WHERE workspace_id = ?').run(DEFAULT_ID);
    database.close();
    const failedService = new DatabaseService({
      dataDirectory: missingPreferencesDirectory,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });
    await expect(failedService.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    database = openDatabase(missingPreferencesDirectory);
    expect(
      database.prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'").get()?.value,
    ).toBe(lastOpenedBeforeFailure);
    database.close();
  });

  it('upgrades an actual v1 database with a pre-migration snapshot', async () => {
    const dataDirectory = await createDataDirectory();
    await mkdir(dataDirectory, { recursive: true });
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const database = createNodeSqliteAdapter(databasePath);
    database.open();
    configureDesktopPragmas(database);
    new MigrationRunner([DEFAULT_MIGRATIONS[0]]).apply(database);
    new MetadataRepository(database).initialize(
      NOW.toISOString(),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    database.close();

    const service = createService(dataDirectory, [DEFAULT_ID]);
    const result = await service.open();
    expect(result.migration).toMatchObject({ fromVersion: 1, toVersion: 10 });
    expect(result.preMigrationBackup).toMatchObject({ reason: 'pre-migration', schemaVersion: 1 });
    const backup = result.preMigrationBackup;
    expect(backup).toBeDefined();
    await service.close();

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup!.fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(
        snapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'workspaces'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      snapshot.close();
    }
  });

  it('includes workspace identity, selection, and preferences in manual backups', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, [DEFAULT_ID, SECOND_ID]);
    await service.open();
    await service.createWorkspace({ name: '备份空间', color: WORKSPACE_COLORS[4] });
    await service.updateWorkspacePreferences({
      workspaceId: SECOND_ID,
      patch: { activeView: 'tasks', browserOpen: false },
    });
    const backup = await service.createBackup();
    await service.close();

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 2,
      });
      expect(
        snapshot.prepare('SELECT current_workspace_id FROM workspace_app_state').get(),
      ).toEqual({ current_workspace_id: SECOND_ID });
      expect(
        snapshot
          .prepare(
            'SELECT active_view, browser_open FROM workspace_preferences WHERE workspace_id = ?',
          )
          .get(SECOND_ID),
      ).toEqual({ active_view: 'tasks', browser_open: 0 });
    } finally {
      snapshot.close();
    }
  });
});

function createService(dataDirectory: string, workspaceIds: string[]): DatabaseService {
  return new DatabaseService({
    dataDirectory,
    now: () => NOW,
    workspaceIdFactory: () => workspaceIds.shift() ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  });
}

async function createDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-workspaces-'));
  temporaryDirectories.push(root);
  return join(root, 'data');
}

function openDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'));
}

function bindAdapterWithFailingArchive(
  adapter: SqliteAdapter,
  shouldFail: () => boolean,
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, parameters: readonly SQLInputValue[] = []) => {
          if (shouldFail() && sql.includes('SET archived_at = ?')) {
            throw new Error('injected archive failure');
          }
          return target.run(sql, parameters);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function bindAdapterWithUnsafeRollback(
  adapter: SqliteAdapter,
  shouldFail: () => boolean,
  failure: 'throw' | 'remain-active',
): SqliteAdapter {
  let reportActiveTransaction = false;
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'isTransaction' && reportActiveTransaction) {
        return true;
      }
      if (property === 'run') {
        return (sql: string, parameters: readonly SQLInputValue[] = []) => {
          if (shouldFail() && sql.includes('SET archived_at = ?')) {
            throw new Error('injected archive failure');
          }
          return target.run(sql, parameters);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          if (shouldFail() && sql === 'ROLLBACK') {
            if (failure === 'throw') {
              throw new Error('injected rollback failure');
            }
            target.exec(sql);
            reportActiveTransaction = true;
            return;
          }
          target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
