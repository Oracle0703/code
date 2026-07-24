import workspaceRecoverySql from '../../../migrations/0011_workspace_recovery.sql?raw';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_THEMES,
  WORKSPACE_VIEW_IDS,
  type ArchivedWorkspaceInfo,
  type WorkspaceColor,
  type WorkspaceArchiveSnapshot,
  type WorkspaceInfo,
  type WorkspacePreferences,
  type WorkspaceSnapshot,
  type WorkspaceTheme,
  type WorkspaceViewId,
} from '../../shared/contracts';
import {
  createWorkspaceNameKey,
  normalizeWorkspaceColor,
  normalizeWorkspaceId,
  normalizeWorkspaceName,
} from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';

interface CountRow {
  count: unknown;
}

interface WorkspaceRow {
  id: unknown;
  name: unknown;
  name_key: unknown;
  color: unknown;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
}

interface ArchivedWorkspaceRow extends WorkspaceRow {
  recovery_revision: unknown;
}

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
}

interface WorkspaceStateRow {
  singleton: unknown;
  current_workspace_id: unknown;
  updated_at: unknown;
}

interface WorkspacePreferencesRow {
  workspace_id: unknown;
  active_view: unknown;
  theme: unknown;
  sidebar_collapsed: unknown;
  browser_open: unknown;
  browser_width: unknown;
  terminal_open: unknown;
  terminal_height: unknown;
  updated_at: unknown;
}

export interface NewWorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly color: WorkspaceColor;
  readonly timestamp: string;
}

