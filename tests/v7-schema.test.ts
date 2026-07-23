import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';

const temporaryDirectories: string[] = [];
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-07-23T08:00:00.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

describe('v7 search and data protection schema', () => {
  it('registers v7 after the browser migration and requires FTS5', async () => {
    const database = await createDatabase();
    expect(
      database.get<{ enabled: number }>(
        "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled",
      ),
    ).toEqual({ enabled: 1 });
    expect(new MigrationRunner(DEFAULT_MIGRATIONS).apply(database)).toMatchObject({
      fromVersion: 0,
      toVersion: 7,
    });
    expect(DEFAULT_MIGRATIONS.at(-1)).toMatchObject({
      version: 7,
      name: 'search_data_protection',
    });
    database.close();
  });

  it('indexes inserts and updates while keeping soft-archived rows filterable by the source table', async () => {
    const database = await createV7Database();
    seedWorkspace(database);
    database.run(
      `INSERT INTO notes (
         id, workspace_id, title, body, revision, source_inbox_entry_id,
         created_at, updated_at, archived_at
       ) VALUES (
         '22222222-2222-4222-8222-222222222222', ?, '搜索标题', '正文包含 terminal',
         1, NULL, ?, ?, NULL
       )`,
      [WORKSPACE_ID, CREATED_AT, CREATED_AT],
    );

    expect(searchNote(database, '"搜索标"')).toEqual({ title: '搜索标题' });
    expect(searchNote(database, '"terminal"')).toEqual({ title: '搜索标题' });

    database.run(
      `UPDATE notes
       SET title = '更新标题', body = '正文包含 browser', revision = revision + 1, updated_at = ?
       WHERE id = '22222222-2222-4222-8222-222222222222'`,
      ['2026-07-23T08:01:00.000Z'],
    );
    expect(searchNote(database, '"terminal"')).toBeUndefined();
    expect(searchNote(database, '"browser"')).toEqual({ title: '更新标题' });

    database.run(
      `UPDATE notes
       SET archived_at = ?, revision = revision + 1, updated_at = ?
       WHERE id = '22222222-2222-4222-8222-222222222222'`,
      ['2026-07-23T08:02:00.000Z', '2026-07-23T08:02:00.000Z'],
    );
    expect(
      database.get<{ title: string }>(
        `SELECT notes.title
         FROM notes_search
         JOIN notes ON notes.rowid = notes_search.rowid
         WHERE notes_search MATCH ? AND notes.archived_at IS NULL`,
        ['"browser"'],
      ),
    ).toBeUndefined();
    database.close();
  });

  it('enforces a revisioned global backup policy and constrained run state', async () => {
    const database = await createV7Database();
    database.run(
      `INSERT INTO backup_policy (
         singleton, enabled, cadence, local_time_minute, weekday,
         retention_count, revision, updated_at
       ) VALUES (1, 0, 'daily', 120, NULL, 14, 1, ?)`,
      [CREATED_AT],
    );
    database.run(
      `INSERT INTO backup_run_state (
         singleton, last_attempt_at, last_success_at, last_success_bucket,
         last_error_code, consecutive_failures, updated_at
       ) VALUES (1, NULL, NULL, NULL, NULL, 0, ?)`,
      [CREATED_AT],
    );

    expect(() =>
      database.run(
        `UPDATE backup_policy
         SET enabled = 1, revision = revision, updated_at = ?
         WHERE singleton = 1`,
        ['2026-07-23T08:01:00.000Z'],
      ),
    ).toThrow(/revision must advance exactly once/u);
    expect(() =>
      database.run(
        `UPDATE backup_policy
         SET cadence = 'weekly', weekday = NULL, revision = revision + 1, updated_at = ?
         WHERE singleton = 1`,
        ['2026-07-23T08:01:00.000Z'],
      ),
    ).toThrow();
    expect(() =>
      database.run(
        `UPDATE backup_run_state
         SET last_error_code = 'raw-path-error', updated_at = ?
         WHERE singleton = 1`,
        ['2026-07-23T08:01:00.000Z'],
      ),
    ).toThrow();
    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-v7-schema-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'database.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createV7Database(): Promise<SqliteAdapter> {
  const database = await createDatabase();
  new MigrationRunner(DEFAULT_MIGRATIONS).apply(database);
  return database;
}

function seedWorkspace(database: SqliteAdapter): void {
  database.run(
    `INSERT INTO workspaces (
       id, name, name_key, color, created_at, updated_at, archived_at
     ) VALUES (?, '测试工作区', '测试工作区', '#7b6ee8', ?, ?, NULL)`,
    [WORKSPACE_ID, CREATED_AT, CREATED_AT],
  );
}

function searchNote(database: SqliteAdapter, query: string): { title: string } | undefined {
  return database.get<{ title: string }>(
    `SELECT notes.title
     FROM notes_search
     JOIN notes ON notes.rowid = notes_search.rowid
     WHERE notes_search MATCH ?`,
    [query],
  );
}
