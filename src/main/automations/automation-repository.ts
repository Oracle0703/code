import scheduledAutomationsSql from '../../../migrations/0009_scheduled_automations.sql?raw';
import type {
  AutomationAction,
  AutomationItem,
  AutomationLastRun,
  AutomationRunErrorCode,
  AutomationSchedule,
} from '../../shared/contracts';
import {
  AUTOMATION_ACTIVE_GLOBAL_LIMIT,
  AUTOMATION_ENABLED_WORKSPACE_LIMIT,
  normalizeAutomationAction,
  normalizeAutomationId,
  normalizeAutomationName,
  normalizeAutomationRevision,
  normalizeAutomationSchedule,
} from '../../shared/automation-domain';
import { normalizeNoteId } from '../../shared/note-domain';
import { normalizeTaskCivilDate, normalizeTaskId } from '../../shared/task-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';

interface AutomationRow {
  id: unknown;
  workspace_id: unknown;
  name: unknown;
  cadence: unknown;
  local_time_minute: unknown;
  weekday: unknown;
  action_kind: unknown;
  action_title: unknown;
  action_body: unknown;
  enabled: unknown;
  effective_at: unknown;
  revision: unknown;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
  last_attempt_at: unknown;
  last_attempt_occurrence: unknown;
  last_success_at: unknown;
  last_success_occurrence: unknown;
  last_output_kind: unknown;
  last_error_code: unknown;
  consecutive_failures: unknown;
  next_retry_at: unknown;
  run_state_updated_at: unknown;
}

interface OccurrenceRow {
  automation_id: unknown;
  occurrence_date: unknown;
  scheduled_for: unknown;
  definition_revision: unknown;
  completed_at: unknown;
  output_kind: unknown;
  task_id: unknown;
  note_id: unknown;
}

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
}

interface CountRow {
  count: unknown;
}

export interface StoredAutomationRunState {
  readonly lastAttemptAt: string | null;
  readonly lastAttemptOccurrence: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastSuccessOccurrence: string | null;
  readonly lastOutputKind: 'task' | 'note' | null;
  readonly lastErrorCode: AutomationRunErrorCode | null;
  readonly consecutiveFailures: number;
  readonly nextRetryAt: string | null;
  readonly updatedAt: string;
}

export interface StoredAutomation {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly effectiveAt: string | null;
  readonly schedule: AutomationSchedule;
  readonly action: AutomationAction;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly runState: StoredAutomationRunState;
}

export interface NewAutomationRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly schedule: AutomationSchedule;
  readonly action: AutomationAction;
  readonly timestamp: string;
}

export interface AutomationOccurrenceSuccess {
  readonly automationId: string;
  readonly occurrenceDate: string;
  readonly scheduledFor: string;
  readonly definitionRevision: number;
  readonly attemptedAt: string;
  readonly completedAt: string;
  readonly outputKind: 'task' | 'note';
  readonly outputId: string;
}

export interface AutomationFailureRecord {
  readonly automationId: string;
  readonly occurrenceDate: string;
  readonly attemptedAt: string;
  readonly completedAt: string;
  readonly errorCode: AutomationRunErrorCode;
  readonly nextRetryAt: string;
}

const AUTOMATION_SELECT = `
  SELECT
    automation.id,
    automation.workspace_id,
    automation.name,
    automation.cadence,
    automation.local_time_minute,
    automation.weekday,
    automation.action_kind,
    automation.action_title,
    automation.action_body,
    automation.enabled,
    automation.effective_at,
    automation.revision,
    automation.created_at,
    automation.updated_at,
    automation.archived_at,
    run.last_attempt_at,
    run.last_attempt_occurrence,
    run.last_success_at,
    run.last_success_occurrence,
    run.last_output_kind,
    run.last_error_code,
    run.consecutive_failures,
    run.next_retry_at,
    run.updated_at AS run_state_updated_at
  FROM automations AS automation
  JOIN automation_run_state AS run ON run.automation_id = automation.id`;

