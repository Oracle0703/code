import focusSessionsSql from '../../../migrations/0010_focus_sessions.sql?raw';
import type { FocusSession, FocusState } from '../../shared/contracts';
import {
  normalizeFocusRemainingSeconds,
  normalizeFocusRevision,
  normalizeFocusSessionId,
  normalizeFocusState,
  normalizeFocusTimestamp,
} from '../../shared/focus-domain';
import {
  normalizeTaskCivilDate,
  normalizeTaskId,
  normalizeTaskTitle,
} from '../../shared/task-domain';
import { normalizeWorkspaceId, normalizeWorkspaceName } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';

interface FocusRow {
  id: unknown;
  workspace_id: unknown;
  workspace_name: unknown;
  task_id: unknown;
  task_title: unknown;
  local_date: unknown;
  state: unknown;
  remaining_seconds: unknown;
  deadline_at: unknown;
  revision: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
  cancelled_at: unknown;
}

interface CountRow {
  count: unknown;
}

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
}

export interface StoredFocusSession extends FocusSession {
  readonly localDate: string;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
}

export interface NewFocusSessionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
  readonly localDate: string;
  readonly remainingSeconds: number;
  readonly deadlineAt: string;
  readonly timestamp: string;
}

const FOCUS_SELECT = `
  SELECT focus.id,
         focus.workspace_id,
         workspace.name AS workspace_name,
         focus.task_id,
         task.title AS task_title,
         focus.local_date,
         focus.state,
         focus.remaining_seconds,
         focus.deadline_at,
         focus.revision,
         focus.created_at,
         focus.updated_at,
         focus.completed_at,
         focus.cancelled_at
  FROM focus_sessions AS focus
  JOIN workspaces AS workspace ON workspace.id = focus.workspace_id
  LEFT JOIN tasks AS task ON task.id = focus.task_id
`;

