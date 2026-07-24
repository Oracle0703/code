import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import workspaceRecoverySql from '../migrations/0011_workspace_recovery.sql?raw';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';
import { extractRecoverySchemaSql } from '../src/main/workspaces/workspace-repository';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TASK_A = '33333333-3333-4333-8333-333333333333';
const T0 = '2026-07-23T08:00:00.000Z';
const T1 = '2026-07-23T09:00:00.000Z';
const T2 = '2026-07-23T10:00:00.000Z';
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

describe('v11 workspace recovery schema', () => {
  it('registers the canonical recovery ledger after focus sessions and backfills v10 rows', async () => {
    const windowsSql = workspaceRecoverySql.replace(/\r?\n/gu, '\r\n');
    expect(extractRecoverySchemaSql(windowsSql, 'table', 'workspace_recovery_revisions')).toBe(
      extractRecoverySchemaSql(workspaceRecoverySql, 'table', 'workspace_recovery_revisions'),
    );
    expect(
      extractRecoverySchemaSql(windowsSql, 'trigger', 'workspace_restore_active_automation_limit'),
    ).toBe(
      extractRecoverySchemaSql(
        workspaceRecoverySql,
        'trigger',
        'workspace_restore_active_automation_limit',
      ),
    );

    const database = await createDatabase();
    expect(new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 10)).apply(database)).toMatchObject({
      fromVersion: 0,
      toVersion: 10,
    });
    insertWorkspace(database, WORKSPACE_A, '已有归档');
    insertWorkspace(database, WORKSPACE_B, '已有活动');
    archiveWorkspace(database, WORKSPACE_A, T1);
    expect(new MigrationRunner(DEFAULT_MIGRATIONS).apply(database)).toMatchObject({
      fromVersion: 10,
      toVersion: 11,
    });
    expect(DEFAULT_MIGRATIONS[10]).toMatchObject({
      version: 11,
      name: 'workspace_recovery',
    });
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM sqlite_schema
         WHERE name = 'workspace_recovery_revisions'
            OR name LIKE 'workspace_recovery_revision_%'
            OR name IN (
              'workspaces_archived_row_is_immutable',
              'workspaces_timestamp_order_insert',
              'workspaces_timestamp_order_update',
              'workspaces_updated_at_must_not_rewind',
              'workspace_restore_active_automation_limit',
              'automation_run_state_prevent_archived_workspace_mutation',
              'automation_occurrences_require_active_workspace_insert'
            )`,
      ),
    ).toEqual({ count: 13 });
    expect(
      database.all<{ workspace_id: string; revision: number }>(
        `SELECT workspace_id, revision
         FROM workspace_recovery_revisions
         ORDER BY workspace_id`,
      ),
    ).toEqual([
      { workspace_id: WORKSPACE_A, revision: 2 },
      { workspace_id: WORKSPACE_B, revision: 1 },
    ]);
    database.close();
  });

  it('creates one immutable recovery revision and advances it for every archive transition', async () => {
    const database = await createV11Database();
    insertWorkspace(database, WORKSPACE_A, '空间 A');
    insertWorkspace(database, WORKSPACE_B, '空间 B');

    expect(readRecoveryRevision(database, WORKSPACE_A)).toBe(1);
    archiveWorkspace(database, WORKSPACE_A, T1);
    expect(readRecoveryRevision(database, WORKSPACE_A)).toBe(2);
    restoreWorkspace(database, WORKSPACE_A, T1);
    expect(readRecoveryRevision(database, WORKSPACE_A)).toBe(3);
    archiveWorkspace(database, WORKSPACE_A, T2);
    expect(readRecoveryRevision(database, WORKSPACE_A)).toBe(4);

    expect(() =>
      database.run('UPDATE workspace_recovery_revisions SET revision = 5 WHERE workspace_id = ?', [
        WORKSPACE_A,
      ]),
    ).toThrow(/must match the archive transition/u);
    expect(() =>
      database.run('UPDATE workspace_recovery_revisions SET revision = 6 WHERE workspace_id = ?', [
        WORKSPACE_A,
      ]),
    ).toThrow(/must match the archive transition/u);
    expect(() =>
      database.run(
        'UPDATE workspace_recovery_revisions SET workspace_id = ? WHERE workspace_id = ?',
        [randomUUID(), WORKSPACE_A],
      ),
    ).toThrow(/identity is immutable/u);
    expect(() =>
      database.run('DELETE FROM workspace_recovery_revisions WHERE workspace_id = ?', [
        WORKSPACE_A,
      ]),
    ).toThrow(/cannot be deleted/u);
    database.close();
  });

  it('allows exactly one hundred active definitions and rejects a direct SQL restore at 101', async () => {
    const database = await createV11Database();
    insertWorkspace(database, WORKSPACE_A, '待恢复');
    insertWorkspace(database, WORKSPACE_B, '当前空间');
    insertAutomation(database, randomUUID(), WORKSPACE_A);
    archiveWorkspace(database, WORKSPACE_A, T1);

    for (let index = 0; index < 99; index += 1) {
      insertAutomation(database, randomUUID(), WORKSPACE_B);
    }
    expect(() => restoreWorkspace(database, WORKSPACE_A, T1)).not.toThrow();
    expect(readRecoveryRevision(database, WORKSPACE_A)).toBe(3);

    archiveWorkspace(database, WORKSPACE_A, T2);
    expect(readRecoveryRevision(database, WORKSPACE_A)).toBe(4);
    insertAutomation(database, randomUUID(), WORKSPACE_B);
    expect(() => restoreWorkspace(database, WORKSPACE_A, T2)).toThrow(
      /exceed active automation limit/u,
    );
    expect(
      database.get<{ archived_at: string; revision: number }>(
        `SELECT workspace.archived_at, recovery.revision
         FROM workspaces AS workspace
         JOIN workspace_recovery_revisions AS recovery
           ON recovery.workspace_id = workspace.id
         WHERE workspace.id = ?`,
        [WORKSPACE_A],
      ),
    ).toEqual({ archived_at: T2, revision: 4 });
    database.close();
  });

  it('blocks archived automation run-state mutations and new occurrence rows', async () => {
    const database = await createV11Database();
    insertWorkspace(database, WORKSPACE_A, '归档自动化');
    insertWorkspace(database, WORKSPACE_B, '保留空间');
    const automationId = randomUUID();
    insertAutomation(database, automationId, WORKSPACE_A);
    insertTask(database, TASK_A, WORKSPACE_A);
    archiveWorkspace(database, WORKSPACE_A, T1);

    expect(() =>
      database.run(
        `UPDATE automation_run_state
         SET last_attempt_at = ?,
             last_attempt_occurrence = '2026-07-23',
             last_error_code = 'action-failed',
             consecutive_failures = 1,
             next_retry_at = ?,
             updated_at = ?
         WHERE automation_id = ?`,
        [T1, T2, T2, automationId],
      ),
    ).toThrow(/archived workspace automation state is immutable/u);
    expect(() =>
      database.run(
        `INSERT INTO automation_occurrences (
           automation_id, occurrence_date, scheduled_for, definition_revision,
           completed_at, output_kind, task_id, note_id
         ) VALUES (?, '2026-07-23', ?, 1, ?, 'task', ?, NULL)`,
        [automationId, T1, T2, TASK_A],
      ),
    ).toThrow(/occurrence requires an active workspace/u);
    database.close();
  });

  it('enforces workspace time order, monotonic updates, and archived metadata immutability', async () => {
    const database = await createV11Database();
    expect(() =>
      database.run(
        `INSERT INTO workspaces (
           id, name, name_key, color, created_at, updated_at, archived_at
         ) VALUES (?, '倒序', '倒序', '#7b6ee8', ?, ?, NULL)`,
        [randomUUID(), T1, T0],
      ),
    ).toThrow(/timestamp order is invalid/u);

    insertWorkspace(database, WORKSPACE_A, '空间 A');
    insertWorkspace(database, WORKSPACE_B, '空间 B');
    database.run('UPDATE workspaces SET updated_at = ? WHERE id = ?', [T1, WORKSPACE_A]);
    expect(() =>
      database.run('UPDATE workspaces SET updated_at = ? WHERE id = ?', [T0, WORKSPACE_A]),
    ).toThrow(/cannot move backwards/u);
    expect(() =>
      database.run('UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?', [
        T2,
        T1,
        WORKSPACE_A,
      ]),
    ).toThrow(/timestamp order is invalid/u);

    archiveWorkspace(database, WORKSPACE_A, T2);
    expect(() =>
      database.run('UPDATE workspaces SET name = ?, name_key = ?, updated_at = ? WHERE id = ?', [
        '改名',
        '改名',
        T2,
        WORKSPACE_A,
      ]),
    ).toThrow(/archived workspace metadata is immutable/u);
    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-v11-schema-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'database.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createV11Database(): Promise<SqliteAdapter> {
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

function archiveWorkspace(database: SqliteAdapter, workspaceId: string, timestamp: string): void {
  database.run('UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?', [
    timestamp,
    timestamp,
    workspaceId,
  ]);
}

function restoreWorkspace(database: SqliteAdapter, workspaceId: string, timestamp: string): void {
  database.run('UPDATE workspaces SET archived_at = NULL, updated_at = ? WHERE id = ?', [
    timestamp,
    workspaceId,
  ]);
}

function readRecoveryRevision(database: SqliteAdapter, workspaceId: string): number | undefined {
  return database.get<{ revision: number }>(
    'SELECT revision FROM workspace_recovery_revisions WHERE workspace_id = ?',
    [workspaceId],
  )?.revision;
}

function insertAutomation(database: SqliteAdapter, id: string, workspaceId: string): void {
  database.run(
    `INSERT INTO automations (
       id, workspace_id, name, cadence, local_time_minute, weekday,
       action_kind, action_title, action_body, enabled, effective_at,
       revision, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, 'daily', 510, NULL,
               'create-today-task', '检查计划', NULL, 0, NULL,
               1, ?, ?, NULL)`,
    [id, workspaceId, `自动化 ${id}`, T0, T0],
  );
}

function insertTask(database: SqliteAdapter, id: string, workspaceId: string): void {
  database.run(
    `INSERT INTO tasks (
       id, workspace_id, title, status, planned_for, source_inbox_entry_id,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, '自动生成任务', 'todo', '2026-07-23', NULL, ?, ?, NULL)`,
    [id, workspaceId, T0, T0],
  );
}
