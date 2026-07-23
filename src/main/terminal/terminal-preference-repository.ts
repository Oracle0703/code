import { posix, win32 } from 'node:path';
import terminalWorkspacePreferencesSql from '../../../migrations/0008_terminal_workspace_preferences.sql?raw';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import {
  normalizeStoredTerminalPath,
  normalizeTerminalHostPlatform,
  normalizeTerminalPreferenceRevision,
  normalizeTerminalProfileId,
  normalizeWslDistributionName,
  type TerminalHostPlatform,
} from '../../shared/terminal-domain';
import { DatabaseIntegrityError, DatabaseStateError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import type {
  StoredTerminalPreferences,
  TerminalProfilePreferenceWrite,
  TerminalWorkingDirectoryPreferenceWrite,
  TerminalWslDistributionPreferenceWrite,
} from './terminal-preference-types';

interface WorkspaceIdRow {
  workspace_id: unknown;
}

interface SchemaObjectRow {
  type: unknown;
  name: unknown;
  tbl_name: unknown;
  sql: unknown;
}

interface TerminalPreferenceRow extends WorkspaceIdRow {
  preferred_profile_id: unknown;
  native_cwd_platform: unknown;
  native_cwd_path: unknown;
  wsl_distribution_name: unknown;
  revision: unknown;
  updated_at: unknown;
}

export class TerminalPreferenceRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  read(workspaceId: string): StoredTerminalPreferences {
    const normalizedWorkspaceId = normalizeInputWorkspaceId(workspaceId);
    const row = this.#database.get<TerminalPreferenceRow>(
      `SELECT workspace_id, preferred_profile_id, native_cwd_platform,
              native_cwd_path, wsl_distribution_name, revision, updated_at
       FROM workspace_terminal_preferences
       WHERE workspace_id = ?`,
      [normalizedWorkspaceId],
    );
    if (!row) {
      throw new DatabaseIntegrityError('Workspace terminal preferences are missing.');
    }
    return mapTerminalPreferences(row, normalizedWorkspaceId);
  }

  updateProfile(
    input: TerminalProfilePreferenceWrite,
    timestamp: string,
  ): StoredTerminalPreferences {
    const workspaceId = normalizeInputWorkspaceId(input?.workspaceId);
    const preferredProfileId = normalizeTerminalProfileId(input?.preferredProfileId);
    const expectedRevision = normalizeTerminalPreferenceRevision(input?.expectedRevision);
    const updatedAt = this.#updateTimestamp(workspaceId, expectedRevision, timestamp);
    const result = this.#database.run(
      `UPDATE workspace_terminal_preferences
       SET preferred_profile_id = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1 FROM workspaces
           WHERE id = workspace_terminal_preferences.workspace_id
             AND archived_at IS NULL
         )`,
      [preferredProfileId, updatedAt, workspaceId, expectedRevision],
    );
    assertPreferenceUpdated(result.changes);
    return this.read(workspaceId);
  }

  updateWorkingDirectory(
    input: TerminalWorkingDirectoryPreferenceWrite,
    timestamp: string,
  ): StoredTerminalPreferences {
    const workspaceId = normalizeInputWorkspaceId(input?.workspaceId);
    const expectedRevision = normalizeTerminalPreferenceRevision(input?.expectedRevision);
    const workingDirectory = normalizeWorkingDirectoryPair(
      input?.nativeCwdPlatform,
      input?.nativeCwdPath,
    );
    const updatedAt = this.#updateTimestamp(workspaceId, expectedRevision, timestamp);
    const result = this.#database.run(
      `UPDATE workspace_terminal_preferences
       SET native_cwd_platform = ?, native_cwd_path = ?,
           revision = revision + 1, updated_at = ?
       WHERE workspace_id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1 FROM workspaces
           WHERE id = workspace_terminal_preferences.workspace_id
             AND archived_at IS NULL
         )`,
      [workingDirectory.platform, workingDirectory.path, updatedAt, workspaceId, expectedRevision],
    );
    assertPreferenceUpdated(result.changes);
    return this.read(workspaceId);
  }

  updateWslDistribution(
    input: TerminalWslDistributionPreferenceWrite,
    timestamp: string,
  ): StoredTerminalPreferences {
    const workspaceId = normalizeInputWorkspaceId(input?.workspaceId);
    const expectedRevision = normalizeTerminalPreferenceRevision(input?.expectedRevision);
    const wslDistributionName =
      input?.wslDistributionName === null
        ? null
        : normalizeWslDistributionName(input?.wslDistributionName);
    const updatedAt = this.#updateTimestamp(workspaceId, expectedRevision, timestamp);
    const result = this.#database.run(
      `UPDATE workspace_terminal_preferences
       SET wsl_distribution_name = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1 FROM workspaces
           WHERE id = workspace_terminal_preferences.workspace_id
             AND archived_at IS NULL
         )`,
      [wslDistributionName, updatedAt, workspaceId, expectedRevision],
    );
    assertPreferenceUpdated(result.changes);
    return this.read(workspaceId);
  }

  validateSnapshot(): void {
    const schemaObjects = this.#database.all<SchemaObjectRow>(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE type IN ('table', 'trigger')
         AND (
           name = 'workspace_terminal_preferences'
           OR name = 'workspace_terminal_preferences_create_after_workspace'
           OR tbl_name = 'workspace_terminal_preferences'
         )
       ORDER BY name`,
    );
    if (
      schemaObjects.length !== REQUIRED_SCHEMA_OBJECTS.length ||
      schemaObjects.some((object, index) => {
        const expected = REQUIRED_SCHEMA_OBJECTS[index];
        return (
          !expected ||
          object.type !== expected.type ||
          object.name !== expected.name ||
          object.tbl_name !== expected.tableName ||
          normalizeSchemaSql(object.sql) !== expected.sql
        );
      })
    ) {
      throw new DatabaseIntegrityError('Workspace terminal preference schema is invalid.');
    }
    const workspaceIds = this.#database
      .all<WorkspaceIdRow>(
        `SELECT id AS workspace_id
         FROM workspaces
         ORDER BY id`,
      )
      .map(({ workspace_id }) => normalizeStoredWorkspaceId(workspace_id));
    const rows = this.#database.all<TerminalPreferenceRow>(
      `SELECT workspace_id, preferred_profile_id, native_cwd_platform,
              native_cwd_path, wsl_distribution_name, revision, updated_at
       FROM workspace_terminal_preferences
       ORDER BY workspace_id`,
    );
    if (rows.length !== workspaceIds.length) {
      throw new DatabaseIntegrityError(
        'Every workspace must have exactly one terminal preference row.',
      );
    }
    for (const [index, row] of rows.entries()) {
      const expectedWorkspaceId = workspaceIds[index];
      if (!expectedWorkspaceId) {
        throw new DatabaseIntegrityError('Workspace terminal preference identity is invalid.');
      }
      mapTerminalPreferences(row, expectedWorkspaceId);
    }
  }

  #updateTimestamp(workspaceId: string, expectedRevision: number, value: string): string {
    const requested = normalizeIsoTimestamp(value, 'terminal preference update time');
    const current = this.read(workspaceId);
    if (current.revision !== expectedRevision) {
      throw new DatabaseStateError(
        'Workspace terminal preferences changed before they could be updated.',
      );
    }
    return requested < current.updatedAt ? current.updatedAt : requested;
  }
}

const REQUIRED_SCHEMA_OBJECTS = createRequiredSchemaObjects();

function createRequiredSchemaObjects(): readonly {
  readonly type: 'table' | 'trigger';
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}[] {
  const definitions = [
    {
      type: 'table' as const,
      name: 'workspace_terminal_preferences',
      tableName: 'workspace_terminal_preferences',
    },
    {
      type: 'trigger' as const,
      name: 'workspace_terminal_preferences_create_after_workspace',
      tableName: 'workspaces',
    },
    {
      type: 'trigger' as const,
      name: 'workspace_terminal_preferences_prevent_archived_workspace_mutation',
      tableName: 'workspace_terminal_preferences',
    },
    {
      type: 'trigger' as const,
      name: 'workspace_terminal_preferences_prevent_delete',
      tableName: 'workspace_terminal_preferences',
    },
    {
      type: 'trigger' as const,
      name: 'workspace_terminal_preferences_revision_must_advance',
      tableName: 'workspace_terminal_preferences',
    },
    {
      type: 'trigger' as const,
      name: 'workspace_terminal_preferences_updated_at_must_not_rewind',
      tableName: 'workspace_terminal_preferences',
    },
    {
      type: 'trigger' as const,
      name: 'workspace_terminal_preferences_workspace_is_immutable',
      tableName: 'workspace_terminal_preferences',
    },
  ].sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze(
    definitions.map((definition) =>
      Object.freeze({
        ...definition,
        sql: extractSchemaSql(terminalWorkspacePreferencesSql, definition.type, definition.name),
      }),
    ),
  );
}

function extractSchemaSql(migrationSql: string, type: 'table' | 'trigger', name: string): string {
  const marker = `CREATE ${type.toUpperCase()} ${name}`;
  const start = migrationSql.indexOf(marker);
  if (start < 0) {
    throw new TypeError(`The terminal preference migration is missing ${name}.`);
  }
  const nextMarker =
    type === 'table' ? 'INSERT INTO workspace_terminal_preferences' : 'CREATE TRIGGER ';
  const next = migrationSql.indexOf(nextMarker, start + marker.length);
  const statement = migrationSql.slice(start, next < 0 ? migrationSql.length : next).trim();
  const withoutTerminator = statement.endsWith(';') ? statement.slice(0, -1) : statement;
  return normalizeSchemaSql(withoutTerminator);
}

function normalizeSchemaSql(value: string): string;
function normalizeSchemaSql(value: unknown): string | undefined;
function normalizeSchemaSql(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replaceAll(/\s+/gu, ' ').trim() : undefined;
}

function mapTerminalPreferences(
  row: TerminalPreferenceRow,
  expectedWorkspaceId: string,
): StoredTerminalPreferences {
  try {
    const workspaceId = normalizeWorkspaceId(row.workspace_id);
    if (workspaceId !== expectedWorkspaceId) {
      throw new TypeError('Terminal preference workspace does not match.');
    }
    const preferredProfileId = normalizeTerminalProfileId(row.preferred_profile_id);
    const workingDirectory = normalizeWorkingDirectoryPair(
      row.native_cwd_platform,
      row.native_cwd_path,
    );
    const wslDistributionName =
      row.wsl_distribution_name === null
        ? null
        : normalizeWslDistributionName(row.wsl_distribution_name);
    const revision = normalizeTerminalPreferenceRevision(row.revision);
    const updatedAt = normalizeIsoTimestamp(row.updated_at, 'terminal preference update time');
    return {
      workspaceId,
      preferredProfileId,
      nativeCwdPlatform: workingDirectory.platform,
      nativeCwdPath: workingDirectory.path,
      wslDistributionName,
      revision,
      updatedAt,
    };
  } catch (error) {
    if (error instanceof DatabaseIntegrityError) throw error;
    throw new DatabaseIntegrityError('Workspace terminal preferences are invalid.', {
      cause: error,
    });
  }
}

function normalizeWorkingDirectoryPair(
  platformValue: unknown,
  pathValue: unknown,
): {
  readonly platform: TerminalHostPlatform | null;
  readonly path: string | null;
} {
  if (platformValue === null && pathValue === null) {
    return { platform: null, path: null };
  }
  if (platformValue === null || pathValue === null) {
    throw new TypeError('Terminal working directory fields must be set together.');
  }
  const platform = normalizeTerminalHostPlatform(platformValue);
  const path = normalizeStoredTerminalPath(pathValue);
  const absolute = platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path);
  if (!absolute) {
    throw new TypeError('Terminal working directory must be absolute.');
  }
  return { platform, path };
}

function normalizeInputWorkspaceId(value: unknown): string {
  try {
    return normalizeWorkspaceId(value);
  } catch (error) {
    throw new TypeError('Terminal preference workspace id is invalid.', { cause: error });
  }
}

function normalizeStoredWorkspaceId(value: unknown): string {
  try {
    return normalizeWorkspaceId(value);
  } catch (error) {
    throw new DatabaseIntegrityError('Workspace terminal preference identity is invalid.', {
      cause: error,
    });
  }
}

function normalizeIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`The ${name} is invalid.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`The ${name} is invalid.`);
  }
  return value;
}

function assertPreferenceUpdated(value: unknown): void {
  if (typeof value !== 'number' || Number(value) !== 1) {
    throw new DatabaseStateError(
      'Workspace terminal preferences changed before they could be updated.',
    );
  }
}
