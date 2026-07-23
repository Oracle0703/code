import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { DatabaseMigrationError } from '../src/main/database/errors';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';

const ACTIVE_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVED_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const NEW_WORKSPACE_ID = '33333333-3333-4333-8333-333333333333';
const REPLACEMENT_WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const T0 = '2026-07-23T08:00:00.000Z';
const T1 = '2026-07-23T08:01:00.000Z';
const T2 = '2026-07-23T08:02:00.000Z';
const T3 = '2026-07-23T08:03:00.000Z';
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

describe('v8 workspace terminal preference schema', () => {
  it('registers the terminal preference migration after v7', async () => {
    const database = await createDatabase();
    expect(new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 8)).apply(database)).toMatchObject({
      fromVersion: 0,
      toVersion: 8,
    });
    expect(DEFAULT_MIGRATIONS[7]).toMatchObject({
      version: 8,
      name: 'terminal_workspace_preferences',
    });
    expect(
      database.get<{ type: string }>(
        `SELECT type
         FROM sqlite_schema
         WHERE name = 'workspace_terminal_preferences'`,
      ),
    ).toEqual({ type: 'table' });
    database.close();
  });

  it('backfills every v7 workspace and creates defaults for future workspace inserts', async () => {
    const database = await createV7Database();
    seedV7Workspace(database, ACTIVE_WORKSPACE_ID, '活动空间', T0, null);
    insertWorkspace(database, ARCHIVED_WORKSPACE_ID, '归档空间', T1, T2);

    expect(new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 8)).apply(database)).toMatchObject({
      fromVersion: 7,
      toVersion: 8,
    });
    expect(readPreferences(database)).toEqual([
      {
        workspace_id: ACTIVE_WORKSPACE_ID,
        preferred_profile_id: 'system-default',
        native_cwd_platform: null,
        native_cwd_path: null,
        wsl_distribution_name: null,
        revision: 1,
        updated_at: T0,
      },
      {
        workspace_id: ARCHIVED_WORKSPACE_ID,
        preferred_profile_id: 'system-default',
        native_cwd_platform: null,
        native_cwd_path: null,
        wsl_distribution_name: null,
        revision: 1,
        updated_at: T1,
      },
    ]);

    insertWorkspace(database, NEW_WORKSPACE_ID, '新空间', T3, null);
    expect(
      database.get<Record<string, unknown>>(
        `SELECT preferred_profile_id, native_cwd_platform, native_cwd_path,
                wsl_distribution_name, revision, updated_at
         FROM workspace_terminal_preferences
         WHERE workspace_id = ?`,
        [NEW_WORKSPACE_ID],
      ),
    ).toEqual({
      preferred_profile_id: 'system-default',
      native_cwd_platform: null,
      native_cwd_path: null,
      wsl_distribution_name: null,
      revision: 1,
      updated_at: T3,
    });
    database.close();
  });

  it('enforces fixed profiles, paired CWD fields, revisions, timestamps, and archive safety', async () => {
    const database = await createV8Database();
    insertWorkspace(database, ACTIVE_WORKSPACE_ID, '活动空间', T0, null);

    database.run(
      `UPDATE workspace_terminal_preferences
       SET preferred_profile_id = 'bash', revision = 2, updated_at = ?
       WHERE workspace_id = ?`,
      [T1, ACTIVE_WORKSPACE_ID],
    );
    expect(() =>
      database.run(
        `UPDATE workspace_terminal_preferences
         SET preferred_profile_id = 'fish', revision = 3, updated_at = ?
         WHERE workspace_id = ?`,
        [T2, ACTIVE_WORKSPACE_ID],
      ),
    ).toThrow();
    expect(() =>
      database.run(
        `UPDATE workspace_terminal_preferences
         SET native_cwd_platform = 'linux', native_cwd_path = NULL,
             revision = 3, updated_at = ?
         WHERE workspace_id = ?`,
        [T2, ACTIVE_WORKSPACE_ID],
      ),
    ).toThrow();
    expect(() =>
      database.run(
        `UPDATE workspace_terminal_preferences
         SET revision = 2, updated_at = ?
         WHERE workspace_id = ?`,
        [T2, ACTIVE_WORKSPACE_ID],
      ),
    ).toThrow(/revision must advance exactly once/u);
    expect(() =>
      database.run(
        `UPDATE workspace_terminal_preferences
         SET revision = 3, updated_at = ?
         WHERE workspace_id = ?`,
        [T0, ACTIVE_WORKSPACE_ID],
      ),
    ).toThrow(/update time cannot move backwards/u);
    expect(() =>
      database.run(
        `UPDATE workspace_terminal_preferences
         SET workspace_id = ?, revision = 3, updated_at = ?
         WHERE workspace_id = ?`,
        [REPLACEMENT_WORKSPACE_ID, T2, ACTIVE_WORKSPACE_ID],
      ),
    ).toThrow(/workspace is immutable/u);
    expect(() =>
      database.run('DELETE FROM workspace_terminal_preferences WHERE workspace_id = ?', [
        ACTIVE_WORKSPACE_ID,
      ]),
    ).toThrow(/cannot be deleted/u);

    insertWorkspace(database, NEW_WORKSPACE_ID, '保留空间', T2, null);
    database.run(
      `UPDATE workspaces
       SET archived_at = ?, updated_at = ?
       WHERE id = ?`,
      [T2, T2, ACTIVE_WORKSPACE_ID],
    );
    expect(() =>
      database.run(
        `UPDATE workspace_terminal_preferences
         SET preferred_profile_id = 'zsh', revision = 3, updated_at = ?
         WHERE workspace_id = ?`,
        [T3, ACTIVE_WORKSPACE_ID],
      ),
    ).toThrow(/archived workspace terminal preferences are immutable/u);
    database.close();
  });

  it('rolls back v8 with every later pending migration when the chain fails', async () => {
    const database = await createV7Database();
    seedV7Workspace(database, ACTIVE_WORKSPACE_ID, '活动空间', T0, null);
    const runner = new MigrationRunner([
      ...DEFAULT_MIGRATIONS.slice(0, 8),
      {
        version: 9,
        name: 'broken_after_terminal_preferences',
        sql: 'CREATE TABLE broken_terminal_preferences (',
      },
    ]);

    expect(() => runner.apply(database)).toThrow(DatabaseMigrationError);
    expect(database.get<Record<string, unknown>>('PRAGMA user_version')).toEqual({
      user_version: 7,
    });
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM sqlite_schema
         WHERE name = 'workspace_terminal_preferences'`,
      ),
    ).toEqual({ count: 0 });
    expect(
      database.get<{ count: number }>('SELECT COUNT(*) AS count FROM schema_migrations'),
    ).toEqual({ count: 7 });
    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-v8-schema-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'database.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createV7Database(): Promise<SqliteAdapter> {
  const database = await createDatabase();
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 7)).apply(database);
  return database;
}

async function createV8Database(): Promise<SqliteAdapter> {
  const database = await createDatabase();
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 8)).apply(database);
  return database;
}

function seedV7Workspace(
  database: SqliteAdapter,
  id: string,
  name: string,
  updatedAt: string,
  archivedAt: string | null,
): void {
  insertWorkspace(database, id, name, updatedAt, archivedAt);
  database.run(
    `INSERT INTO workspace_preferences (
       workspace_id, active_view, theme, sidebar_collapsed, browser_open,
       browser_width, terminal_open, terminal_height, updated_at
     ) VALUES (?, 'today', 'dark', 0, 1, 430, 1, 260, ?)`,
    [id, updatedAt],
  );
}

function insertWorkspace(
  database: SqliteAdapter,
  id: string,
  name: string,
  updatedAt: string,
  archivedAt: string | null,
): void {
  database.run(
    `INSERT INTO workspaces (
       id, name, name_key, color, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, '#7b6ee8', ?, ?, ?)`,
    [id, name, name, T0, updatedAt, archivedAt],
  );
}

function readPreferences(database: SqliteAdapter): Record<string, unknown>[] {
  return database.all<Record<string, unknown>>(
    `SELECT workspace_id, preferred_profile_id, native_cwd_platform,
            native_cwd_path, wsl_distribution_name, revision, updated_at
     FROM workspace_terminal_preferences
     ORDER BY workspace_id`,
  );
}