export class WorkspaceRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  countAll(): number {
    return this.#readCount('SELECT COUNT(*) AS count FROM workspaces');
  }

  countActive(): number {
    return this.#readCount('SELECT COUNT(*) AS count FROM workspaces WHERE archived_at IS NULL');
  }

  countPreferences(): number {
    return this.#readCount('SELECT COUNT(*) AS count FROM workspace_preferences');
  }

  countStateRows(): number {
    return this.#readCount('SELECT COUNT(*) AS count FROM workspace_app_state');
  }

  countRecoveryRevisions(): number {
    return this.#readCount('SELECT COUNT(*) AS count FROM workspace_recovery_revisions');
  }

  countInvalidRecoveryRevisions(): number {
    return this.#readCount(
      `SELECT COUNT(*) AS count
       FROM workspace_recovery_revisions AS recovery
       JOIN workspaces AS workspace ON workspace.id = recovery.workspace_id
       WHERE (workspace.archived_at IS NULL AND recovery.revision % 2 = 0)
          OR (workspace.archived_at IS NOT NULL AND recovery.revision % 2 = 1)`,
    );
  }

  countActiveAutomationDefinitions(): number {
    return this.#readCount(
      `SELECT COUNT(*) AS count
       FROM automations AS automation
       JOIN workspaces AS workspace ON workspace.id = automation.workspace_id
       WHERE automation.archived_at IS NULL
         AND workspace.archived_at IS NULL`,
    );
  }

  countRestorableAutomationDefinitions(workspaceId: string): number {
    return readNonNegativeInteger(
      this.#database.get<CountRow>(
        `SELECT COUNT(*) AS count
         FROM automations
         WHERE workspace_id = ?
           AND archived_at IS NULL`,
        [workspaceId],
      )?.count,
      'restorable automation count',
    );
  }

  listActive(): WorkspaceInfo[] {
    return this.#database
      .all<WorkspaceRow>(
        `SELECT id, name, name_key, color, created_at, updated_at, archived_at
         FROM workspaces
         WHERE archived_at IS NULL
         ORDER BY created_at, id`,
      )
      .map((row) => mapWorkspace(row, false));
  }

  listArchived(): ArchivedWorkspaceInfo[] {
    return this.#database
      .all<ArchivedWorkspaceRow>(
        `SELECT workspace.id, workspace.name, workspace.name_key, workspace.color,
                workspace.created_at, workspace.updated_at, workspace.archived_at,
                recovery.revision AS recovery_revision
         FROM workspaces AS workspace
         JOIN workspace_recovery_revisions AS recovery
           ON recovery.workspace_id = workspace.id
         WHERE workspace.archived_at IS NOT NULL
         ORDER BY workspace.archived_at DESC, workspace.created_at, workspace.id`,
      )
      .map(mapArchivedWorkspace);
  }

  findActive(workspaceId: string): WorkspaceInfo | undefined {
    const row = this.#database.get<WorkspaceRow>(
      `SELECT id, name, name_key, color, created_at, updated_at, archived_at
       FROM workspaces
       WHERE id = ? AND archived_at IS NULL`,
      [workspaceId],
    );
    return row ? mapWorkspace(row, false) : undefined;
  }

  findArchived(workspaceId: string): ArchivedWorkspaceInfo | undefined {
    const row = this.#database.get<ArchivedWorkspaceRow>(
      `SELECT workspace.id, workspace.name, workspace.name_key, workspace.color,
              workspace.created_at, workspace.updated_at, workspace.archived_at,
              recovery.revision AS recovery_revision
       FROM workspaces AS workspace
       JOIN workspace_recovery_revisions AS recovery
         ON recovery.workspace_id = workspace.id
       WHERE workspace.id = ? AND workspace.archived_at IS NOT NULL`,
      [workspaceId],
    );
    return row ? mapArchivedWorkspace(row) : undefined;
  }

  findFallback(excludedWorkspaceId: string): WorkspaceInfo | undefined {
    const row = this.#database.get<WorkspaceRow>(
      `SELECT id, name, name_key, color, created_at, updated_at, archived_at
       FROM workspaces
       WHERE archived_at IS NULL AND id <> ?
       ORDER BY created_at, id
       LIMIT 1`,
      [excludedWorkspaceId],
    );
    return row ? mapWorkspace(row, false) : undefined;
  }

  activeNameExists(name: string, excludingWorkspaceId?: string): boolean {
    const nameKey = createWorkspaceNameKey(name);
    const row = excludingWorkspaceId
      ? this.#database.get<CountRow>(
          `SELECT COUNT(*) AS count
           FROM workspaces
           WHERE archived_at IS NULL AND name_key = ? AND id <> ?`,
          [nameKey, excludingWorkspaceId],
        )
      : this.#database.get<CountRow>(
          `SELECT COUNT(*) AS count
           FROM workspaces
           WHERE archived_at IS NULL AND name_key = ?`,
          [nameKey],
        );
    return readNonNegativeInteger(row?.count, 'workspace name count') > 0;
  }

  insertWorkspace(record: NewWorkspaceRecord): void {
    this.#database.run(
      `INSERT INTO workspaces (
         id, name, name_key, color, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [
        record.id,
        record.name,
        createWorkspaceNameKey(record.name),
        record.color,
        record.timestamp,
        record.timestamp,
      ],
    );
    this.#database.run(
      `INSERT INTO workspace_preferences (
         workspace_id, active_view, theme, sidebar_collapsed, browser_open,
         browser_width, terminal_open, terminal_height, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        DEFAULT_WORKSPACE_PREFERENCES.activeView,
        DEFAULT_WORKSPACE_PREFERENCES.theme,
        toSqlBoolean(DEFAULT_WORKSPACE_PREFERENCES.sidebarCollapsed),
        toSqlBoolean(DEFAULT_WORKSPACE_PREFERENCES.browserOpen),
        DEFAULT_WORKSPACE_PREFERENCES.browserWidth,
        toSqlBoolean(DEFAULT_WORKSPACE_PREFERENCES.terminalOpen),
        DEFAULT_WORKSPACE_PREFERENCES.terminalHeight,
        record.timestamp,
      ],
    );
  }

  insertState(workspaceId: string, timestamp: string): void {
    this.#database.run(
      `INSERT INTO workspace_app_state (singleton, current_workspace_id, updated_at)
       VALUES (1, ?, ?)`,
      [workspaceId, timestamp],
    );
  }

  setCurrent(workspaceId: string, timestamp: string): void {
    const result = this.#database.run(
      `UPDATE workspace_app_state
       SET current_workspace_id = ?, updated_at = ?
       WHERE singleton = 1`,
      [workspaceId, timestamp],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseIntegrityError('Workspace selection state is missing.');
    }
  }

  rename(workspaceId: string, name: string, timestamp: string): void {
    const result = this.#database.run(
      `UPDATE workspaces
       SET name = ?, name_key = ?, updated_at = ?
       WHERE id = ? AND archived_at IS NULL`,
      [name, createWorkspaceNameKey(name), timestamp, workspaceId],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseIntegrityError('The active workspace could not be renamed.');
    }
  }

  archive(workspaceId: string, timestamp: string): void {
    const result = this.#database.run(
      `UPDATE workspaces
       SET archived_at = ?, updated_at = ?
       WHERE id = ? AND archived_at IS NULL`,
      [timestamp, timestamp, workspaceId],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseIntegrityError('The active workspace could not be archived.');
    }
  }

  restore(workspaceId: string, expectedRevision: number, name: string, timestamp: string): void {
    const result = this.#database.run(
      `UPDATE workspaces
       SET name = ?, name_key = ?, updated_at = ?, archived_at = NULL
       WHERE id = ?
         AND archived_at IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM workspace_recovery_revisions
           WHERE workspace_id = workspaces.id
             AND revision = ?
         )`,
      [name, createWorkspaceNameKey(name), timestamp, workspaceId, expectedRevision],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseIntegrityError('The archived workspace could not be restored.');
    }
    const revision = this.#database.get<{ revision: unknown }>(
      `SELECT revision
       FROM workspace_recovery_revisions
       WHERE workspace_id = ?`,
      [workspaceId],
    )?.revision;
    if (readPositiveSafeInteger(revision, 'workspace recovery revision') !== expectedRevision + 1) {
      throw new DatabaseIntegrityError('The workspace recovery revision did not advance.');
    }
  }

  readCurrentWorkspaceId(): string {
    const rows = this.#database.all<WorkspaceStateRow>(
      `SELECT singleton, current_workspace_id, updated_at
       FROM workspace_app_state`,
    );
    if (rows.length !== 1) {
      throw new DatabaseIntegrityError('Workspace selection state must contain one row.');
    }
    const row = rows[0];
    if (row.singleton !== 1 || !isIsoTimestamp(row.updated_at)) {
      throw new DatabaseIntegrityError('Workspace selection state is invalid.');
    }
    try {
      return normalizeWorkspaceId(row.current_workspace_id);
    } catch (error) {
      throw new DatabaseIntegrityError('Workspace selection id is invalid.', { cause: error });
    }
  }

  readPreferences(workspaceId: string): WorkspacePreferences {
    const row = this.#database.get<WorkspacePreferencesRow>(
      `SELECT workspace_id, active_view, theme, sidebar_collapsed, browser_open,
              browser_width, terminal_open, terminal_height, updated_at
       FROM workspace_preferences
       WHERE workspace_id = ?`,
      [workspaceId],
    );
    if (!row) {
      throw new DatabaseIntegrityError('Workspace preferences are missing.');
    }
    return mapPreferences(row, workspaceId);
  }

  updatePreferences(
    workspaceId: string,
    preferences: WorkspacePreferences,
    timestamp: string,
  ): void {
    const result = this.#database.run(
      `UPDATE workspace_preferences
       SET active_view = ?, theme = ?, sidebar_collapsed = ?, browser_open = ?,
           browser_width = ?, terminal_open = ?, terminal_height = ?, updated_at = ?
       WHERE workspace_id = ?`,
      [
        preferences.activeView,
        preferences.theme,
        toSqlBoolean(preferences.sidebarCollapsed),
        toSqlBoolean(preferences.browserOpen),
        preferences.browserWidth,
        toSqlBoolean(preferences.terminalOpen),
        preferences.terminalHeight,
        timestamp,
        workspaceId,
      ],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseIntegrityError('Workspace preferences could not be updated.');
    }
  }

  readSnapshot(): WorkspaceSnapshot {
    const workspaces = this.listActive();
    if (workspaces.length === 0) {
      throw new DatabaseIntegrityError('At least one active workspace is required.');
    }
    const currentWorkspaceId = this.readCurrentWorkspaceId();
    if (!workspaces.some(({ id }) => id === currentWorkspaceId)) {
      throw new DatabaseIntegrityError('Current workspace must be active.');
    }
    return {
      currentWorkspaceId,
      workspaces,
      preferences: this.readPreferences(currentWorkspaceId),
    };
  }

  readArchiveSnapshot(): WorkspaceArchiveSnapshot {
    return { archivedWorkspaces: this.listArchived() };
  }

  validateIntegrity(requireRecoverySchema = true): WorkspaceSnapshot {
    if (requireRecoverySchema) {
      validateRecoverySchema(this.#database);
    }
    const workspaceRows = this.#database.all<WorkspaceRow>(
      `SELECT id, name, name_key, color, created_at, updated_at, archived_at
       FROM workspaces
       ORDER BY created_at, id`,
    );
    if (workspaceRows.length === 0) {
      throw new DatabaseIntegrityError('Workspace data is empty.');
    }
    for (const row of workspaceRows) {
      mapWorkspace(row, true);
    }
    if (this.countPreferences() !== workspaceRows.length) {
      throw new DatabaseIntegrityError('Every workspace must have exactly one preference row.');
    }
    if (requireRecoverySchema && this.countRecoveryRevisions() !== workspaceRows.length) {
      throw new DatabaseIntegrityError(
        'Every workspace must have exactly one recovery revision row.',
      );
    }
    if (requireRecoverySchema && this.countInvalidRecoveryRevisions() !== 0) {
      throw new DatabaseIntegrityError(
        'Workspace recovery revisions do not match their archive state.',
      );
    }
    for (const row of workspaceRows) {
      const workspaceId = readWorkspaceId(row.id);
      this.readPreferences(workspaceId);
    }
    return this.readSnapshot();
  }

  #readCount(sql: string): number {
    return readNonNegativeInteger(this.#database.get<CountRow>(sql)?.count, 'workspace row count');
  }
}

