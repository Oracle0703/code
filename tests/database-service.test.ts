import { rmSync, truncateSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/main/database/database-service';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import {
  DatabaseBackupError,
  DatabaseIntegrityError,
  DatabaseMigrationError,
  DatabaseOpenError,
  DatabasePathError,
  DatabaseStateError,
} from '../src/main/database/errors';
import {
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from '../src/main/database/sqlite-adapter';

const temporaryDirectories: string[] = [];
const INITIALIZATION_INTENT = 'daily-workbench-database-initializing-v1\n';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

describe('DatabaseService', () => {
  it('creates, migrates, reports, closes, and reopens a database idempotently', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({ dataDirectory });

    const initialized = await service.open();
    expect(initialized.migration).toMatchObject({ fromVersion: 0, toVersion: 7 });
    expect(initialized.preMigrationBackup).toBeUndefined();
    await expect(service.getStatus()).resolves.toMatchObject({
      schemaVersion: 7,
      appliedMigrations: 7,
      journalMode: 'wal',
      integrityCheck: 'ok',
      backupCount: 0,
    });
    const status = await service.getStatus();
    expect(status).not.toHaveProperty('databasePath');
    expect(status).not.toHaveProperty('databaseId');
    await service.close();
    await expect(service.getStatus()).rejects.toBeInstanceOf(DatabaseStateError);

    const reopened = new DatabaseService({ dataDirectory });
    const secondInitialization = await reopened.open();
    expect(secondInitialization.migration).toEqual({
      fromVersion: 7,
      toVersion: 7,
      applied: [],
    });
    await reopened.close();
  });

  it('creates an opaque, validated manual snapshot in the controlled backup directory', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({ dataDirectory });
    await service.open();

    const backup = await service.createBackup();
    expect(backup).toMatchObject({ reason: 'manual', schemaVersion: 7 });
    expect(backup.fileName).toMatch(/^daily-workbench-v7-manual-.+\.sqlite3$/u);
    expect(backup).not.toHaveProperty('path');
    expect(await service.listBackups()).toEqual([backup]);
    expect((await service.getStatus()).backupCount).toBe(1);

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      expect(snapshot.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(
        snapshot.prepare("SELECT value FROM app_metadata WHERE key = 'database_id'").get(),
      ).toHaveProperty('value');
    } finally {
      snapshot.close();
    }
    await service.close();
  });

  it('validates an exact backup reference while open or closed and rejects unsafe references', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({ dataDirectory });
    await service.open();
    const backup = await service.createPreImportBackup();

    await expect(
      service.validateExistingBackup(backup.id.toUpperCase(), 'pre-import'),
    ).resolves.toEqual(backup);
    await expect(service.validateExistingBackup(backup.id, 'manual')).rejects.toBeInstanceOf(
      DatabaseBackupError,
    );

    await service.close();
    await expect(service.validateExistingBackup(backup.id, 'pre-import')).resolves.toEqual(backup);

    const backupPath = join(dataDirectory, 'backups', backup.fileName);
    await writeFile(backupPath, 'not a sqlite database');
    await expect(service.validateExistingBackup(backup.id, 'pre-import')).rejects.toBeInstanceOf(
      DatabaseBackupError,
    );
    await rm(backupPath);
    await expect(service.validateExistingBackup(backup.id, 'pre-import')).rejects.toBeInstanceOf(
      DatabaseBackupError,
    );
  });

  it('does not replace a missing database with an empty one while backups remain', async () => {
    const dataDirectory = await createDataDirectory();
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    const workspaceId = (await original.getWorkspaceSnapshot()).currentWorkspaceId;
    await original.createInboxEntry({
      workspaceId,
      content: 'must remain recoverable from backup',
      category: 'note',
    });
    const manual = await original.createBackup();
    const scheduled = await original.createScheduledBackup();
    await original.close();
    const manualPath = join(dataDirectory, 'backups', manual.fileName);
    const scheduledPath = join(dataDirectory, 'backups', scheduled.fileName);
    const [manualBytes, scheduledBytes] = await Promise.all([
      readFile(manualPath),
      readFile(scheduledPath),
    ]);
    await Promise.all([
      rm(databasePath),
      rm(join(dataDirectory, 'database-initialized-v1')),
      writeFile(join(dataDirectory, 'database-initializing-v1'), INITIALIZATION_INTENT),
    ]);

    const reopened = new DatabaseService({ dataDirectory });
    await expect(reopened.open()).rejects.toThrow(/prior application data still exists/u);
    await expect(readFile(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(manualPath)).resolves.toEqual(manualBytes);
    await expect(readFile(scheduledPath)).resolves.toEqual(scheduledBytes);
  });

  it('does not replace a missing initialized database when no backups exist', async () => {
    const dataDirectory = await createDataDirectory();
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    const workspaceId = (await original.getWorkspaceSnapshot()).currentWorkspaceId;
    await original.createInboxEntry({
      workspaceId,
      content: 'sentinel must distinguish this from a fresh install',
      category: 'note',
    });
    expect(await original.listBackups()).toEqual([]);
    await original.close();
    await Promise.all([
      rm(databasePath),
      writeFile(join(dataDirectory, 'database-initializing-v1'), INITIALIZATION_INTENT),
    ]);

    const reopened = new DatabaseService({ dataDirectory });
    await expect(reopened.open()).rejects.toThrow(/prior application data still exists/u);
    await expect(readFile(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses an empty legacy backup directory as initialization evidence before v7 writes a sentinel', async () => {
    const dataDirectory = await createDataDirectory();
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    expect(await original.listBackups()).toEqual([]);
    await original.close();
    await Promise.all([rm(databasePath), rm(join(dataDirectory, 'database-initialized-v1'))]);

    const upgraded = new DatabaseService({ dataDirectory });
    await expect(upgraded.open()).rejects.toThrow(/prior application data still exists/u);
    await expect(readFile(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still initializes inside a pre-created empty data directory without legacy evidence', async () => {
    const dataDirectory = await createDataDirectory();
    await mkdir(dataDirectory, { recursive: true });

    const fresh = new DatabaseService({ dataDirectory });
    await expect(fresh.open()).resolves.toMatchObject({
      migration: { fromVersion: 0, toVersion: 7 },
    });
    await fresh.close();
  });

  it('resumes a fresh initialization after the intent and empty backup directory were published', async () => {
    const dataDirectory = await createDataDirectory();
    await mkdir(join(dataDirectory, 'backups'), { recursive: true });
    await writeFile(join(dataDirectory, 'database-initializing-v1'), INITIALIZATION_INTENT);

    const resumed = new DatabaseService({ dataDirectory });
    await expect(resumed.open()).resolves.toMatchObject({
      migration: { fromVersion: 0, toVersion: 7 },
    });
    await expect(readFile(join(dataDirectory, 'database-initialized-v1'), 'utf8')).resolves.toBe(
      'daily-workbench-database-initialized-v1\n',
    );
    await expect(readFile(join(dataDirectory, 'database-initializing-v1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await resumed.close();
  });

  it('resumes a fresh initialization from its zero-byte SQLite file only when intent exists', async () => {
    const dataDirectory = await createDataDirectory();
    await mkdir(join(dataDirectory, 'backups'), { recursive: true });
    await Promise.all([
      writeFile(join(dataDirectory, 'database-initializing-v1'), INITIALIZATION_INTENT),
      writeFile(join(dataDirectory, 'daily-workbench.sqlite3'), Buffer.alloc(0)),
    ]);

    const resumed = new DatabaseService({ dataDirectory });
    await expect(resumed.open()).resolves.toMatchObject({
      migration: { fromVersion: 0, toVersion: 7 },
    });
    expect(
      (await readFile(join(dataDirectory, 'daily-workbench.sqlite3'))).byteLength,
    ).toBeGreaterThan(0);
    await expect(readFile(join(dataDirectory, 'database-initializing-v1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await resumed.close();
  });

  it('promotes a committed first database when the process stopped before publishing its sentinel', async () => {
    const dataDirectory = await createDataDirectory();
    const first = new DatabaseService({ dataDirectory });
    await first.open();
    const databaseId = readMetadataValue(
      join(dataDirectory, 'daily-workbench.sqlite3'),
      'database_id',
    );
    await first.close();
    await Promise.all([
      rm(join(dataDirectory, 'database-initialized-v1')),
      writeFile(join(dataDirectory, 'database-initializing-v1'), INITIALIZATION_INTENT),
    ]);

    const resumed = new DatabaseService({ dataDirectory });
    await expect(resumed.open()).resolves.toMatchObject({
      migration: { fromVersion: 7, toVersion: 7 },
    });
    expect(readMetadataValue(join(dataDirectory, 'daily-workbench.sqlite3'), 'database_id')).toBe(
      databaseId,
    );
    await expect(readFile(join(dataDirectory, 'database-initialized-v1'), 'utf8')).resolves.toBe(
      'daily-workbench-database-initialized-v1\n',
    );
    await expect(readFile(join(dataDirectory, 'database-initializing-v1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await resumed.close();
  });

  it('finishes a nonempty partial first database without publishing a pre-migration backup', async () => {
    const dataDirectory = await createDataDirectory();
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    await mkdir(join(dataDirectory, 'backups'), { recursive: true });
    await writeFile(join(dataDirectory, 'database-initializing-v1'), INITIALIZATION_INTENT);
    const partial = new DatabaseSync(databasePath);
    partial.exec('CREATE TABLE initialization_probe (id INTEGER PRIMARY KEY) STRICT;');
    partial.close();

    const resumed = new DatabaseService({ dataDirectory });
    const initialized = await resumed.open();
    expect(initialized).toMatchObject({
      migration: { fromVersion: 0, toVersion: 7 },
      preMigrationBackup: undefined,
    });
    await expect(resumed.listBackups()).resolves.toEqual([]);
    await resumed.close();
  });

  it('idempotently clears a valid initialization intent left after the sentinel', async () => {
    const dataDirectory = await createDataDirectory();
    const first = new DatabaseService({ dataDirectory });
    await first.open();
    await first.close();
    await writeFile(join(dataDirectory, 'database-initializing-v1'), INITIALIZATION_INTENT);

    const resumed = new DatabaseService({ dataDirectory });
    await expect(resumed.open()).resolves.toMatchObject({
      migration: { fromVersion: 7, toVersion: 7 },
    });
    await expect(readFile(join(dataDirectory, 'database-initializing-v1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await resumed.close();
  });

  it('does not initialize a truncated database while a backup remains', async () => {
    const dataDirectory = await createDataDirectory();
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    const workspaceId = (await original.getWorkspaceSnapshot()).currentWorkspaceId;
    await original.createInboxEntry({
      workspaceId,
      content: 'must survive a truncated main database',
      category: 'note',
    });
    const backup = await original.createBackup();
    await original.close();
    const backupPath = join(dataDirectory, 'backups', backup.fileName);
    const backupBytes = await readFile(backupPath);
    await truncate(databasePath, 0);

    const reopened = new DatabaseService({ dataDirectory });
    await expect(reopened.open()).rejects.toThrow(/database file is empty/u);
    await expect(readFile(databasePath)).resolves.toHaveLength(0);
    await expect(readFile(backupPath)).resolves.toEqual(backupBytes);
  });

  it('does not treat a pre-existing zero-byte database as a fresh install', async () => {
    const dataDirectory = await createDataDirectory();
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(databasePath, Buffer.alloc(0));

    const service = new DatabaseService({ dataDirectory });
    await expect(service.open()).rejects.toThrow(/database file is empty/u);
    await expect(readFile(databasePath)).resolves.toHaveLength(0);
  });

  it.each([
    {
      mutation: 'deleted',
      apply: (databasePath: string) => rmSync(databasePath),
    },
    {
      mutation: 'truncated',
      apply: (databasePath: string) => truncateSync(databasePath, 0),
    },
  ])('rejects an existing database $mutation between preflight and open', async ({ apply }) => {
    const dataDirectory = await createDataDirectory();
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    const backup = await original.createBackup();
    await original.close();
    const backupPath = join(dataDirectory, 'backups', backup.fileName);
    const backupBytes = await readFile(backupPath);
    let mutateBeforeOpen = true;
    const raced = new DatabaseService({
      dataDirectory,
      adapterFactory: (path, options) =>
        bindAdapterWithPreOpenMutation(createNodeSqliteAdapter(path, options), () => {
          if (!mutateBeforeOpen) return;
          mutateBeforeOpen = false;
          apply(databasePath);
        }),
    });

    await expect(raced.open()).rejects.toThrow(
      /database changed before its existing file could be opened/u,
    );
    await expect(readFile(databasePath)).resolves.toHaveLength(0);
    await expect(readFile(backupPath)).resolves.toEqual(backupBytes);
  });

  it('backs up an existing schema before applying a newly appended migration', async () => {
    const dataDirectory = await createDataDirectory();
    const firstVersion = new DatabaseService({ dataDirectory });
    await firstVersion.open();
    await firstVersion.close();

    const upgraded = new DatabaseService({
      dataDirectory,
      migrations: [
        ...DEFAULT_MIGRATIONS,
        {
          version: 8,
          name: 'add_upgrade_probe',
          sql: 'CREATE TABLE upgrade_probe (id INTEGER PRIMARY KEY) STRICT;',
        },
      ],
    });
    const result = await upgraded.open();
    expect(result.migration).toMatchObject({ fromVersion: 7, toVersion: 8 });
    expect(result.preMigrationBackup).toMatchObject({
      reason: 'pre-migration',
      schemaVersion: 7,
    });
    const backups = await upgraded.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ reason: 'pre-migration', schemaVersion: 7 });

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backups[0].fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      expect(
        snapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'upgrade_probe'")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      snapshot.close();
    }
    await upgraded.close();
  });

  it('refuses to open when an applied migration has been edited', async () => {
    const dataDirectory = await createDataDirectory();
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    await original.close();

    const tampered = new DatabaseService({
      dataDirectory,
      migrations: [
        {
          ...DEFAULT_MIGRATIONS[0],
          sql: `${DEFAULT_MIGRATIONS[0].sql}\n-- forbidden historical edit`,
        },
      ],
    });
    await expect(tampered.open()).rejects.toBeInstanceOf(DatabaseMigrationError);
  });

  it('reports a malformed migration ledger through the migration error contract', async () => {
    const dataDirectory = await createDataDirectory();
    await mkdir(dataDirectory, { recursive: true });
    const database = new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'));
    database.exec('CREATE TABLE schema_migrations (unexpected TEXT) STRICT;');
    database.close();

    const service = new DatabaseService({ dataDirectory });
    await expect(service.open()).rejects.toBeInstanceOf(DatabaseMigrationError);
  });

  it('ignores partial and unrelated files when listing backups', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({ dataDirectory });
    await service.open();
    const backup = await service.createBackup();
    await writeFile(join(dataDirectory, 'backups', '.interrupted.partial'), 'partial');
    await writeFile(join(dataDirectory, 'backups', 'notes.txt'), 'not a backup');
    await writeFile(
      join(
        dataDirectory,
        'backups',
        'daily-workbench-v1-manual-20260722T123456789Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.sqlite3',
      ),
      '',
    );

    await expect(service.listBackups()).resolves.toEqual([backup]);
    expect((await service.getStatus()).backupCount).toBe(1);
    await service.close();
  });

  it('normalizes generated backup UUIDs and round-trips them through the scanner', async () => {
    const dataDirectory = await createDataDirectory();
    const ids = [
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA1',
      'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBB2',
      'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCC3',
    ];
    const service = new DatabaseService({
      dataDirectory,
      idFactory: () => ids.shift() ?? 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDD4',
    });
    await service.open();

    const backup = await service.createBackup();
    expect(backup.id).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2');
    await expect(service.listBackups()).resolves.toEqual([backup]);
    await service.close();
  });

  it('rolls back last-opened metadata when existing metadata is corrupt', async () => {
    const dataDirectory = await createDataDirectory();
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    await original.close();

    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const database = new DatabaseSync(databasePath);
    const before = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'")
      .get() as { value: string };
    database.prepare("UPDATE app_metadata SET value = 'corrupt' WHERE key = 'database_id'").run();
    database.close();

    const reopened = new DatabaseService({
      dataDirectory,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });
    await expect(reopened.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);

    const inspected = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        inspected.prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'").get(),
      ).toEqual(before);
    } finally {
      inspected.close();
    }
  });

  it('refuses to open an existing v7 database whose FTS document index is out of sync', async () => {
    const dataDirectory = await createDataDirectory();
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    await original.close();

    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const database = new DatabaseSync(databasePath);
    const workspace = database
      .prepare(
        `SELECT current_workspace_id AS workspaceId
         FROM workspace_app_state
         WHERE singleton = 1`,
      )
      .get() as { workspaceId: string };
    const taskId = 'abababab-abab-4bab-8bab-abababababab';
    const taskTitle = 'missing startup index row';
    database
      .prepare(
        `INSERT INTO tasks (
           id, workspace_id, title, status, planned_for, source_inbox_entry_id,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, 'todo', NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        taskId,
        workspace.workspaceId,
        taskTitle,
        '2026-07-23T08:00:00.000Z',
        '2026-07-23T08:00:00.000Z',
      );
    const task = database.prepare('SELECT rowid FROM tasks WHERE id = ?').get(taskId) as {
      rowid: number;
    };
    database
      .prepare(
        `INSERT INTO tasks_search(tasks_search, rowid, title)
         VALUES ('delete', ?, ?)`,
      )
      .run(task.rowid, taskTitle);
    database.close();

    const reopened = new DatabaseService({ dataDirectory });
    await expect(reopened.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
  });

  it('validates connection safety before updating last-opened metadata', async () => {
    const dataDirectory = await createDataDirectory();
    const original = new DatabaseService({ dataDirectory });
    await original.open();
    await original.close();

    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const before = readMetadataValue(databasePath, 'last_opened_at');
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly ? adapter : bindAdapterWithUnsafeTrustedSchema(adapter);
    };
    const unsafe = new DatabaseService({
      dataDirectory,
      adapterFactory,
      now: () => new Date('2030-01-02T03:04:05.000Z'),
    });

    await expect(unsafe.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    expect(readMetadataValue(databasePath, 'last_opened_at')).toBe(before);
  });

  it('ignores ordinary tables that shadow connection PRAGMA module names', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({
      dataDirectory,
      migrations: [
        ...DEFAULT_MIGRATIONS,
        {
          version: 8,
          name: 'shadow_pragma_modules',
          sql: `
            CREATE TABLE pragma_journal_mode (journal_mode TEXT NOT NULL) STRICT;
            INSERT INTO pragma_journal_mode (journal_mode) VALUES ('delete');
            CREATE TABLE pragma_foreign_keys (foreign_keys INTEGER NOT NULL) STRICT;
            INSERT INTO pragma_foreign_keys (foreign_keys) VALUES (0);
            CREATE TABLE pragma_busy_timeout (timeout INTEGER NOT NULL) STRICT;
            INSERT INTO pragma_busy_timeout (timeout) VALUES (1);
            CREATE TABLE pragma_synchronous (synchronous INTEGER NOT NULL) STRICT;
            INSERT INTO pragma_synchronous (synchronous) VALUES (0);
            CREATE TABLE pragma_trusted_schema (trusted_schema INTEGER NOT NULL) STRICT;
            INSERT INTO pragma_trusted_schema (trusted_schema) VALUES (1);
          `,
        },
      ],
    });

    await service.open();
    await expect(service.getStatus()).resolves.toMatchObject({
      schemaVersion: 8,
      journalMode: 'wal',
      integrityCheck: 'ok',
    });
    await service.close();
  });

  it('normalizes backup provider failures to the backup error contract', async () => {
    const invalidDateDirectory = await createDataDirectory();
    let dateCalls = 0;
    const invalidDateService = new DatabaseService({
      dataDirectory: invalidDateDirectory,
      now: () => (dateCalls++ === 0 ? new Date('2026-07-22T12:00:00.000Z') : new Date(NaN)),
    });
    await invalidDateService.open();
    await expect(invalidDateService.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
    await invalidDateService.close();

    const throwingIdDirectory = await createDataDirectory();
    let idCalls = 0;
    const throwingIdService = new DatabaseService({
      dataDirectory: throwingIdDirectory,
      idFactory: () => {
        if (idCalls++ === 0) {
          return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        }
        throw new Error('entropy source unavailable');
      },
    });
    await throwingIdService.open();
    await expect(throwingIdService.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
    await throwingIdService.close();
  });

  it('closes the connection but reports a busy WAL checkpoint', async () => {
    const dataDirectory = await createDataDirectory();
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly ? adapter : bindAdapterWithBusyCheckpoint(adapter);
    };
    const service = new DatabaseService({ dataDirectory, adapterFactory });
    await service.open();

    await expect(service.close()).rejects.toBeInstanceOf(DatabaseOpenError);
    await expect(service.getStatus()).rejects.toBeInstanceOf(DatabaseStateError);
  });

  it('rejects an adapter that opens outside the controlled database path', async () => {
    const dataDirectory = await createDataDirectory();
    const outsideDirectory = await createDataDirectory();
    await mkdir(outsideDirectory, { recursive: true });
    const outsidePath = join(outsideDirectory, 'outside.sqlite3');
    const service = new DatabaseService({
      dataDirectory,
      adapterFactory: (_path, options) => createNodeSqliteAdapter(outsidePath, options),
    });

    await expect(service.open()).rejects.toBeInstanceOf(DatabasePathError);
  });

  it('waits for an in-flight backup before closing the connection', async () => {
    const dataDirectory = await createDataDirectory();
    let signalStarted: (() => void) | undefined;
    let releaseBackup: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      if (options?.readOnly) {
        return adapter;
      }
      return bindAdapterWithDelayedBackup(adapter, async (destination) => {
        signalStarted?.();
        await released;
        return adapter.backupTo(destination);
      });
    };
    const service = new DatabaseService({ dataDirectory, adapterFactory });
    await service.open();

    const backupPromise = service.createBackup();
    await started;
    let closed = false;
    const closePromise = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseBackup?.();
    await backupPromise;
    await closePromise;
    expect(closed).toBe(true);
  });

  it('coordinates app-level backup policy, protected backup reasons, and logical export reads', async () => {
    const dataDirectory = await createDataDirectory();
    let now = new Date('2026-07-23T08:00:00.000Z');
    const service = new DatabaseService({ dataDirectory, now: () => now });
    await service.open();

    await expect(service.getBackupSchedulerState()).resolves.toMatchObject({
      policy: {
        enabled: false,
        cadence: 'daily',
        localTimeMinute: 120,
        weekday: null,
        retentionCount: 14,
        revision: 1,
      },
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastSuccessBucket: null,
    });
    now = new Date('2026-07-23T08:05:00.000Z');
    await expect(
      service.updateBackupPolicy({
        enabled: true,
        cadence: 'daily',
        localTimeMinute: 180,
        weekday: null,
        retentionCount: 1,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ enabled: true, revision: 2 });

    await service.recordBackupAttempt(now.toISOString());
    now = new Date('2026-07-23T08:06:00.000Z');
    await service.recordBackupResult({
      attemptedAt: '2026-07-23T08:05:00.000Z',
      completedAt: now.toISOString(),
      successfulBucket: 'daily:2026-07-23',
    });
    await expect(service.getBackupSchedulerState()).resolves.toMatchObject({
      lastAttemptAt: '2026-07-23T08:05:00.000Z',
      lastSuccessAt: '2026-07-23T08:06:00.000Z',
      lastSuccessBucket: 'daily:2026-07-23',
      lastErrorCode: null,
      consecutiveFailures: 0,
    });

    const firstScheduled = await service.createScheduledBackup();
    now = new Date('2026-07-23T08:07:00.000Z');
    const secondScheduled = await service.createScheduledBackup();
    const protectedBackup = await service.createPreImportBackup();
    await expect(service.pruneScheduledBackups(secondScheduled.id)).resolves.toEqual({
      deleted: 1,
      retained: 1,
    });
    const backups = await service.listBackups();
    expect(backups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: secondScheduled.id, reason: 'scheduled' }),
        expect.objectContaining({ id: protectedBackup.id, reason: 'pre-import' }),
      ]),
    );
    expect(backups.some(({ id }) => id === firstScheduled.id)).toBe(false);

    const records = await service.readPortableRecords();
    expect(records.map(({ type }) => type)).toEqual([
      'app-state',
      'workspace',
      'workspace-preference',
    ]);
    await service.close();
  });

  it('applies the latest retention policy atomically after a stale scheduler read', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({ dataDirectory });
    await service.open();
    try {
      const stale = await service.getBackupSchedulerState();
      expect(stale.policy.retentionCount).toBe(14);

      const backupIds = Array.from(
        { length: 15 },
        (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
      );
      await Promise.all(
        backupIds.map((id, index) =>
          writeFile(
            join(
              dataDirectory,
              'backups',
              `daily-workbench-v7-scheduled-20260722T0200${String(index).padStart(2, '0')}000Z-${id}.sqlite3`,
            ),
            `scheduled backup ${index}`,
          ),
        ),
      );

      await service.updateBackupPolicy({
        enabled: stale.policy.enabled,
        cadence: stale.policy.cadence,
        localTimeMinute: stale.policy.localTimeMinute,
        weekday: stale.policy.weekday,
        retentionCount: 90,
        expectedRevision: stale.policy.revision,
      });
      await expect(service.pruneScheduledBackups(backupIds[backupIds.length - 1])).resolves.toEqual(
        {
          deleted: 0,
          retained: 15,
        },
      );
      await expect(service.listBackups()).resolves.toHaveLength(15);
    } finally {
      await service.close();
    }
  });
});

async function createDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-service-'));
  temporaryDirectories.push(directory);
  return join(directory, 'data');
}

function bindAdapterWithPreOpenMutation(adapter: SqliteAdapter, mutate: () => void): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'open') {
        return () => {
          mutate();
          target.open();
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function bindAdapterWithDelayedBackup(
  adapter: SqliteAdapter,
  backupTo: (destinationPath: string) => Promise<number>,
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'backupTo') {
        return backupTo;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function bindAdapterWithBusyCheckpoint(adapter: SqliteAdapter): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'get') {
        return (sql: string, parameters: readonly SQLInputValue[] = []) => {
          if (sql === 'PRAGMA wal_checkpoint(TRUNCATE)') {
            return { busy: 1, log: 1, checkpointed: 0 };
          }
          return target.get(sql, parameters);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function bindAdapterWithUnsafeTrustedSchema(adapter: SqliteAdapter): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'get') {
        return (sql: string, parameters: readonly SQLInputValue[] = []) => {
          if (sql === 'PRAGMA trusted_schema') {
            return { trusted_schema: 1 };
          }
          return target.get(sql, parameters);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function readMetadataValue(databasePath: string, key: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT value FROM app_metadata WHERE key = ?').get(key) as
      { value: unknown } | undefined;
    if (!row || typeof row.value !== 'string') {
      throw new Error(`Missing metadata value: ${key}`);
    }
    return row.value;
  } finally {
    database.close();
  }
}
