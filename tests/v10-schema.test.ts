import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import focusSessionsSql from '../migrations/0010_focus_sessions.sql?raw';
import { extractFocusSchemaSql, FocusRepository } from '../src/main/focus/focus-repository';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { DatabaseIntegrityError } from '../src/main/database/errors';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TASK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_A = '33333333-3333-4333-8333-333333333333';
const SESSION_B = '44444444-4444-4444-8444-444444444444';
const T0 = '2026-07-23T08:00:00.000Z';
const T1 = '2026-07-23T08:05:00.000Z';
const T2 = '2026-07-23T08:10:00.000Z';
const DEADLINE = '2026-07-23T08:25:00.000Z';
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

describe('v10 focus session schema', () => {
  it('extracts canonical schema from LF and CRLF and registers v10 contiguously', async () => {
    const windowsSql = focusSessionsSql.replace(/\r?\n/gu, '\r\n');
    expect(extractFocusSchemaSql(windowsSql, 'table', 'focus_sessions')).toBe(
      extractFocusSchemaSql(focusSessionsSql, 'table', 'focus_sessions'),
    );
    expect(extractFocusSchemaSql(windowsSql, 'index', 'focus_sessions_single_open')).toBe(
      extractFocusSchemaSql(focusSessionsSql, 'index', 'focus_sessions_single_open'),
    );
    expect(
      extractFocusSchemaSql(windowsSql, 'trigger', 'workspace_focus_session_cancel_before_archive'),
    ).toBe(
      extractFocusSchemaSql(
        focusSessionsSql,
        'trigger',
        'workspace_focus_session_cancel_before_archive',
      ),
    );

    const database = await createDatabase();
    expect(new MigrationRunner(DEFAULT_MIGRATIONS).apply(database)).toMatchObject({
      fromVersion: 0,
      toVersion: 10,
    });
    expect(DEFAULT_MIGRATIONS[9]).toMatchObject({
      version: 10,
      name: 'focus_sessions',
    });
    expect(
      database.get<{ type: string }>(
        `SELECT type FROM sqlite_schema WHERE name = 'focus_sessions'`,
      ),
    ).toEqual({ type: 'table' });
    expect(() => new FocusRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('enforces one global open session, active workspaces, task ownership, and civil dates', async () => {
    const database = await createV10Database();
    insertWorkspace(database, WORKSPACE_A, '空间 A');
    insertWorkspace(database, WORKSPACE_B, '空间 B');
    insertTask(database, TASK_A, WORKSPACE_A);
    insertRunning(database, SESSION_A, WORKSPACE_A, TASK_A);

    expect(() => insertPaused(database, SESSION_B, WORKSPACE_B, null)).toThrow(
      /unique constraint/iu,
    );
    cancel(database, SESSION_A, WORKSPACE_A, 1, T1);
    expect(() => insertRunning(database, SESSION_B, WORKSPACE_B, TASK_A)).toThrow(
      /task must belong/u,
    );
    expect(() => insertRunning(database, SESSION_B, WORKSPACE_B, null, '2026-02-30')).toThrow();

    database.run(`UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?`, [
      T1,
      T1,
      WORKSPACE_B,
    ]);
    expect(() => insertRunning(database, SESSION_B, WORKSPACE_B, null)).toThrow(
      /requires an active workspace/u,
    );
    expect(() => new FocusRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('requires exact revisions and immutable identity, history, and terminal rows', async () => {
    const database = await createV10Database();
    insertWorkspace(database, WORKSPACE_A, '空间 A');
    insertTask(database, TASK_A, WORKSPACE_A);
    insertRunning(database, SESSION_A, WORKSPACE_A, TASK_A);

    database.run(
      `UPDATE focus_sessions
       SET state = 'paused', remaining_seconds = 1200, deadline_at = NULL,
           revision = 2, updated_at = ?
       WHERE id = ?`,
      [T1, SESSION_A],
    );
    expect(() =>
      database.run(
        `UPDATE focus_sessions
         SET state = 'running', deadline_at = ?, revision = 2, updated_at = ?
         WHERE id = ?`,
        [DEADLINE, T2, SESSION_A],
      ),
    ).toThrow(/revision must advance exactly once/u);
    expect(() =>
      database.run(
        `UPDATE focus_sessions
         SET state = 'running', deadline_at = ?, local_date = '2026-07-24',
             revision = 3, updated_at = ?
         WHERE id = ?`,
        [DEADLINE, T2, SESSION_A],
      ),
    ).toThrow(/local date is immutable/u);
    database.run(
      `UPDATE focus_sessions
       SET state = 'cancelled', deadline_at = NULL, cancelled_at = ?,
           revision = 3, updated_at = ?
       WHERE id = ?`,
      [T2, T2, SESSION_A],
    );
    expect(() =>
      database.run(
        `UPDATE focus_sessions SET remaining_seconds = 0, revision = 4, updated_at = ?
         WHERE id = ?`,
        [T2, SESSION_A],
      ),
    ).toThrow(/terminal focus session is immutable/u);
    expect(() => database.run('DELETE FROM focus_sessions WHERE id = ?', [SESSION_A])).toThrow(
      /cannot be permanently deleted/u,
    );
    expect(() => new FocusRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('allows only decreasing running checkpoints and rejects same-state deadline or pause rewrites', async () => {
    const database = await createV10Database();
    insertWorkspace(database, WORKSPACE_A, '空间 A');
    insertRunning(database, SESSION_A, WORKSPACE_A, null);

    expect(() =>
      database.run(
        `UPDATE focus_sessions
         SET remaining_seconds = 1499, deadline_at = '2026-07-23T08:30:00.000Z',
             revision = 2, updated_at = ?
         WHERE id = ?`,
        [T1, SESSION_A],
      ),
    ).toThrow(/state transition is invalid/u);
    database.run(
      `UPDATE focus_sessions
       SET remaining_seconds = 1499, revision = 2, updated_at = ?
       WHERE id = ?`,
      [T1, SESSION_A],
    );
    expect(
      database.get<Record<string, unknown>>(
        `SELECT state, remaining_seconds, deadline_at, revision
         FROM focus_sessions WHERE id = ?`,
        [SESSION_A],
      ),
    ).toEqual({
      state: 'running',
      remaining_seconds: 1499,
      deadline_at: DEADLINE,
      revision: 2,
    });

    database.run(
      `UPDATE focus_sessions
       SET state = 'paused', remaining_seconds = 1499, deadline_at = NULL,
           revision = 3, updated_at = ?
       WHERE id = ?`,
      [T2, SESSION_A],
    );
    expect(() =>
      database.run(
        `UPDATE focus_sessions
         SET remaining_seconds = 1500, revision = 4, updated_at = ?
         WHERE id = ?`,
        [T2, SESSION_A],
      ),
    ).toThrow(/state transition is invalid/u);
    expect(() => new FocusRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('cancels an open session in the same workspace-archive transaction', async () => {
    const database = await createV10Database();
    insertWorkspace(database, WORKSPACE_A, '空间 A');
    insertWorkspace(database, WORKSPACE_B, '空间 B');
    insertPaused(database, SESSION_A, WORKSPACE_A, null);

    database.run(`UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?`, [
      T2,
      T2,
      WORKSPACE_A,
    ]);
    expect(
      database.get<Record<string, unknown>>(
        `SELECT local_date, state, remaining_seconds, deadline_at, revision,
                updated_at, completed_at, cancelled_at
         FROM focus_sessions WHERE id = ?`,
        [SESSION_A],
      ),
    ).toEqual({
      local_date: '2026-07-23',
      state: 'cancelled',
      remaining_seconds: 1200,
      deadline_at: null,
      revision: 2,
      updated_at: T2,
      completed_at: null,
      cancelled_at: T2,
    });
    expect(() =>
      database.run(`UPDATE focus_sessions SET revision = 3, updated_at = ? WHERE id = ?`, [
        T2,
        SESSION_A,
      ]),
    ).toThrow(/terminal focus session is immutable|archived workspace/u);
    expect(() => new FocusRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('rejects a canonical trigger replaced by a weaker object with the same name', async () => {
    const database = await createV10Database();
    database.exec('DROP TRIGGER focus_sessions_prevent_delete');
    database.exec(`
      CREATE TRIGGER focus_sessions_prevent_delete
      BEFORE DELETE ON focus_sessions
      BEGIN
        SELECT 1;
      END;
    `);
    expect(() => new FocusRepository(database).validateSnapshot()).toThrow(DatabaseIntegrityError);
    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-v10-schema-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'database.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createV10Database(): Promise<SqliteAdapter> {
  const database = await createDatabase();
  new MigrationRunner(DEFAULT_MIGRATIONS).apply(database);
  return database;
}

function insertWorkspace(database: SqliteAdapter, id: string, name: string): void {
  database.run(
    `INSERT INTO workspaces (
       id, name, name_key, color, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, '#7b6ee8', ?, ?, NULL)`,
    [id, name, name, T0, T0],
  );
}

function insertTask(database: SqliteAdapter, id: string, workspaceId: string): void {
  database.run(
    `INSERT INTO tasks (
       id, workspace_id, title, status, planned_for, source_inbox_entry_id,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, '今日任务', 'todo', '2026-07-23', NULL, ?, ?, NULL)`,
    [id, workspaceId, T0, T0],
  );
}

function insertRunning(
  database: SqliteAdapter,
  id: string,
  workspaceId: string,
  taskId: string | null,
  localDate = '2026-07-23',
): void {
  database.run(
    `INSERT INTO focus_sessions (
       id, workspace_id, task_id, local_date, state, remaining_seconds,
       deadline_at, revision, created_at, updated_at, completed_at, cancelled_at
     ) VALUES (?, ?, ?, ?, 'running', 1500, ?, 1, ?, ?, NULL, NULL)`,
    [id, workspaceId, taskId, localDate, DEADLINE, T0, T0],
  );
}

function insertPaused(
  database: SqliteAdapter,
  id: string,
  workspaceId: string,
  taskId: string | null,
): void {
  database.run(
    `INSERT INTO focus_sessions (
       id, workspace_id, task_id, local_date, state, remaining_seconds,
       deadline_at, revision, created_at, updated_at, completed_at, cancelled_at
     ) VALUES (?, ?, ?, '2026-07-23', 'paused', 1200, NULL, 1, ?, ?, NULL, NULL)`,
    [id, workspaceId, taskId, T0, T0],
  );
}

function cancel(
  database: SqliteAdapter,
  id: string,
  workspaceId: string,
  revision: number,
  timestamp: string,
): void {
  database.run(
    `UPDATE focus_sessions
     SET state = 'cancelled', deadline_at = NULL, revision = revision + 1,
         updated_at = ?, cancelled_at = ?
     WHERE id = ? AND workspace_id = ? AND revision = ?`,
    [timestamp, timestamp, id, workspaceId, revision],
  );
}
