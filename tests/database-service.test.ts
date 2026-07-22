import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(initialized.migration).toMatchObject({ fromVersion: 0, toVersion: 1 });
    expect(initialized.preMigrationBackup).toBeUndefined();
    await expect(service.getStatus()).resolves.toMatchObject({
      schemaVersion: 1,
      appliedMigrations: 1,
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
      fromVersion: 1,
      toVersion: 1,
      applied: [],
    });
    await reopened.close();
  });

  it('creates an opaque, validated manual snapshot in the controlled backup directory', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({ dataDirectory });
    await service.open();

    const backup = await service.createBackup();
    expect(backup).toMatchObject({ reason: 'manual', schemaVersion: 1 });
    expect(backup.fileName).toMatch(/^daily-workbench-v1-manual-.+\.sqlite3$/u);
    expect(backup).not.toHaveProperty('path');
    expect(await service.listBackups()).toEqual([backup]);
    expect((await service.getStatus()).backupCount).toBe(1);

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
      expect(snapshot.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      expect(
        snapshot.prepare("SELECT value FROM app_metadata WHERE key = 'database_id'").get(),
      ).toHaveProperty('value');
    } finally {
      snapshot.close();
    }
    await service.close();
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
          version: 2,
          name: 'add_upgrade_probe',
          sql: 'CREATE TABLE upgrade_probe (id INTEGER PRIMARY KEY) STRICT;',
        },
      ],
    });
    const result = await upgraded.open();
    expect(result.migration).toMatchObject({ fromVersion: 1, toVersion: 2 });
    expect(result.preMigrationBackup).toMatchObject({
      reason: 'pre-migration',
      schemaVersion: 1,
    });
    const backups = await upgraded.listBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ reason: 'pre-migration', schemaVersion: 1 });

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backups[0].fileName), {
      readOnly: true,
    });
    try {
      expect(snapshot.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
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
          version: 2,
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
      schemaVersion: 2,
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
});

async function createDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-service-'));
  temporaryDirectories.push(directory);
  return join(directory, 'data');
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