export class FocusRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  findOpen(): StoredFocusSession | undefined {
    const rows = this.#database.all<FocusRow>(
      `${FOCUS_SELECT}
       WHERE focus.state IN ('running', 'paused')
       ORDER BY focus.created_at, focus.id`,
    );
    if (rows.length > 1) {
      throw new DatabaseIntegrityError('More than one open focus session exists.');
    }
    return rows[0] ? mapFocusRow(rows[0], true) : undefined;
  }

  find(workspaceId: string, sessionId: string): StoredFocusSession | undefined {
    const row = this.#database.get<FocusRow>(
      `${FOCUS_SELECT}
       WHERE focus.workspace_id = ? AND focus.id = ?`,
      [workspaceId, sessionId],
    );
    return row ? mapFocusRow(row, true) : undefined;
  }

  countCompleted(workspaceId: string, localDate: string): number {
    return readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM focus_sessions
         WHERE workspace_id = ? AND local_date = ? AND state = 'completed'`,
        [workspaceId, localDate],
      )?.count,
      'completed focus session count',
    );
  }

  insert(record: NewFocusSessionRecord): void {
    assertSingleChange(
      this.#database.run(
        `INSERT INTO focus_sessions (
           id, workspace_id, task_id, local_date, state, remaining_seconds,
           deadline_at, revision, created_at, updated_at, completed_at, cancelled_at
         ) VALUES (?, ?, ?, ?, 'running', ?, ?, 1, ?, ?, NULL, NULL)`,
        [
          record.id,
          record.workspaceId,
          record.taskId,
          record.localDate,
          record.remainingSeconds,
          record.deadlineAt,
          record.timestamp,
          record.timestamp,
        ],
      ).changes,
      'created',
    );
  }

  pause(
    workspaceId: string,
    sessionId: string,
    expectedRevision: number,
    remainingSeconds: number,
    timestamp: string,
  ): boolean {
    return (
      Number(
        this.#database.run(
          `UPDATE focus_sessions
           SET state = 'paused',
               remaining_seconds = ?,
               deadline_at = NULL,
               revision = revision + 1,
               updated_at = ?
           WHERE workspace_id = ?
             AND id = ?
             AND state = 'running'
             AND revision = ?`,
          [remainingSeconds, timestamp, workspaceId, sessionId, expectedRevision],
        ).changes,
      ) === 1
    );
  }

  resume(
    workspaceId: string,
    sessionId: string,
    expectedRevision: number,
    deadlineAt: string,
    timestamp: string,
  ): boolean {
    return (
      Number(
        this.#database.run(
          `UPDATE focus_sessions
           SET state = 'running',
               deadline_at = ?,
               revision = revision + 1,
               updated_at = ?
           WHERE workspace_id = ?
             AND id = ?
             AND state = 'paused'
             AND revision = ?`,
          [deadlineAt, timestamp, workspaceId, sessionId, expectedRevision],
        ).changes,
      ) === 1
    );
  }

  checkpointRunning(
    workspaceId: string,
    sessionId: string,
    expectedRevision: number,
    remainingSeconds: number,
    timestamp: string,
  ): boolean {
    return (
      Number(
        this.#database.run(
          `UPDATE focus_sessions
           SET remaining_seconds = ?,
               revision = revision + 1,
               updated_at = ?
           WHERE workspace_id = ?
             AND id = ?
             AND state = 'running'
             AND revision = ?
             AND remaining_seconds > ?`,
          [remainingSeconds, timestamp, workspaceId, sessionId, expectedRevision, remainingSeconds],
        ).changes,
      ) === 1
    );
  }

  complete(
    workspaceId: string,
    sessionId: string,
    expectedRevision: number,
    timestamp: string,
  ): boolean {
    return (
      Number(
        this.#database.run(
          `UPDATE focus_sessions
           SET state = 'completed',
               remaining_seconds = 0,
               deadline_at = NULL,
               revision = revision + 1,
               updated_at = ?,
               completed_at = ?
           WHERE workspace_id = ?
             AND id = ?
             AND state = 'running'
             AND revision = ?`,
          [timestamp, timestamp, workspaceId, sessionId, expectedRevision],
        ).changes,
      ) === 1
    );
  }

  cancel(
    workspaceId: string,
    sessionId: string,
    expectedRevision: number,
    remainingSeconds: number,
    timestamp: string,
  ): boolean {
    return (
      Number(
        this.#database.run(
          `UPDATE focus_sessions
           SET state = 'cancelled',
               remaining_seconds = ?,
               deadline_at = NULL,
               revision = revision + 1,
               updated_at = ?,
               cancelled_at = ?
           WHERE workspace_id = ?
             AND id = ?
             AND state IN ('running', 'paused')
             AND revision = ?`,
          [remainingSeconds, timestamp, timestamp, workspaceId, sessionId, expectedRevision],
        ).changes,
      ) === 1
    );
  }

  validateSnapshot(): void {
    validateSchema(this.#database);
    const rows = this.#database.all<FocusRow>(
      `${FOCUS_SELECT}
       ORDER BY focus.workspace_id, focus.created_at, focus.id`,
    );
    for (const row of rows) mapFocusRow(row, true);
    if (rows.filter((row) => row.state === 'running' || row.state === 'paused').length > 1) {
      throw new DatabaseIntegrityError('More than one open focus session exists.');
    }

    const invalidTaskLinks = readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM focus_sessions AS focus
         LEFT JOIN tasks AS task ON task.id = focus.task_id
         WHERE focus.task_id IS NOT NULL
           AND (task.id IS NULL OR task.workspace_id <> focus.workspace_id)`,
      )?.count,
      'focus task-link violation count',
    );
    if (invalidTaskLinks !== 0) {
      throw new DatabaseIntegrityError('Focus session task links are invalid.');
    }

    const archivedOpen = readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM focus_sessions AS focus
         JOIN workspaces AS workspace ON workspace.id = focus.workspace_id
         WHERE workspace.archived_at IS NOT NULL
           AND focus.state IN ('running', 'paused')`,
      )?.count,
      'archived open focus session count',
    );
    if (archivedOpen !== 0) {
      throw new DatabaseIntegrityError('An archived workspace contains an open focus session.');
    }
  }
}

function mapFocusRow(row: FocusRow, allowTerminal: boolean): StoredFocusSession {
  try {
    const id = normalizeFocusSessionId(row.id);
    const workspaceId = normalizeWorkspaceId(row.workspace_id);
    const workspaceName = normalizeWorkspaceName(row.workspace_name);
    if (workspaceName !== row.workspace_name) {
      throw new TypeError('Focus workspace name normalization is invalid.');
    }
    const taskId = row.task_id === null ? null : normalizeTaskId(row.task_id);
    const taskTitle = row.task_title === null ? null : normalizeTaskTitle(row.task_title);
    if ((taskId === null) !== (taskTitle === null) || taskTitle !== row.task_title) {
      throw new TypeError('Focus task identity is invalid.');
    }
    const localDate = normalizeTaskCivilDate(row.local_date);
    const status = normalizeFocusState(row.state);
    const remainingSeconds = normalizeFocusRemainingSeconds(
      row.remaining_seconds,
      status === 'completed' || status === 'cancelled',
    );
    const deadlineAt =
      row.deadline_at === null ? null : normalizeFocusTimestamp(row.deadline_at, 'Focus deadline');
    const revision = normalizeFocusRevision(row.revision);
    const createdAt = normalizeFocusTimestamp(row.created_at, 'Focus creation time');
    const updatedAt = normalizeFocusTimestamp(row.updated_at, 'Focus update time');
    const completedAt =
      row.completed_at === null
        ? null
        : normalizeFocusTimestamp(row.completed_at, 'Focus completion time');
    const cancelledAt =
      row.cancelled_at === null
        ? null
        : normalizeFocusTimestamp(row.cancelled_at, 'Focus cancellation time');
    if (
      updatedAt < createdAt ||
      (completedAt !== null && (completedAt < createdAt || completedAt > updatedAt)) ||
      (cancelledAt !== null && (cancelledAt < createdAt || cancelledAt > updatedAt))
    ) {
      throw new TypeError('Focus timestamps are out of order.');
    }
    assertStateShape(status, remainingSeconds, deadlineAt, completedAt, cancelledAt);
    if (!allowTerminal && (status === 'completed' || status === 'cancelled')) {
      throw new TypeError('A terminal focus session appeared in an open result.');
    }
    return {
      id,
      workspaceId,
      workspaceName,
      taskId,
      taskTitle,
      status,
      remainingSeconds,
      deadlineAt,
      revision,
      createdAt,
      updatedAt,
      localDate,
      completedAt,
      cancelledAt,
    };
  } catch (error) {
    if (error instanceof DatabaseIntegrityError) throw error;
    throw new DatabaseIntegrityError('Focus session row contains invalid values.', {
      cause: error,
    });
  }
}

function assertStateShape(
  state: FocusState,
  remainingSeconds: number,
  deadlineAt: string | null,
  completedAt: string | null,
  cancelledAt: string | null,
): void {
  const valid =
    (state === 'running' &&
      remainingSeconds > 0 &&
      deadlineAt !== null &&
      completedAt === null &&
      cancelledAt === null) ||
    (state === 'paused' &&
      remainingSeconds > 0 &&
      deadlineAt === null &&
      completedAt === null &&
      cancelledAt === null) ||
    (state === 'completed' &&
      remainingSeconds === 0 &&
      deadlineAt === null &&
      completedAt !== null &&
      cancelledAt === null) ||
    (state === 'cancelled' && deadlineAt === null && completedAt === null && cancelledAt !== null);
  if (!valid) throw new TypeError('Focus session state is inconsistent.');
}

function validateSchema(database: SqliteAdapter): void {
  const rows = database.all<SchemaObjectRow>(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE name IN (${REQUIRED_SCHEMA_OBJECTS.map(() => '?').join(', ')})
     ORDER BY name`,
    REQUIRED_SCHEMA_OBJECTS.map(({ name }) => name),
  );
  if (
    rows.length !== REQUIRED_SCHEMA_OBJECTS.length ||
    rows.some((row, index) => {
      const expected = REQUIRED_SCHEMA_OBJECTS[index];
      return (
        !expected ||
        row.type !== expected.type ||
        row.name !== expected.name ||
        row.tbl_name !== expected.tableName ||
        normalizeSchemaSql(row.sql) !== expected.sql
      );
    })
  ) {
    throw new DatabaseIntegrityError('Focus session schema is invalid.');
  }
}