export class AutomationRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  readWorkspace(workspaceId: string): readonly StoredAutomation[] {
    return this.#database
      .all<AutomationRow>(
        `${AUTOMATION_SELECT}
         WHERE automation.workspace_id = ? AND automation.archived_at IS NULL
         ORDER BY automation.enabled DESC, automation.updated_at DESC, automation.id DESC`,
        [workspaceId],
      )
      .map((row) => mapAutomationRow(row, workspaceId, false));
  }

  readEnabled(): readonly StoredAutomation[] {
    return this.#database
      .all<AutomationRow>(
        `${AUTOMATION_SELECT}
         JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
         WHERE automation.enabled = 1
           AND automation.archived_at IS NULL
           AND workspace.archived_at IS NULL
         ORDER BY automation.id`,
      )
      .map((row) => mapAutomationRow(row, undefined, false));
  }

  findActive(workspaceId: string, automationId: string): StoredAutomation | undefined {
    const row = this.#database.get<AutomationRow>(
      `${AUTOMATION_SELECT}
       WHERE automation.workspace_id = ?
         AND automation.id = ?
         AND automation.archived_at IS NULL`,
      [workspaceId, automationId],
    );
    return row ? mapAutomationRow(row, workspaceId, false) : undefined;
  }

  findEnabled(automationId: string): StoredAutomation | undefined {
    const row = this.#database.get<AutomationRow>(
      `${AUTOMATION_SELECT}
       JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
       WHERE automation.id = ?
         AND automation.enabled = 1
         AND automation.archived_at IS NULL
         AND workspace.archived_at IS NULL`,
      [automationId],
    );
    return row ? mapAutomationRow(row, undefined, false) : undefined;
  }

  countActiveGlobal(): number {
    return readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM automations AS automation
         JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
         WHERE automation.archived_at IS NULL AND workspace.archived_at IS NULL`,
      )?.count,
      'active automation count',
    );
  }

  countEnabled(workspaceId: string): number {
    return readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM automations
         WHERE workspace_id = ? AND enabled = 1 AND archived_at IS NULL`,
        [workspaceId],
      )?.count,
      'enabled automation count',
    );
  }

  insert(record: NewAutomationRecord): void {
    const body = record.action.kind === 'create-note' ? record.action.body : null;
    this.#database.run(
      `INSERT INTO automations (
         id, workspace_id, name, cadence, local_time_minute, weekday,
         action_kind, action_title, action_body, enabled, effective_at,
         revision, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, ?, NULL)`,
      [
        record.id,
        record.workspaceId,
        record.name,
        record.schedule.cadence,
        record.schedule.localTimeMinute,
        record.schedule.weekday,
        record.action.kind,
        record.action.title,
        body,
        record.timestamp,
        record.timestamp,
      ],
    );
  }

  update(
    workspaceId: string,
    automationId: string,
    expectedRevision: number,
    name: string,
    schedule: AutomationSchedule,
    action: AutomationAction,
    timestamp: string,
  ): boolean {
    const body = action.kind === 'create-note' ? action.body : null;
    const result = this.#database.run(
      `UPDATE automations
       SET name = ?,
           cadence = ?,
           local_time_minute = ?,
           weekday = ?,
           action_kind = ?,
           action_title = ?,
           action_body = ?,
           effective_at = CASE WHEN enabled = 1 THEN ? ELSE NULL END,
           revision = revision + 1,
           updated_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND revision = ?
         AND archived_at IS NULL`,
      [
        name,
        schedule.cadence,
        schedule.localTimeMinute,
        schedule.weekday,
        action.kind,
        action.title,
        body,
        timestamp,
        timestamp,
        workspaceId,
        automationId,
        expectedRevision,
      ],
    );
    return Number(result.changes) === 1;
  }

  setEnabled(
    workspaceId: string,
    automationId: string,
    expectedRevision: number,
    enabled: boolean,
    timestamp: string,
  ): boolean {
    const result = this.#database.run(
      `UPDATE automations
       SET enabled = ?,
           effective_at = ?,
           revision = revision + 1,
           updated_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND revision = ?
         AND archived_at IS NULL`,
      [
        enabled ? 1 : 0,
        enabled ? timestamp : null,
        timestamp,
        workspaceId,
        automationId,
        expectedRevision,
      ],
    );
    return Number(result.changes) === 1;
  }

  archive(
    workspaceId: string,
    automationId: string,
    expectedRevision: number,
    timestamp: string,
  ): boolean {
    const result = this.#database.run(
      `UPDATE automations
       SET enabled = 0,
           effective_at = NULL,
           revision = revision + 1,
           updated_at = ?,
           archived_at = ?
       WHERE workspace_id = ?
         AND id = ?
         AND revision = ?
         AND archived_at IS NULL`,
      [timestamp, timestamp, workspaceId, automationId, expectedRevision],
    );
    return Number(result.changes) === 1;
  }

  hasOccurrence(automationId: string, occurrenceDate: string): boolean {
    return (
      this.#database.get<{ present: unknown }>(
        `SELECT 1 AS present
         FROM automation_occurrences
         WHERE automation_id = ? AND occurrence_date = ?`,
        [automationId, occurrenceDate],
      )?.present === 1
    );
  }

  recordSuccess(record: AutomationOccurrenceSuccess): void {
    this.#database.run(
      `INSERT INTO automation_occurrences (
         automation_id, occurrence_date, scheduled_for, definition_revision,
         completed_at, output_kind, task_id, note_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.automationId,
        record.occurrenceDate,
        record.scheduledFor,
        record.definitionRevision,
        record.completedAt,
        record.outputKind,
        record.outputKind === 'task' ? record.outputId : null,
        record.outputKind === 'note' ? record.outputId : null,
      ],
    );
    assertSingleChange(
      this.#database.run(
        `UPDATE automation_run_state
         SET last_attempt_at = ?,
             last_attempt_occurrence = ?,
             last_success_at = ?,
             last_success_occurrence = ?,
             last_output_kind = ?,
             last_error_code = NULL,
             consecutive_failures = 0,
             next_retry_at = NULL,
             updated_at = ?
         WHERE automation_id = ?`,
        [
          record.attemptedAt,
          record.occurrenceDate,
          record.completedAt,
          record.occurrenceDate,
          record.outputKind,
          record.completedAt,
          record.automationId,
        ],
      ).changes,
      'recorded as successful',
    );
  }

  recordFailure(record: AutomationFailureRecord): StoredAutomationRunState {
    assertSingleChange(
      this.#database.run(
        `UPDATE automation_run_state
         SET last_attempt_at = ?,
             last_attempt_occurrence = ?,
             last_error_code = ?,
             consecutive_failures = CASE
               WHEN last_attempt_occurrence = ? AND last_error_code IS NOT NULL
                 THEN consecutive_failures + 1
               ELSE 1
             END,
             next_retry_at = ?,
             updated_at = ?
         WHERE automation_id = ?`,
        [
          record.attemptedAt,
          record.occurrenceDate,
          record.errorCode,
          record.occurrenceDate,
          record.nextRetryAt,
          record.completedAt,
          record.automationId,
        ],
      ).changes,
      'recorded as failed',
    );
    const automation = this.findEnabled(record.automationId);
    if (!automation) {
      throw new DatabaseIntegrityError('The failed automation disappeared while it was recorded.');
    }
    return automation.runState;
  }

  validateSnapshot(): void {
    validateSchema(this.#database);
    const rows = this.#database.all<AutomationRow>(
      `${AUTOMATION_SELECT}
       ORDER BY automation.workspace_id, automation.created_at, automation.id`,
    );
    for (const row of rows) mapAutomationRow(row, undefined, true);

    const automationCount = readCount(
      this.#database.get<CountRow>('SELECT COUNT(*) AS count FROM automations')?.count,
      'automation count',
    );
    const runStateCount = readCount(
      this.#database.get<CountRow>('SELECT COUNT(*) AS count FROM automation_run_state')?.count,
      'automation run-state count',
    );
    if (automationCount !== runStateCount) {
      throw new DatabaseIntegrityError('Every automation must have exactly one run-state row.');
    }
    if (this.countActiveGlobal() > AUTOMATION_ACTIVE_GLOBAL_LIMIT) {
      throw new DatabaseIntegrityError('The active automation limit is exceeded.');
    }
    const enabledCounts = this.#database.all<{ workspace_id: unknown; count: unknown }>(
      `SELECT workspace_id, COUNT(*) AS count
       FROM automations
       WHERE enabled = 1 AND archived_at IS NULL
       GROUP BY workspace_id`,
    );
    for (const row of enabledCounts) {
      normalizeStoredWorkspaceId(row.workspace_id);
      if (
        readCount(row.count, 'workspace enabled automation count') >
        AUTOMATION_ENABLED_WORKSPACE_LIMIT
      ) {
        throw new DatabaseIntegrityError('A workspace enabled automation limit is exceeded.');
      }
    }
    const occurrences = this.#database.all<OccurrenceRow>(
      `SELECT automation_id, occurrence_date, scheduled_for, definition_revision,
              completed_at, output_kind, task_id, note_id
       FROM automation_occurrences
       ORDER BY automation_id, occurrence_date`,
    );
    for (const occurrence of occurrences) validateOccurrence(occurrence);
    const invalidOutputLinks = readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM automation_occurrences AS occurrence
         JOIN automations AS automation ON automation.id = occurrence.automation_id
         LEFT JOIN tasks AS task ON task.id = occurrence.task_id
         LEFT JOIN notes AS note ON note.id = occurrence.note_id
         WHERE (
           occurrence.output_kind = 'task'
           AND (
             automation.action_kind <> 'create-today-task'
             OR occurrence.definition_revision > automation.revision
             OR task.id IS NULL
             OR task.workspace_id <> automation.workspace_id
             OR occurrence.note_id IS NOT NULL
           )
         ) OR (
           occurrence.output_kind = 'note'
           AND (
             automation.action_kind <> 'create-note'
             OR occurrence.definition_revision > automation.revision
             OR note.id IS NULL
             OR note.workspace_id <> automation.workspace_id
             OR occurrence.task_id IS NOT NULL
           )
         )`,
      )?.count,
      'automation output-link violation count',
    );
    if (invalidOutputLinks !== 0) {
      throw new DatabaseIntegrityError('Automation occurrence output links are invalid.');
    }
    const invalidLastSuccessLinks = readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM automation_run_state AS run
         LEFT JOIN automation_occurrences AS occurrence
           ON occurrence.automation_id = run.automation_id
          AND occurrence.occurrence_date = run.last_success_occurrence
         WHERE run.last_success_occurrence IS NOT NULL
           AND (
             occurrence.automation_id IS NULL
             OR occurrence.completed_at <> run.last_success_at
             OR occurrence.output_kind <> run.last_output_kind
           )`,
      )?.count,
      'automation last-success violation count',
    );
    if (invalidLastSuccessLinks !== 0) {
      throw new DatabaseIntegrityError(
        'Automation run state does not match its successful occurrence.',
      );
    }
    const invalidLatestOccurrenceLinks = readCount(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM automation_run_state AS run
         LEFT JOIN (
           SELECT automation_id, MAX(occurrence_date) AS latest_occurrence
           FROM automation_occurrences
           GROUP BY automation_id
         ) AS latest ON latest.automation_id = run.automation_id
         WHERE (
           latest.latest_occurrence IS NULL
           AND run.last_success_occurrence IS NOT NULL
         ) OR (
           latest.latest_occurrence IS NOT NULL
           AND (
             run.last_success_occurrence IS NULL
             OR run.last_success_occurrence <> latest.latest_occurrence
           )
         )`,
      )?.count,
      'automation latest-occurrence violation count',
    );
    if (invalidLatestOccurrenceLinks !== 0) {
      throw new DatabaseIntegrityError(
        'Automation run state does not identify its latest occurrence.',
      );
    }
  }
}