function mapWorkspace(row: WorkspaceRow, allowArchived: boolean): WorkspaceInfo {
  const id = readWorkspaceId(row.id);
  let name: string;
  let color: WorkspaceColor;
  try {
    name = normalizeWorkspaceName(row.name);
    color = normalizeWorkspaceColor(row.color);
  } catch (error) {
    throw new DatabaseIntegrityError('Workspace row contains invalid values.', { cause: error });
  }
  if (row.name !== name || row.name_key !== createWorkspaceNameKey(name)) {
    throw new DatabaseIntegrityError('Workspace name normalization is invalid.');
  }
  if (!isIsoTimestamp(row.created_at) || !isIsoTimestamp(row.updated_at)) {
    throw new DatabaseIntegrityError('Workspace timestamps are invalid.');
  }
  if (row.archived_at !== null && !isIsoTimestamp(row.archived_at)) {
    throw new DatabaseIntegrityError('Workspace archive timestamp is invalid.');
  }
  if (
    row.updated_at < row.created_at ||
    (row.archived_at !== null && row.updated_at < row.archived_at)
  ) {
    throw new DatabaseIntegrityError('Workspace timestamp order is invalid.');
  }
  if (!allowArchived && row.archived_at !== null) {
    throw new DatabaseIntegrityError('An archived workspace appeared in the active list.');
  }
  return { id, name, color, createdAt: row.created_at, updatedAt: row.updated_at };
}

