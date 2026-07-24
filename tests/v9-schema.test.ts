import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import scheduledAutomationsSql from '../migrations/0009_scheduled_automations.sql?raw';
import {
  AutomationRepository,
  extractAutomationSchemaSql,
} from '../src/main/automations/automation-repository';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { DatabaseIntegrityError } from '../src/main/database/errors';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const T0 = '2026-07-23T08:00:00.000Z';
const T1 = '2026-07-23T09:00:00.000Z';
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

describe('v9 scheduled automation schema', () => {
  it('extracts the same canonical schema from LF and Windows CRLF raw imports', () => {
    const windowsSql = scheduledAutomationsSql.replace(/\r?\n/gu, '\r\n');
    expect(extractAutomationSchemaSql(windowsSql, 'table', 'automations')).toBe(
      extractAutomationSchemaSql(scheduledAutomationsSql, 'table', 'automations'),
    );
  });

  it('registers v9 after terminal preferences and creates the three state tables', async () => {
    const database = await createDatabase();
    expect(new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 9)).apply(database)).toMatchObject({
      fromVersion: 0,
      toVersion: 9,
    });
    expect(DEFAULT_MIGRATIONS[8]).toMatchObject({
      version: 9,
      name: 'scheduled_automations',
    });
    expect(
      database.all<{ name: string }>(
        `SELECT name
         FROM sqlite_schema
         WHERE type = 'table'
           AND name IN ('automations', 'automation_run_state', 'automation_occurrences')
         ORDER BY name`,
      ),
    ).toEqual([
      { name: 'automation_occurrences' },
      { name: 'automation_run_state' },
      { name: 'automations' },
    ]);
    database.close();
  });

  it('creates disabled definitions with exactly one empty run state', async () => {
    const database = await createV9Database();
    insertWorkspace(database, WORKSPACE_ID, '自动化');
    const automationId = randomUUID();
    insertAutomation(database, automationId);

    expect(
      database.get<Record<string, unknown>>(
        `SELECT enabled, effective_at, revision, archived_at
         FROM automations WHERE id = ?`,
        [automationId],
      ),
    ).toEqual({ enabled: 0, effective_at: null, revision: 1, archived_at: null });
    expect(
      database.get<Record<string, unknown>>(
        `SELECT last_attempt_at, last_success_at, last_error_code,
                consecutive_failures, next_retry_at
         FROM automation_run_state WHERE automation_id = ?`,
        [automationId],
      ),
    ).toEqual({
      last_attempt_at: null,
      last_success_at: null,
      last_error_code: null,
      consecutive_failures: 0,
      next_retry_at: null,
    });
    expect(() => new AutomationRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('enforces action immutability, workspace enable limits, and archive shutdown', async () => {
    const database = await createV9Database();
    insertWorkspace(database, WORKSPACE_ID, '自动化');
    insertWorkspace(database, OTHER_WORKSPACE_ID, '保留');

    const ids = Array.from({ length: 26 }, () => randomUUID());
    for (const id of ids) insertAutomation(database, id);
    for (const id of ids.slice(0, 25)) {
      database.run(
        `UPDATE automations
         SET enabled = 1, effective_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        [T1, T1, id],
      );
    }
    expect(() =>
      database.run(
        `UPDATE automations
         SET enabled = 1, effective_at = ?, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        [T1, T1, ids[25]],
      ),
    ).toThrow(/enabled automation limit/u);
    expect(() =>
      database.run(
        `UPDATE automations
         SET action_kind = 'create-note', action_body = '',
             revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        [T1, ids[0]],
      ),
    ).toThrow(/action kind is immutable/u);

    database.run(
      `UPDATE workspaces
       SET archived_at = ?, updated_at = ?
       WHERE id = ?`,
      [T1, T1, WORKSPACE_ID],
    );
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM automations
         WHERE workspace_id = ? AND enabled = 1`,
        [WORKSPACE_ID],
      ),
    ).toEqual({ count: 0 });
    expect(() => new AutomationRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('allows archived history beyond the one-hundred active definition limit', async () => {
    const database = await createV9Database();
    insertWorkspace(database, WORKSPACE_ID, '自动化');
    for (let index = 0; index < 100; index += 1) {
      insertAutomation(database, randomUUID());
    }
    expect(() => insertArchivedAutomation(database, randomUUID())).not.toThrow();
    expect(() => insertAutomation(database, randomUUID())).toThrow(/active automation limit/u);
    expect(() => new AutomationRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('rejects a canonical trigger replaced by a weaker trigger with the same name', async () => {
    const database = await createV9Database();
    insertWorkspace(database, WORKSPACE_ID, '自动化');
    insertAutomation(database, randomUUID());
    database.exec('DROP TRIGGER automations_action_kind_is_immutable');
    database.exec(`
      CREATE TRIGGER automations_action_kind_is_immutable
      BEFORE UPDATE OF action_kind ON automations
      BEGIN
        SELECT 1;
      END;
    `);
    expect(() => new AutomationRepository(database).validateSnapshot()).toThrow(
      DatabaseIntegrityError,
    );
    database.close();
  });

  it('requires every last-success watermark to reference its exact immutable occurrence', async () => {
    const database = await createV9Database();
    insertWorkspace(database, WORKSPACE_ID, '自动化');
    const automationId = randomUUID();
    const taskId = randomUUID();
    insertAutomation(database, automationId);
    insertTask(database, taskId, WORKSPACE_ID);
    database.run(
      `INSERT INTO automation_occurrences (
         automation_id, occurrence_date, scheduled_for, definition_revision,
         completed_at, output_kind, task_id, note_id
       ) VALUES (?, '2026-07-23', ?, 1, ?, 'task', ?, NULL)`,
      [automationId, T0, T1, taskId],
    );
    database.run(
      `UPDATE automation_run_state
       SET last_attempt_at = ?,
           last_attempt_occurrence = '2026-07-23',
           last_success_at = ?,
           last_success_occurrence = '2026-07-23',
           last_output_kind = 'task',
           updated_at = ?
       WHERE automation_id = ?`,
      [T0, T1, T1, automationId],
    );
    expect(() => new AutomationRepository(database).validateSnapshot()).not.toThrow();

    database.run(
      `UPDATE automation_run_state
       SET last_attempt_at = NULL,
           last_attempt_occurrence = NULL,
           last_success_at = NULL,
           last_success_occurrence = NULL,
           last_output_kind = NULL
       WHERE automation_id = ?`,
      [automationId],
    );
    expect(() => new AutomationRepository(database).validateSnapshot()).toThrow(
      /does not identify its latest occurrence/u,
    );

    database.run(
      `UPDATE automation_run_state
       SET last_attempt_at = ?,
           last_attempt_occurrence = '2026-07-23',
           last_success_at = ?,
           last_success_occurrence = '2026-07-23',
           last_output_kind = 'task'
       WHERE automation_id = ?`,
      [T0, T1, automationId],
    );
    const newerTaskId = randomUUID();
    insertTask(database, newerTaskId, WORKSPACE_ID);
    database.run(
      `INSERT INTO automation_occurrences (
         automation_id, occurrence_date, scheduled_for, definition_revision,
         completed_at, output_kind, task_id, note_id
       ) VALUES (?, '2026-07-24', ?, 1, ?, 'task', ?, NULL)`,
      [automationId, '2026-07-24T08:30:00.000Z', '2026-07-24T09:00:00.000Z', newerTaskId],
    );
    expect(() => new AutomationRepository(database).validateSnapshot()).toThrow(
      /does not identify its latest occurrence/u,
    );
    database.close();
  });

  it('rejects an occurrence from a definition revision that never existed', async () => {
    const database = await createV9Database();
    insertWorkspace(database, WORKSPACE_ID, '自动化');
    const automationId = randomUUID();
    const taskId = randomUUID();
    insertAutomation(database, automationId);
    insertTask(database, taskId, WORKSPACE_ID);

    expect(() =>
      database.run(
        `INSERT INTO automation_occurrences (
           automation_id, occurrence_date, scheduled_for, definition_revision,
           completed_at, output_kind, task_id, note_id
         ) VALUES (?, '2026-07-23', ?, 2, ?, 'task', ?, NULL)`,
        [automationId, T0, T1, taskId],
      ),
    ).toThrow(/automation output/u);
    expect(() => new AutomationRepository(database).validateSnapshot()).not.toThrow();
    database.close();
  });

  it('detects an occurrence linked to output in a different workspace after triggers are restored', async () => {
    const database = await createV9Database();
    insertWorkspace(database, WORKSPACE_ID, '自动化');
    insertWorkspace(database, OTHER_WORKSPACE_ID, '其他');
    const automationId = randomUUID();
    const taskId = randomUUID();
    insertAutomation(database, automationId);
    insertTask(database, taskId, OTHER_WORKSPACE_ID);
    database.exec('DROP TRIGGER automation_occurrences_validate_output_workspace');
    database.run(
      `INSERT INTO automation_occurrences (
         automation_id, occurrence_date, scheduled_for, definition_revision,
         completed_at, output_kind, task_id, note_id
       ) VALUES (?, '2026-07-23', ?, 1, ?, 'task', ?, NULL)`,
      [automationId, T0, T1, taskId],
    );
    database.exec(`
      CREATE TRIGGER automation_occurrences_validate_output_workspace
      BEFORE INSERT ON automation_occurrences
      WHEN (
        NEW.output_kind = 'task'
        AND NOT EXISTS (
          SELECT 1
          FROM tasks AS task
          JOIN automations AS automation ON automation.id = NEW.automation_id
          WHERE task.id = NEW.task_id
            AND task.workspace_id = automation.workspace_id
            AND automation.action_kind = 'create-today-task'
            AND NEW.definition_revision <= automation.revision
        )
      ) OR (
        NEW.output_kind = 'note'
        AND NOT EXISTS (
          SELECT 1
          FROM notes AS note
          JOIN automations AS automation ON automation.id = NEW.automation_id
          WHERE note.id = NEW.note_id
            AND note.workspace_id = automation.workspace_id
            AND automation.action_kind = 'create-note'
            AND NEW.definition_revision <= automation.revision
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'automation output does not match its workspace or action');
      END;
    `);
    expect(() => new AutomationRepository(database).validateSnapshot()).toThrow(
      /output links are invalid/u,
    );
    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-v9-schema-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'database.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createV9Database(): Promise<SqliteAdapter> {
  const database = await createDatabase();
  new MigrationRunner(DEFAULT_MIGRATIONS.slice(0, 9)).apply(database);
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

function insertAutomation(database: SqliteAdapter, id: string): void {
  database.run(
    `INSERT INTO automations (
       id, workspace_id, name, cadence, local_time_minute, weekday,
       action_kind, action_title, action_body, enabled, effective_at,
       revision, created_at, updated_at, archived_at
     ) VALUES (?, ?, '每日计划', 'daily', 510, NULL,
               'create-today-task', '检查计划', NULL, 0, NULL,
               1, ?, ?, NULL)`,
    [id, WORKSPACE_ID, T0, T0],
  );
}

function insertArchivedAutomation(database: SqliteAdapter, id: string): void {
  database.run(
    `INSERT INTO automations (
       id, workspace_id, name, cadence, local_time_minute, weekday,
       action_kind, action_title, action_body, enabled, effective_at,
       revision, created_at, updated_at, archived_at
     ) VALUES (?, ?, '历史自动化', 'daily', 510, NULL,
               'create-today-task', '历史任务', NULL, 0, NULL,
               1, ?, ?, ?)`,
    [id, WORKSPACE_ID, T0, T1, T1],
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
