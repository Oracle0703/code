import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InboxNotFoundError,
  InboxUndoUnavailableError,
  InboxValidationError,
} from '../src/main/inbox/inbox-errors';
import { INBOX_UNDO_WINDOW_MS } from '../src/shared/inbox-domain';
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
import { WorkspaceService } from '../src/main/workspaces';
import { WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const ENTRY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOKEN_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TOKEN_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
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

describe('inbox service', () => {
  it('captures exact Unicode content, categorizes it, and reopens idempotently', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
    });
    const initialized = await service.open();
    expect(initialized.migration).toMatchObject({ fromVersion: 0, toVersion: 11 });
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toEqual({
      workspaceId: WORKSPACE_A,
      entries: [],
    });

    const original = '  ＡPI / e\u0301 / 👩‍💻 / https://example.com/?q=Ａ  ';
    let snapshot = await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: original,
      category: 'uncategorized',
    });
    expect(snapshot.entries).toMatchObject([
      {
        id: ENTRY_A,
        content: original.trim(),
        category: 'uncategorized',
      },
    ]);
    expect(snapshot.entries[0]?.content).not.toBe(original.trim().normalize('NFKC'));

    snapshot = await service.categorizeInboxEntry({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_A,
      category: 'task',
    });
    expect(snapshot.entries[0]?.category).toBe('task');
    await service.close();

    const reopened = createService(dataDirectory);
    const result = await reopened.open();
    expect(result.migration).toEqual({ fromVersion: 11, toVersion: 11, applied: [] });
    await expect(reopened.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A, content: original.trim(), category: 'task' }],
    });
    await reopened.close();
  });

  it('isolates entries by workspace and rejects cross-workspace targets', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A, WORKSPACE_B],
      inboxIds: [ENTRY_A, ENTRY_B],
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: 'A 工作区记录',
      category: 'note',
    });
    await service.createWorkspace({ name: '第二空间', color: WORKSPACE_COLORS[1] });
    await service.createInboxEntry({
      workspaceId: WORKSPACE_B,
      content: 'B 工作区记录',
      category: 'link',
    });

    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A }],
    });
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_B })).resolves.toMatchObject({
      entries: [{ id: ENTRY_B }],
    });
    await expect(
      service.categorizeInboxEntry({
        workspaceId: WORKSPACE_B,
        entryId: ENTRY_A,
        category: 'task',
      }),
    ).rejects.toBeInstanceOf(InboxNotFoundError);
    await service.close();
  });

  it('archives with an opaque one-time token and rejects wrong, repeated, or expired undo', async () => {
    const dataDirectory = await createDataDirectory();
    let now = new Date(NOW);
    let monotonicNowMs = 1_000;
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A, WORKSPACE_B],
      inboxIds: [ENTRY_A],
      undoTokens: [TOKEN_A, TOKEN_B],
      now: () => now,
      monotonicNowMs: () => monotonicNowMs,
    });
    await service.open();
    await service.createWorkspace({ name: '第二空间', color: WORKSPACE_COLORS[1] });
    await service.createInboxEntry({
      workspaceId: WORKSPACE_B,
      content: '需要撤销的记录',
      category: 'uncategorized',
    });

    const archived = await service.archiveInboxEntry({
      workspaceId: WORKSPACE_B,
      entryId: ENTRY_A,
    });
    expect(archived.snapshot.entries).toEqual([]);
    expect(archived.undoToken).toBe(TOKEN_A);
    expect(Date.parse(archived.undoExpiresAt) - now.getTime()).toBe(INBOX_UNDO_WINDOW_MS);
    await expect(
      service.undoInboxArchive({ workspaceId: WORKSPACE_A, undoToken: TOKEN_A }),
    ).rejects.toBeInstanceOf(InboxUndoUnavailableError);

    await expect(
      service.undoInboxArchive({ workspaceId: WORKSPACE_B, undoToken: TOKEN_A }),
    ).resolves.toMatchObject({ entries: [{ id: ENTRY_A }] });
    await expect(
      service.undoInboxArchive({ workspaceId: WORKSPACE_B, undoToken: TOKEN_A }),
    ).rejects.toBeInstanceOf(InboxUndoUnavailableError);

    const archivedAgain = await service.archiveInboxEntry({
      workspaceId: WORKSPACE_B,
      entryId: ENTRY_A,
    });
    expect(archivedAgain.undoToken).toBe(TOKEN_B);
    now = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    monotonicNowMs += INBOX_UNDO_WINDOW_MS;
    await expect(
      service.undoInboxArchive({ workspaceId: WORKSPACE_B, undoToken: TOKEN_B }),
    ).rejects.toBeInstanceOf(InboxUndoUnavailableError);
    await service.close();
  });

  it('rejects malformed content, categories, ids, and generated values before mutation', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
    });
    await service.open();
    for (const content of ['', '   ', 'line one\nline two', '\u0000', '\ud800']) {
      expect(() =>
        service.createInboxEntry({
          workspaceId: WORKSPACE_A,
          content,
          category: 'uncategorized',
        }),
      ).toThrow(InboxValidationError);
    }
    expect(() =>
      service.createInboxEntry({
        workspaceId: WORKSPACE_A,
        content: 'x'.repeat(501),
        category: 'uncategorized',
      }),
    ).toThrow(InboxValidationError);
    expect(() =>
      service.createInboxEntry({
        workspaceId: WORKSPACE_A,
        content: '合法内容',
        category: 'idea' as never,
      }),
    ).toThrow(InboxValidationError);
    expect(() =>
      service.categorizeInboxEntry({
        workspaceId: WORKSPACE_A,
        entryId: ENTRY_A.toUpperCase(),
        category: 'note',
      }),
    ).toThrow(InboxValidationError);
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [],
    });
    await service.close();

    const invalidFactory = createService(await createDataDirectory(), {
      workspaceIds: [WORKSPACE_A],
      inboxIds: ['not-a-uuid'],
    });
    await invalidFactory.open();
    expect(() =>
      invalidFactory.createInboxEntry({
        workspaceId: WORKSPACE_A,
        content: '不会落库',
        category: 'note',
      }),
    ).toThrow(InboxValidationError);
    await invalidFactory.close();
  });

  it('preserves entries but makes them unavailable after their workspace is archived', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A, WORKSPACE_B],
      inboxIds: [ENTRY_A],
    });
    await service.open();
    await service.createWorkspace({ name: '即将归档', color: WORKSPACE_COLORS[2] });
    await service.createInboxEntry({
      workspaceId: WORKSPACE_B,
      content: '归档空间中的数据仍保留',
      category: 'note',
    });
    await service.archiveWorkspace({ workspaceId: WORKSPACE_B });

    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_B })).rejects.toBeInstanceOf(
      InboxNotFoundError,
    );
    await expect(
      service.categorizeInboxEntry({
        workspaceId: WORKSPACE_B,
        entryId: ENTRY_A,
        category: 'task',
      }),
    ).rejects.toBeInstanceOf(InboxNotFoundError);
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      expect(
        database
          .prepare('SELECT content, archived_at FROM inbox_entries WHERE id = ?')
          .get(ENTRY_A),
      ).toEqual({ content: '归档空间中的数据仍保留', archived_at: null });
      expect(() =>
        database.prepare('UPDATE inbox_entries SET category = ? WHERE id = ?').run('task', ENTRY_A),
      ).toThrow(/archived workspace inbox is immutable/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO inbox_entries (
               id, workspace_id, content, category, created_at, updated_at, archived_at
             ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            ENTRY_C,
            WORKSPACE_B,
            '不能绕过服务写入',
            'uncategorized',
            NOW.toISOString(),
            NOW.toISOString(),
          ),
      ).toThrow(/inbox entry requires an active workspace/u);
    } finally {
      database.close();
    }
  });

  it('keeps timestamps ordered when the system clock moves backwards', async () => {
    const dataDirectory = await createDataDirectory();
    let now = new Date('2031-02-03T04:05:06.000Z');
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      undoTokens: [TOKEN_A],
      now: () => now,
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '未来时间记录',
      category: 'uncategorized',
    });
    now = new Date('2029-01-01T00:00:00.000Z');
    await service.categorizeInboxEntry({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_A,
      category: 'task',
    });
    const archived = await service.archiveInboxEntry({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_A,
    });
    await service.undoInboxArchive({
      workspaceId: WORKSPACE_A,
      undoToken: archived.undoToken,
    });
    await service.close();

    const database = openDatabase(dataDirectory);
    try {
      const row = database
        .prepare('SELECT created_at, updated_at, archived_at FROM inbox_entries WHERE id = ?')
        .get(ENTRY_A) as Record<string, unknown>;
      expect(row.created_at).toBe('2031-02-03T04:05:06.000Z');
      expect(row.updated_at).toBe('2031-02-03T04:05:06.000Z');
      expect(row.archived_at).toBeNull();
    } finally {
      database.close();
    }
  });

  it('persists accepted queued captures before close and rejects later operations', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
    });
    await service.open();
    const capture = service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '关闭前已接受',
      category: 'uncategorized',
    });
    const close = service.close();
    await capture;
    await close;
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      DatabaseStateError,
    );

    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A, content: '关闭前已接受' }],
    });
    await reopened.close();
  });

  it('backs up active and archived entries without implicitly converting task categories', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A, ENTRY_B],
      undoTokens: [TOKEN_A],
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '任务候选',
      category: 'task',
    });
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '保留在列表',
      category: 'note',
    });
    await service.archiveInboxEntry({ workspaceId: WORKSPACE_A, entryId: ENTRY_A });
    const backup = await service.createBackup();
    expect(backup.schemaVersion).toBe(11);
    await service.close();

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM inbox_entries').get()).toEqual({
        count: 2,
      });
      expect(
        snapshot
          .prepare(
            'SELECT category, archived_at IS NOT NULL AS archived FROM inbox_entries WHERE id = ?',
          )
          .get(ENTRY_A),
      ).toEqual({ category: 'task', archived: 1 });
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
    } finally {
      snapshot.close();
    }
  });

  it('rejects a business-corrupt backup and removes its unpublished partial file', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '备份前损坏',
      category: 'note',
    });

    const database = openDatabase(dataDirectory);
    database
      .prepare('UPDATE inbox_entries SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('not-an-iso-date', 'not-an-iso-date', ENTRY_A);
    database.close();

    await expect(service.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
    await expect(service.listBackups()).resolves.toEqual([]);
    const backupFiles = await readdir(join(dataDirectory, 'backups'));
    expect(backupFiles.some((fileName) => fileName.endsWith('.partial'))).toBe(false);
    await service.close();
  });

  it('upgrades a real v2 database only after publishing a validated v2 backup', async () => {
    const dataDirectory = await createDataDirectory();
    await createVersionTwoDatabase(dataDirectory);

    const service = createService(dataDirectory, { inboxIds: [ENTRY_A] });
    const result = await service.open();
    expect(result.migration).toMatchObject({ fromVersion: 2, toVersion: 11 });
    expect(result.preMigrationBackup).toMatchObject({
      reason: 'pre-migration',
      schemaVersion: 2,
    });
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [],
    });
    const backup = result.preMigrationBackup!;
    await service.close();

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
      expect(
        snapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'inbox_entries'")
          .get(),
      ).toEqual({ count: 0 });
      expect(snapshot.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 1,
      });
    } finally {
      snapshot.close();
    }
  });

  it('rejects business-corrupt inbox rows without committing last-opened metadata', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '即将损坏',
      category: 'note',
    });
    await service.close();

    let database = openDatabase(dataDirectory);
    const before = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'")
      .get()?.value;
    database
      .prepare('UPDATE inbox_entries SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('not-an-iso-date', 'not-an-iso-date', ENTRY_A);
    database.close();

    const corrupted = createService(dataDirectory, { now: () => new Date('2030-01-01T00:00:00Z') });
    await expect(corrupted.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    database = openDatabase(dataDirectory);
    expect(
      database.prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'").get()?.value,
    ).toBe(before);
    database.close();
  });

  it('rolls back ordinary failures and poisons the shared queue when rollback is unsafe', async () => {
    const dataDirectory = await createDataDirectory();
    let failArchive = false;
    let failRollback = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithArchiveFailure(
            adapter,
            () => failArchive,
            () => failRollback,
          );
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      undoTokens: [TOKEN_A],
      adapterFactory,
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '事务保护',
      category: 'note',
    });

    failArchive = true;
    await expect(
      service.archiveInboxEntry({ workspaceId: WORKSPACE_A, entryId: ENTRY_A }),
    ).rejects.toThrow();
    failArchive = false;
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A }],
    });

    failArchive = true;
    failRollback = true;
    const failed = service.archiveInboxEntry({ workspaceId: WORKSPACE_A, entryId: ENTRY_A });
    const queuedBackup = service.createBackup();
    await expect(failed).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(queuedBackup).rejects.toBeInstanceOf(DatabaseStateError);
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).rejects.toBeInstanceOf(
      DatabaseStateError,
    );
    failArchive = false;
    failRollback = false;
    await service.close().catch(() => undefined);

    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A }],
    });
    await reopened.close();
  });
});