export function toAutomationItem(
  automation: StoredAutomation,
  nextRunAt: string | null,
): AutomationItem {
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    schedule: automation.schedule,
    action: automation.action,
    revision: automation.revision,
    nextRunAt,
    lastRun: toLastRun(automation.runState),
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

function toLastRun(state: StoredAutomationRunState): AutomationLastRun {
  if (state.lastErrorCode !== null && state.lastAttemptAt !== null && state.nextRetryAt !== null) {
    return {
      status: 'failed',
      attemptedAt: state.lastAttemptAt,
      errorCode: state.lastErrorCode,
      consecutiveFailures: state.consecutiveFailures,
      nextRetryAt: state.nextRetryAt,
    };
  }
  if (
    state.lastSuccessAt !== null &&
    state.lastAttemptAt !== null &&
    state.lastOutputKind !== null
  ) {
    return {
      status: 'success',
      attemptedAt: state.lastAttemptAt,
      completedAt: state.lastSuccessAt,
      outputKind: state.lastOutputKind,
    };
  }
  return { status: 'never' };
}

function mapAutomationRow(
  row: AutomationRow,
  expectedWorkspaceId: string | undefined,
  allowArchived: boolean,
): StoredAutomation {
  try {
    const id = normalizeAutomationId(row.id);
    const workspaceId = normalizeWorkspaceId(row.workspace_id);
    if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
      throw new TypeError('Automation workspace does not match.');
    }
    const name = normalizeAutomationName(row.name);
    if (name !== row.name) throw new TypeError('Automation name normalization is invalid.');
    const schedule = normalizeAutomationSchedule({
      cadence: row.cadence,
      localTimeMinute: row.local_time_minute,
      weekday: row.weekday,
    });
    const action = normalizeAutomationAction({
      kind: row.action_kind,
      title: row.action_title,
      ...(row.action_kind === 'create-note' ? { body: row.action_body } : {}),
    });
    if (action.kind === 'create-today-task' && row.action_body !== null) {
      throw new TypeError('Task automation body must be null.');
    }
    const enabled = readBoolean(row.enabled, 'automation enabled state');
    const effectiveAt = readNullableTimestamp(row.effective_at, 'automation effective time');
    if (enabled !== (effectiveAt !== null)) {
      throw new TypeError('Automation enabled state is inconsistent.');
    }
    const revision = normalizeAutomationRevision(row.revision);
    const createdAt = readTimestamp(row.created_at, 'automation creation time');
    const updatedAt = readTimestamp(row.updated_at, 'automation update time');
    const archivedAt = readNullableTimestamp(row.archived_at, 'automation archive time');
    if (updatedAt < createdAt || (archivedAt !== null && updatedAt < archivedAt)) {
      throw new TypeError('Automation timestamps are out of order.');
    }
    if (archivedAt !== null && (enabled || !allowArchived)) {
      throw new TypeError('Archived automation appeared in an active result.');
    }
    const runState = mapRunState(row);
    if (runState.updatedAt < createdAt) {
      throw new TypeError('Automation run state predates its definition.');
    }
    return {
      id,
      workspaceId,
      name,
      enabled,
      effectiveAt,
      schedule,
      action,
      revision,
      createdAt,
      updatedAt,
      archivedAt,
      runState,
    };
  } catch (error) {
    if (error instanceof DatabaseIntegrityError) throw error;
    throw new DatabaseIntegrityError('Automation row contains invalid values.', { cause: error });
  }
}

