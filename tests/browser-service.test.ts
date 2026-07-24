import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BrowserConflictError,
  BrowserNotFoundError,
  BrowserOperationError,
  BrowserValidationError,
} from '../src/main/browser';
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
import { WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TAB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOOKMARK_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-07-22T12:34:56.000Z');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('browser persistence service', () => {
  it('initializes, persists, bookmarks, closes, and reopens workspace browser data', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      tabIds: [TAB_A, TAB_B],
      bookmarkIds: [BOOKMARK_A],
    });
    const opened = await service.open();
    expect(opened.migration).toMatchObject({ fromVersion: 0, toVersion: 10 });

    let data = await service.getBrowserData({ workspaceId: WORKSPACE_A });
    expect(data).toEqual({
      workspaceId: WORKSPACE_A,
      revision: 1,
      activeTabId: TAB_A,
      tabs: [
        {
          id: TAB_A,
          url: 'https://www.google.com/',
          title: 'New tab',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
      bookmarks: [],
    });

    data = await service.persistBrowserTabMetadata({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: 'example.com/docs',
      title: '  API\nreference\u0000 ',
    });
    expect(data).toMatchObject({
      revision: 2,
      tabs: [{ id: TAB_A, url: 'https://example.com/docs', title: 'API reference' }],
    });

    data = await service.toggleBrowserBookmark({ workspaceId: WORKSPACE_A, tabId: TAB_A });
    expect(data).toMatchObject({
      revision: 3,
      bookmarks: [
        {
          id: BOOKMARK_A,
          url: 'https://example.com/docs',
          title: 'API reference',
        },
      ],
    });

    data = await service.createBrowserTab({ workspaceId: WORKSPACE_A, url: 'about:blank' });
    expect(data.activeTabId).toBe(TAB_B);
    expect(data.revision).toBe(4);
    await expect(
      service.toggleBrowserBookmark({ workspaceId: WORKSPACE_A, tabId: TAB_B }),
    ).rejects.toBeInstanceOf(BrowserValidationError);

    data = await service.closeBrowserTab({ workspaceId: WORKSPACE_A, tabId: TAB_B });
    expect(data).toMatchObject({ revision: 5, activeTabId: TAB_A });
    expect(data.tabs.map(({ id }) => id)).toEqual([TAB_A]);
    data = await service.closeBrowserTab({ workspaceId: WORKSPACE_A, tabId: TAB_A });
    expect(data).toMatchObject({
      revision: 6,
      activeTabId: TAB_A,
      tabs: [{ id: TAB_A, url: 'https://www.google.com/', title: 'New tab' }],
    });

    await service.close();
    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getBrowserData({ workspaceId: WORKSPACE_A })).resolves.toEqual(data);
    await reopened.close();
  });

  it('isolates workspaces, enforces the tab cap, and rejects archived workspaces', async () => {
    const dataDirectory = await createDataDirectory();
    const tabIds = Array.from(
      { length: 14 },
      (_, index) => `${(index + 10).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    );
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A, WORKSPACE_B],
      tabIds,
    });
    await service.open();
    const dataA = await service.getBrowserData({ workspaceId: WORKSPACE_A });
    await service.createWorkspace({ name: '空间 B', color: WORKSPACE_COLORS[1] });
    await service.getBrowserData({ workspaceId: WORKSPACE_B });
    for (let index = 0; index < 11; index += 1) {
      await service.createBrowserTab({
        workspaceId: WORKSPACE_B,
        url: `https://example.com/${index}`,
      });
    }
    await expect(
      service.createBrowserTab({ workspaceId: WORKSPACE_B, url: 'https://example.com/overflow' }),
    ).rejects.toBeInstanceOf(BrowserConflictError);
    await expect(service.getBrowserData({ workspaceId: WORKSPACE_A })).resolves.toEqual(dataA);

    await service.archiveWorkspace({ workspaceId: WORKSPACE_B });
    await expect(service.getBrowserData({ workspaceId: WORKSPACE_B })).rejects.toBeInstanceOf(
      BrowserNotFoundError,
    );
    const database = openDatabase(dataDirectory);
    expect(() =>
      database
        .prepare('UPDATE browser_tabs SET title = ? WHERE workspace_id = ?')
        .run('绕过服务', WORKSPACE_B),
    ).toThrow(/archived workspace browser tabs are immutable/u);
    database.close();
    await service.close();
  });

  it('rejects corrupt browser rows at backup and startup without publishing partial state', async () => {
    const backupDirectory = await createDataDirectory();
    const backupService = createService(backupDirectory, {
      workspaceIds: [WORKSPACE_A],
      tabIds: [TAB_A],
    });
    await backupService.open();
    await backupService.getBrowserData({ workspaceId: WORKSPACE_A });

    let database = openDatabase(backupDirectory);
    database.prepare('UPDATE browser_tabs SET title = ? WHERE id = ?').run('safe\u202eevil', TAB_A);
    database.close();
    await expect(backupService.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
    await expect(backupService.listBackups()).resolves.toEqual([]);
    expect(
      (await readdir(join(backupDirectory, 'backups'))).some((name) => name.endsWith('.partial')),
    ).toBe(false);
    await backupService.close();

    const startupDirectory = await createDataDirectory();
    const initial = createService(startupDirectory, {
      workspaceIds: [WORKSPACE_A],
      tabIds: [TAB_A],
    });
    await initial.open();
    await initial.getBrowserData({ workspaceId: WORKSPACE_A });
    await initial.close();
    database = openDatabase(startupDirectory);
    const lastOpenedBefore = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'")
      .get()?.value;
    database.prepare('UPDATE browser_tabs SET title = ? WHERE id = ?').run('safe\u202eevil', TAB_A);
    database.close();

    const corrupt = createService(startupDirectory, {
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    await expect(corrupt.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    database = openDatabase(startupDirectory);
    expect(
      database.prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'").get()?.value,
    ).toBe(lastOpenedBefore);
    database.close();

    const crossRowDirectory = await createDataDirectory();
    const valid = createService(crossRowDirectory, {
      workspaceIds: [WORKSPACE_A],
      tabIds: [TAB_A],
    });
    await valid.open();
    await valid.getBrowserData({ workspaceId: WORKSPACE_A });
    await valid.close();
    database = openDatabase(crossRowDirectory);
    database
      .prepare(
        `INSERT INTO browser_tabs (
           id, workspace_id, url, title, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        TAB_B,
        WORKSPACE_A,
        'https://example.com/future',
        'Future tab',
        '2026-07-23T00:00:00.000Z',
        '2026-07-23T00:00:00.000Z',
      );
    database.close();
    const crossRowCorrupt = createService(crossRowDirectory);
    await expect(crossRowCorrupt.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
  });

  it('rolls back a failed tab creation and poisons the queue when rollback is unsafe', async () => {
    const dataDirectory = await createDataDirectory();
    let failInsert = false;
    let failRollback = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithBrowserFailure(
            adapter,
            () => failInsert,
            () => failRollback,
          );
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      tabIds: [TAB_A, TAB_B],
      adapterFactory,
    });
    await service.open();
    await service.getBrowserData({ workspaceId: WORKSPACE_A });

    failInsert = true;
    await expect(service.createBrowserTab({ workspaceId: WORKSPACE_A })).rejects.toThrow();
    failInsert = false;
    await expect(service.getBrowserData({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      revision: 1,
      tabs: [{ id: TAB_A }],
    });

    failInsert = true;
    failRollback = true;
    const failed = service.createBrowserTab({ workspaceId: WORKSPACE_A });
    const queued = service.getBrowserData({ workspaceId: WORKSPACE_A });
    await expect(failed).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(queued).rejects.toBeInstanceOf(DatabaseStateError);
    failInsert = false;
    failRollback = false;
    await service.close().catch(() => undefined);
  });

  it('rolls back a tab creation when COMMIT fails before SQLite commits', async () => {
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
      tabIds: [TAB_A, TAB_B],
      adapterFactory,
    });
    await service.open();
    await service.getBrowserData({ workspaceId: WORKSPACE_A });

    failCommit = true;
    await expect(service.createBrowserTab({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      BrowserOperationError,
    );
    failCommit = false;
    await expect(service.getBrowserData({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      revision: 1,
      activeTabId: TAB_A,
      tabs: [{ id: TAB_A }],
    });
    await service.close();
  });

  it('poisons the queue when browser COMMIT succeeds before the adapter throws', async () => {
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
      tabIds: [TAB_A, TAB_B],
      adapterFactory,
    });
    await service.open();
    await service.getBrowserData({ workspaceId: WORKSPACE_A });

    failCommit = true;
    const failed = service.createBrowserTab({ workspaceId: WORKSPACE_A });
    const queued = service.getBrowserData({ workspaceId: WORKSPACE_A });
    await expect(failed).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(queued).rejects.toBeInstanceOf(DatabaseStateError);
    await expect(service.createBackup()).rejects.toBeInstanceOf(DatabaseStateError);
    failCommit = false;
    await service.close().catch(() => undefined);

    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getBrowserData({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
    });
    await reopened.close();
  });
});

interface ServiceOptions {
  workspaceIds?: string[];
  tabIds?: string[];
  bookmarkIds?: string[];
  now?: () => Date;
  adapterFactory?: SqliteAdapterFactory;
}

function createService(dataDirectory: string, options: ServiceOptions = {}): DatabaseService {
  const workspaceIds = [...(options.workspaceIds ?? [])];
  const tabIds = [...(options.tabIds ?? [])];
  const bookmarkIds = [...(options.bookmarkIds ?? [])];
  return new DatabaseService({
    dataDirectory,
    now: options.now ?? (() => new Date(NOW)),
    workspaceIdFactory: () => workspaceIds.shift() ?? WORKSPACE_A,
    browserTabIdFactory: () => tabIds.shift() ?? TAB_A,
    browserBookmarkIdFactory: () => bookmarkIds.shift() ?? BOOKMARK_A,
    taskTodayFactory: () => '2026-07-22',
    scheduleTodayFactory: () => '2026-07-22',
    adapterFactory: options.adapterFactory,
  });
}

async function createDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-browser-'));
  temporaryDirectories.push(root);
  return join(root, 'data');
}

function openDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'));
}

function bindAdapterWithBrowserFailure(
  adapter: SqliteAdapter,
  shouldFailInsert: () => boolean,
  shouldFailRollback: () => boolean,
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, parameters: readonly unknown[] = []) => {
          if (shouldFailInsert() && /^\s*INSERT INTO browser_tabs\b/u.test(sql)) {
            throw new Error('Injected browser tab insert failure.');
          }
          return target.run(sql, parameters as never[]);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          if (shouldFailRollback() && sql === 'ROLLBACK') {
            throw new Error('Injected browser rollback failure.');
          }
          return target.exec(sql);
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
          if (mode === 'before') throw new Error('Injected browser pre-commit failure.');
          target.exec(sql);
          if (mode === 'after') throw new Error('Injected browser post-commit failure.');
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