const REQUIRED_SCHEMA_OBJECTS = createRequiredSchemaObjects();

function createRequiredSchemaObjects(): readonly {
  readonly type: 'table' | 'index' | 'trigger';
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}[] {
  const definitions = [
    schemaObject('table', 'focus_sessions', 'focus_sessions'),
    schemaObject('index', 'focus_sessions_single_open', 'focus_sessions'),
    schemaObject('index', 'focus_sessions_workspace_history', 'focus_sessions'),
    schemaObject('index', 'focus_sessions_workspace_day_state', 'focus_sessions'),
    schemaObject('index', 'focus_sessions_task_history', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_require_active_workspace_insert', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_validate_task_workspace_insert', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_workspace_is_immutable', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_task_is_immutable', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_local_date_is_immutable', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_created_at_is_immutable', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_revision_must_advance', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_updated_at_must_not_rewind', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_state_transition_is_valid', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_terminal_row_is_immutable', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_prevent_archived_workspace_mutation', 'focus_sessions'),
    schemaObject('trigger', 'focus_sessions_prevent_delete', 'focus_sessions'),
    schemaObject('trigger', 'workspace_focus_session_cancel_before_archive', 'workspaces'),
  ].sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(
    definitions.map((definition) =>
      Object.freeze({
        ...definition,
        sql: extractFocusSchemaSql(focusSessionsSql, definition.type, definition.name),
      }),
    ),
  );
}

function schemaObject(
  type: 'table' | 'index' | 'trigger',
  name: string,
  tableName: string,
): {
  readonly type: 'table' | 'index' | 'trigger';
  readonly name: string;
  readonly tableName: string;
} {
  return { type, name, tableName };
}

export function extractFocusSchemaSql(
  migrationSql: string,
  type: 'table' | 'index' | 'trigger',
  name: string,
): string {
  const canonicalMigrationSql = migrationSql.replace(/\r\n?/gu, '\n');
  const markers =
    type === 'index'
      ? [`CREATE INDEX ${name}`, `CREATE UNIQUE INDEX ${name}`]
      : [`CREATE ${type.toUpperCase()} ${name}`];
  const start = markers
    .map((marker) => canonicalMigrationSql.indexOf(marker))
    .filter((position) => position >= 0)
    .sort((left, right) => left - right)[0];
  if (start === undefined) throw new TypeError(`The focus migration is missing ${name}.`);
  const next = canonicalMigrationSql.indexOf('\n\nCREATE ', start + 1);
  const statement = canonicalMigrationSql
    .slice(start, next < 0 ? canonicalMigrationSql.length : next)
    .trim();
  return normalizeSchemaSql(statement.endsWith(';') ? statement.slice(0, -1) : statement)!;
}

function normalizeSchemaSql(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim() : undefined;
}

function readCount(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DatabaseIntegrityError(`${name} is invalid.`);
  }
  return value as number;
}

function assertSingleChange(value: unknown, operation: string): void {
  if (Number(value) !== 1) {
    throw new DatabaseIntegrityError(`The focus session could not be ${operation}.`);
  }
}