function mapArchivedWorkspace(row: ArchivedWorkspaceRow): ArchivedWorkspaceInfo {
  const workspace = mapWorkspace(row, true);
  if (!isIsoTimestamp(row.archived_at)) {
    throw new DatabaseIntegrityError('An active workspace appeared in the archive list.');
  }
  const revision = readPositiveSafeInteger(row.recovery_revision, 'workspace recovery revision');
  if (revision % 2 !== 0) {
    throw new DatabaseIntegrityError('An archived workspace has an invalid recovery revision.');
  }
  return {
    ...workspace,
    archivedAt: row.archived_at,
    revision,
  };
}

function mapPreferences(
  row: WorkspacePreferencesRow,
  expectedWorkspaceId: string,
): WorkspacePreferences {
  if (
    readWorkspaceId(row.workspace_id) !== expectedWorkspaceId ||
    !isIsoTimestamp(row.updated_at)
  ) {
    throw new DatabaseIntegrityError('Workspace preference identity is invalid.');
  }
  if (
    typeof row.active_view !== 'string' ||
    !WORKSPACE_VIEW_IDS.includes(row.active_view as WorkspaceViewId) ||
    typeof row.theme !== 'string' ||
    !WORKSPACE_THEMES.includes(row.theme as WorkspaceTheme)
  ) {
    throw new DatabaseIntegrityError('Workspace preference enum is invalid.');
  }
  const browserWidth = readIntegerInRange(row.browser_width, 'browser width', 340, 720);
  const terminalHeight = readIntegerInRange(row.terminal_height, 'terminal height', 180, 2160);
  return {
    activeView: row.active_view as WorkspaceViewId,
    theme: row.theme as WorkspaceTheme,
    sidebarCollapsed: readSqlBoolean(row.sidebar_collapsed, 'sidebar state'),
    browserOpen: readSqlBoolean(row.browser_open, 'browser state'),
    browserWidth,
    terminalOpen: readSqlBoolean(row.terminal_open, 'terminal state'),
    terminalHeight,
  };
}