function mapRunState(row: AutomationRow): StoredAutomationRunState {
  const lastAttemptAt = readNullableTimestamp(row.last_attempt_at, 'automation last attempt time');
  const lastAttemptOccurrence =
    row.last_attempt_occurrence === null
      ? null
      : normalizeTaskCivilDate(row.last_attempt_occurrence);
  const lastSuccessAt = readNullableTimestamp(row.last_success_at, 'automation last success time');
  const lastSuccessOccurrence =
    row.last_success_occurrence === null
      ? null
      : normalizeTaskCivilDate(row.last_success_occurrence);
  const lastOutputKind =
    row.last_output_kind === null
      ? null
      : row.last_output_kind === 'task' || row.last_output_kind === 'note'
        ? row.last_output_kind
        : invalid<'task' | 'note'>('Automation output kind is invalid.');
  const lastErrorCode = readNullableErrorCode(row.last_error_code);
  const consecutiveFailures = readInteger(
    row.consecutive_failures,
    'automation failure count',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const nextRetryAt = readNullableTimestamp(row.next_retry_at, 'automation retry time');
  const updatedAt = readTimestamp(row.run_state_updated_at, 'automation run-state update time');
  if (
    (lastAttemptAt === null) !== (lastAttemptOccurrence === null) ||
    (lastSuccessAt === null) !== (lastSuccessOccurrence === null) ||
    (lastSuccessAt === null) !== (lastOutputKind === null) ||
    (lastErrorCode === null) !== (consecutiveFailures === 0) ||
    (lastErrorCode === null) !== (nextRetryAt === null)
  ) {
    throw new DatabaseIntegrityError('Automation run state is inconsistent.');
  }
  if (
    lastErrorCode === null &&
    lastAttemptAt !== null &&
    (lastSuccessAt === null ||
      lastAttemptOccurrence !== lastSuccessOccurrence ||
      lastAttemptAt > lastSuccessAt)
  ) {
    throw new DatabaseIntegrityError('Automation successful run state is inconsistent.');
  }
  return {
    lastAttemptAt,
    lastAttemptOccurrence,
    lastSuccessAt,
    lastSuccessOccurrence,
    lastOutputKind,
    lastErrorCode,
    consecutiveFailures,
    nextRetryAt,
    updatedAt,
  };
}

function validateOccurrence(row: OccurrenceRow): void {
  try {
    normalizeAutomationId(row.automation_id);
    normalizeTaskCivilDate(row.occurrence_date);
    const scheduledFor = readTimestamp(row.scheduled_for, 'automation scheduled time');
    normalizeAutomationRevision(row.definition_revision);
    const completedAt = readTimestamp(row.completed_at, 'automation completion time');
    if (completedAt < scheduledFor)
      throw new TypeError('Automation completed before its schedule.');
    if (row.output_kind === 'task') {
      normalizeTaskId(row.task_id);
      if (row.note_id !== null) throw new TypeError('Task occurrence contains a note.');
    } else if (row.output_kind === 'note') {
      normalizeNoteId(row.note_id);
      if (row.task_id !== null) throw new TypeError('Note occurrence contains a task.');
    } else {
      throw new TypeError('Automation occurrence output kind is invalid.');
    }
  } catch (error) {
    throw new DatabaseIntegrityError('Automation occurrence contains invalid values.', {
      cause: error,
    });
  }
}

function readNullableErrorCode(value: unknown): AutomationRunErrorCode | null {
  if (value === null) return null;
  if (
    value === 'action-failed' ||
    value === 'database-unavailable' ||
    value === 'workspace-unavailable'
  ) {
    return value;
  }
  throw new DatabaseIntegrityError('Automation run error code is invalid.');
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
    throw new DatabaseIntegrityError('Scheduled automation schema is invalid.');
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
    schemaObject('table', 'automations', 'automations'),
    schemaObject('index', 'automations_active_workspace_order', 'automations'),
    schemaObject('index', 'automations_enabled_schedule', 'automations'),
    schemaObject('table', 'automation_run_state', 'automation_run_state'),
    schemaObject('table', 'automation_occurrences', 'automation_occurrences'),
    schemaObject('index', 'automation_occurrences_completion_order', 'automation_occurrences'),
    schemaObject('trigger', 'automations_require_active_workspace_insert', 'automations'),
    schemaObject('trigger', 'automations_global_active_limit_insert', 'automations'),
    schemaObject('trigger', 'automations_enabled_workspace_limit_insert', 'automations'),
    schemaObject('trigger', 'automations_enabled_workspace_limit_update', 'automations'),
    schemaObject('trigger', 'automations_workspace_is_immutable', 'automations'),
    schemaObject('trigger', 'automations_action_kind_is_immutable', 'automations'),
    schemaObject('trigger', 'automations_revision_must_advance', 'automations'),
    schemaObject('trigger', 'automations_updated_at_must_not_rewind', 'automations'),
    schemaObject('trigger', 'automations_archived_row_is_immutable', 'automations'),
    schemaObject('trigger', 'automations_prevent_archived_workspace_mutation', 'automations'),
    schemaObject('trigger', 'automations_prevent_delete', 'automations'),
    schemaObject('trigger', 'automation_run_state_create_after_automation', 'automations'),
    schemaObject('trigger', 'automation_run_state_automation_is_immutable', 'automation_run_state'),
    schemaObject(
      'trigger',
      'automation_run_state_updated_at_must_not_rewind',
      'automation_run_state',
    ),
    schemaObject('trigger', 'automation_run_state_prevent_delete', 'automation_run_state'),
    schemaObject(
      'trigger',
      'automation_occurrences_validate_output_workspace',
      'automation_occurrences',
    ),
    schemaObject('trigger', 'automation_occurrences_prevent_update', 'automation_occurrences'),
    schemaObject('trigger', 'automation_occurrences_prevent_delete', 'automation_occurrences'),
    schemaObject('trigger', 'workspace_automations_disable_before_archive', 'workspaces'),
  ].sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(
    definitions.map((definition) =>
      Object.freeze({
        ...definition,
        sql: extractAutomationSchemaSql(scheduledAutomationsSql, definition.type, definition.name),
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

export function extractAutomationSchemaSql(
  migrationSql: string,
  type: 'table' | 'index' | 'trigger',
  name: string,
): string {
  const canonicalMigrationSql = migrationSql.replace(/\r\n?/gu, '\n');
  const marker = `CREATE ${type.toUpperCase()} ${name}`;
  const start = canonicalMigrationSql.indexOf(marker);
  if (start < 0) throw new TypeError(`The automation migration is missing ${name}.`);
  const next = canonicalMigrationSql.indexOf('\n\nCREATE ', start + marker.length);
  const statement = canonicalMigrationSql
    .slice(start, next < 0 ? canonicalMigrationSql.length : next)
    .trim();
  return normalizeSchemaSql(statement.endsWith(';') ? statement.slice(0, -1) : statement)!;
}

function normalizeSchemaSql(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim() : undefined;
}

function normalizeStoredWorkspaceId(value: unknown): string {
  try {
    return normalizeWorkspaceId(value);
  } catch (error) {
    throw new DatabaseIntegrityError('Automation workspace identity is invalid.', { cause: error });
  }
}

function readBoolean(value: unknown, name: string): boolean {
  if (value !== 0 && value !== 1) throw new DatabaseIntegrityError(`${name} is invalid.`);
  return value === 1;
}

function readCount(value: unknown, name: string): number {
  return readInteger(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DatabaseIntegrityError(`${name} is invalid.`);
  }
  return value as number;
}

function readTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new DatabaseIntegrityError(`${name} is invalid.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new DatabaseIntegrityError(`${name} is invalid.`);
  }
  return value;
}

function readNullableTimestamp(value: unknown, name: string): string | null {
  return value === null ? null : readTimestamp(value, name);
}

function assertSingleChange(value: unknown, operation: string): void {
  if (Number(value) !== 1) {
    throw new DatabaseIntegrityError(`The automation run could not be ${operation}.`);
  }
}

function invalid<T>(message: string): T {
  throw new DatabaseIntegrityError(message);
}