interface ServiceOptions {
  workspaceIds?: string[];
  inboxIds?: string[];
  undoTokens?: string[];
  now?: () => Date;
  monotonicNowMs?: () => number;
  adapterFactory?: SqliteAdapterFactory;
}

function createService(dataDirectory: string, options: ServiceOptions = {}): DatabaseService {
  const workspaceIds = [...(options.workspaceIds ?? [])];
  const inboxIds = [...(options.inboxIds ?? [])];
  const undoTokens = [...(options.undoTokens ?? [])];
  return new DatabaseService({
    dataDirectory,
    now: options.now ?? (() => new Date(NOW)),
    workspaceIdFactory: () => workspaceIds.shift() ?? 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    inboxIdFactory: () => inboxIds.shift() ?? '99999999-9999-4999-8999-999999999999',
    inboxUndoTokenFactory: () => undoTokens.shift() ?? '88888888-8888-4888-8888-888888888888',
    inboxMonotonicNowMs: options.monotonicNowMs,
    adapterFactory: options.adapterFactory,
  });
}

async function createDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-inbox-'));
  temporaryDirectories.push(root);
  return join(root, 'data');
}

function openDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'));
}

async function createVersionTwoDatabase(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 2)).apply(database);
  new MetadataRepository(database).initialize(
    NOW.toISOString(),
    '77777777-7777-4777-8777-777777777777',
  );
  const workspaceService = new WorkspaceService({
    execute: async (operation) => operation(database),
    now: () => new Date(NOW),
    idFactory: () => WORKSPACE_A,
  });
  workspaceService.initialize(database, NOW.toISOString(), false);
  database.close();
}

function bindAdapterWithArchiveFailure(
  adapter: SqliteAdapter,
  shouldFailArchive: () => boolean,
  shouldFailRollback: () => boolean,
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, parameters: readonly SQLInputValue[] = []) => {
          if (shouldFailArchive() && sql.includes('SET archived_at = ?, updated_at = ?')) {
            throw new Error('injected inbox archive failure');
          }
          return target.run(sql, parameters);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          if (shouldFailRollback() && sql === 'ROLLBACK') {
            throw new Error('injected inbox rollback failure');
          }
          target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
