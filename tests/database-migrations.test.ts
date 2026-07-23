import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseMigrationError } from '../src/main/database/errors';
import {
  checksumMigration,
  DAILY_WORKBENCH_APPLICATION_ID,
  MigrationRunner,
} from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';
import type { Migration } from '../src/main/database/types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

describe('database migrations', () => {
  it('applies contiguous migrations atomically and reopens idempotently', async () => {
    const database = await createDatabase();
    const runner = new MigrationRunner(validMigrations());

    const firstPlan = runner.plan(database);
    expect(firstPlan.currentVersion).toBe(0);
    expect(firstPlan.pending).toHaveLength(2);
    expect(runner.apply(database)).toMatchObject({ fromVersion: 0, toVersion: 2 });

    const secondPlan = runner.plan(database);
    expect(secondPlan).toEqual({ currentVersion: 2, pending: [] });
    expect(runner.apply(database)).toEqual({
      fromVersion: 2,
      toVersion: 2,
      applied: [],
    });
    expect(
      database.get<{ value: number }>('SELECT application_id AS value FROM pragma_application_id')
        ?.value,
    ).toBe(DAILY_WORKBENCH_APPLICATION_ID);
    expect(
      database.get<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations')?.count,
    ).toBe(2);
    database.close();
  });

  it('rolls back the ledger and every pending migration when one fails', async () => {
    const database = await createDatabase();
    const runner = new MigrationRunner([
      {
        version: 1,
        name: 'create_items',
        sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY) STRICT;',
      },
      { version: 2, name: 'broken_migration', sql: 'CREATE TABLE broken (' },
    ]);

    expect(() => runner.apply(database)).toThrow(DatabaseMigrationError);
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM sqlite_schema
         WHERE type = 'table' AND name IN ('items', 'schema_migrations')`,
      )?.count,
    ).toBe(0);
    expect(
      database.get<{ value: number }>('SELECT user_version AS value FROM pragma_user_version')
        ?.value,
    ).toBe(0);
    database.close();
  });

  it('rejects an edited migration after its checksum has been recorded', async () => {
    const database = await createDatabase();
    const original = validMigrations();
    new MigrationRunner(original).apply(database);

    const edited = [
      { ...original[0], sql: `${original[0].sql}\n-- edited after release` },
      original[1],
    ];
    expect(() => new MigrationRunner(edited).plan(database)).toThrow(/does not match/u);
    database.close();
  });

  it('reads native PRAGMAs even when ordinary tables shadow pragma module names', async () => {
    const database = await createDatabase();
    database.exec(`
      CREATE TABLE pragma_user_version (user_version INTEGER NOT NULL) STRICT;
      INSERT INTO pragma_user_version (user_version) VALUES (999);
      CREATE TABLE pragma_application_id (application_id INTEGER NOT NULL) STRICT;
      INSERT INTO pragma_application_id (application_id) VALUES (999);
    `);
    const runner = new MigrationRunner(validMigrations());

    expect(runner.plan(database)).toMatchObject({ currentVersion: 0 });
    expect(runner.apply(database)).toMatchObject({ fromVersion: 0, toVersion: 2 });
    expect(database.get<Record<string, unknown>>('PRAGMA user_version')).toEqual({
      user_version: 2,
    });
    expect(database.get<Record<string, unknown>>('PRAGMA application_id')).toEqual({
      application_id: DAILY_WORKBENCH_APPLICATION_ID,
    });
    database.close();
  });

  it('normalizes checkout line endings without hiding other SQL edits', () => {
    const unix = { version: 1, name: 'line_endings', sql: 'SELECT 1;\nSELECT 2;\n' };
    const windows = { ...unix, sql: unix.sql.replaceAll('\n', '\r\n') };
    expect(checksumMigration(unix)).toBe(checksumMigration(windows));
    expect(checksumMigration({ ...unix, sql: 'SELECT 1;\nSELECT 3;\n' })).not.toBe(
      checksumMigration(unix),
    );
    expect(checksumMigration({ ...unix, sql: `${unix.sql}\u00a0` })).not.toBe(
      checksumMigration(unix),
    );
  });

  it('rejects gaps, invalid names, duplicate names, and empty SQL', () => {
    const invalidSets: Migration[][] = [
      [{ version: 2, name: 'starts_at_two', sql: 'SELECT 1;' }],
      [{ version: 1, name: 'Invalid-Name', sql: 'SELECT 1;' }],
      [
        { version: 1, name: 'repeated_name', sql: 'SELECT 1;' },
        { version: 2, name: 'repeated_name', sql: 'SELECT 2;' },
      ],
      [{ version: 1, name: 'empty', sql: '   ' }],
    ];
    for (const migrations of invalidSets) {
      expect(() => new MigrationRunner(migrations)).toThrow(DatabaseMigrationError);
    }
  });

  it.each([
    'CREATE TABLE escaped (id INTEGER PRIMARY KEY) STRICT; END; CREATE TABLE after_end (id INTEGER);',
    'CREATE TABLE escaped (id INTEGER PRIMARY KEY) STRICT; -- try to escape\n COMMIT;',
    'CREATE TABLE escaped (id INTEGER PRIMARY KEY) STRICT; SAVEPOINT nested;',
  ])('denies migration-owned transaction control and rolls back every change', async (sql) => {
    const database = await createDatabase();
    const runner = new MigrationRunner([{ version: 1, name: 'escape_attempt', sql }]);

    expect(() => runner.apply(database)).toThrow(DatabaseMigrationError);
    expect(database.isTransaction).toBe(false);
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM sqlite_schema
         WHERE type = 'table' AND name IN ('escaped', 'after_end', 'schema_migrations')`,
      )?.count,
    ).toBe(0);
    expect(
      database.get<{ value: number }>('SELECT user_version AS value FROM pragma_user_version')
        ?.value,
    ).toBe(0);
    database.close();
  });

  it('denies migration-owned PRAGMA changes and preserves connection safety settings', async () => {
    const database = await createDatabase();
    const runner = new MigrationRunner([
      {
        version: 1,
        name: 'unsafe_pragma',
        sql: 'CREATE TABLE escaped (id INTEGER PRIMARY KEY) STRICT; PRAGMA trusted_schema = ON;',
      },
    ]);

    expect(() => runner.apply(database)).toThrow(DatabaseMigrationError);
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM sqlite_schema
         WHERE type = 'table' AND name IN ('escaped', 'schema_migrations')`,
      )?.count,
    ).toBe(0);
    expect(
      database.get<{ value: number }>('SELECT trusted_schema AS value FROM pragma_trusted_schema')
        ?.value,
    ).toBe(0);
    database.close();
  });

  it('allows only the read-only data_version probe required by FTS5 migrations', async () => {
    const readable = await createDatabase();
    const readOnlyProbe = new MigrationRunner([
      {
        version: 1,
        name: 'fts_data_version_probe',
        sql: `
          PRAGMA data_version;
          CREATE VIRTUAL TABLE searchable USING fts5(content, tokenize = 'trigram');
        `,
      },
    ]);
    expect(readOnlyProbe.apply(readable)).toMatchObject({ fromVersion: 0, toVersion: 1 });
    readable.close();

    const writable = await createDatabase();
    const assignment = new MigrationRunner([
      {
        version: 1,
        name: 'data_version_assignment',
        sql: 'CREATE TABLE escaped (id INTEGER PRIMARY KEY) STRICT; PRAGMA data_version = 1;',
      },
    ]);
    expect(() => assignment.apply(writable)).toThrow(DatabaseMigrationError);
    expect(
      writable.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'escaped'",
      ),
    ).toEqual({ count: 0 });
    writable.close();
  });

  it('denies migration-owned database attachments outside the controlled path', async () => {
    const database = await createDatabase();
    const externalDirectory = await createTemporaryDirectory('daily-workbench-attachment-');
    const externalPath = join(externalDirectory, 'escaped.sqlite3');
    const escapedPath = externalPath.replaceAll("'", "''");
    const runner = new MigrationRunner([
      {
        version: 1,
        name: 'attach_external',
        sql: `ATTACH DATABASE '${escapedPath}' AS escaped; CREATE TABLE escaped.items (id INTEGER);`,
      },
    ]);

    expect(() => runner.apply(database)).toThrow(DatabaseMigrationError);
    expect(database.all<Record<string, unknown>>('PRAGMA database_list')).toHaveLength(1);
    await expect(access(externalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    database.close();
  });

  it('denies migration-owned detach operations', async () => {
    const database = await createDatabase();
    const externalDirectory = await createTemporaryDirectory('daily-workbench-detachment-');
    const externalPath = join(externalDirectory, 'attached.sqlite3').replaceAll("'", "''");
    database.exec(`ATTACH DATABASE '${externalPath}' AS auxiliary`);
    expect(() => database.execMigration('DETACH DATABASE auxiliary;')).toThrow();
    expect(database.all<Record<string, unknown>>('PRAGMA database_list')).toHaveLength(2);
    database.exec('DETACH DATABASE auxiliary');
    database.close();
  });

  it('wraps a failure to begin the migration transaction with the migration error contract', async () => {
    const database = await createDatabase();
    const adapter = bindAdapterWithExec(database, (sql) => {
      if (sql === 'BEGIN IMMEDIATE') {
        throw new Error('database is busy');
      }
      database.exec(sql);
    });

    expect(() => new MigrationRunner(validMigrations()).apply(adapter)).toThrow(
      DatabaseMigrationError,
    );
    expect(database.isTransaction).toBe(false);
    database.close();
  });

  it('wraps malformed migration-ledger reads with the migration error contract', async () => {
    const database = await createDatabase();
    database.exec('CREATE TABLE schema_migrations (unexpected TEXT) STRICT;');
    const runner = new MigrationRunner(validMigrations());

    expect(() => runner.plan(database)).toThrow(DatabaseMigrationError);
    expect(() => runner.apply(database)).toThrow(DatabaseMigrationError);
    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await createTemporaryDirectory('daily-workbench-migrations-');
  const database = createNodeSqliteAdapter(join(directory, 'test.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function validMigrations(): readonly Migration[] {
  return [
    {
      version: 1,
      name: 'create_items',
      sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT;',
    },
    {
      version: 2,
      name: 'add_item_index',
      sql: 'CREATE INDEX items_label_idx ON items (label);',
    },
  ];
}

function bindAdapterWithExec(adapter: SqliteAdapter, exec: (sql: string) => void): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'exec') {
        return exec;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