function readWorkspaceId(value: unknown): string {
  try {
    return normalizeWorkspaceId(value);
  } catch (error) {
    throw new DatabaseIntegrityError('Workspace id is invalid.', { cause: error });
  }
}

function readNonNegativeInteger(value: unknown, name: string): number {
  return readIntegerInRange(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function readPositiveSafeInteger(value: unknown, name: string): number {
  return readIntegerInRange(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function readIntegerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  return value as number;
}

function readSqlBoolean(value: unknown, name: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  return value === 1;
}

function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function validateRecoverySchema(database: SqliteAdapter): void {
  const rows = database.all<SchemaObjectRow>(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE name IN (${RECOVERY_SCHEMA_OBJECTS.map(() => '?').join(', ')})
     ORDER BY name`,
    RECOVERY_SCHEMA_OBJECTS.map(({ name }) => name),
  );
  if (
    rows.length !== RECOVERY_SCHEMA_OBJECTS.length ||
    rows.some((row, index) => {
      const expected = RECOVERY_SCHEMA_OBJECTS[index];
      return (
        !expected ||
        row.type !== expected.type ||
        row.name !== expected.name ||
        row.tbl_name !== expected.tableName ||
        normalizeSchemaSql(row.sql) !== expected.sql
      );
    })
  ) {
    throw new DatabaseIntegrityError('Workspace recovery schema is invalid.');
  }
}

const RECOVERY_SCHEMA_OBJECTS = [
  schemaObject('table', 'workspace_recovery_revisions', 'workspace_recovery_revisions'),
  schemaObject('trigger', 'workspace_recovery_revision_create_after_workspace', 'workspaces'),
  schemaObject(
    'trigger',
    'workspace_recovery_revision_workspace_is_immutable',
    'workspace_recovery_revisions',
  ),
  schemaObject(
    'trigger',
    'workspace_recovery_revision_must_advance',
    'workspace_recovery_revisions',
  ),
  schemaObject(
    'trigger',
    'workspace_recovery_revision_prevent_delete',
    'workspace_recovery_revisions',
  ),
  schemaObject('trigger', 'workspace_recovery_revision_advance_after_archive_change', 'workspaces'),
  schemaObject('trigger', 'workspaces_archived_row_is_immutable', 'workspaces'),
  schemaObject('trigger', 'workspaces_timestamp_order_insert', 'workspaces'),
  schemaObject('trigger', 'workspaces_timestamp_order_update', 'workspaces'),
  schemaObject('trigger', 'workspaces_updated_at_must_not_rewind', 'workspaces'),
  schemaObject('trigger', 'workspace_restore_active_automation_limit', 'workspaces'),
  schemaObject(
    'trigger',
    'automation_run_state_prevent_archived_workspace_mutation',
    'automation_run_state',
  ),
  schemaObject(
    'trigger',
    'automation_occurrences_require_active_workspace_insert',
    'automation_occurrences',
  ),
]
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((definition) =>
    Object.freeze({
      ...definition,
      sql: extractRecoverySchemaSql(workspaceRecoverySql, definition.type, definition.name),
    }),
  );

function schemaObject(
  type: 'table' | 'trigger',
  name: string,
  tableName: string,
): {
  readonly type: 'table' | 'trigger';
  readonly name: string;
  readonly tableName: string;
} {
  return { type, name, tableName };
}

export function extractRecoverySchemaSql(
  migrationSql: string,
  type: 'table' | 'trigger',
  name: string,
): string {
  const canonicalMigrationSql = migrationSql.replace(/\r\n?/gu, '\n');
  const marker = `CREATE ${type.toUpperCase()} ${name}`;
  const start = canonicalMigrationSql.indexOf(marker);
  if (start < 0) throw new TypeError(`The workspace recovery migration is missing ${name}.`);
  const endMarker = type === 'trigger' ? '\nEND;' : ';';
  const end = canonicalMigrationSql.indexOf(endMarker, start + marker.length);
  if (end < 0) throw new TypeError(`The workspace recovery migration has an invalid ${name}.`);
  return normalizeSchemaSql(canonicalMigrationSql.slice(start, end + endMarker.length - 1).trim())!;
}

function normalizeSchemaSql(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim() : undefined;
}
