import { createHash, randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BROWSER_MAX_BOOKMARKS,
  BROWSER_MAX_TABS,
  normalizeBrowserId,
  normalizeBrowserRevision,
  normalizeBrowserTitle,
} from '../../shared/browser-domain';
import {
  AUTOMATION_ACTIVE_GLOBAL_LIMIT,
  AUTOMATION_ENABLED_WORKSPACE_LIMIT,
  normalizeAutomationAction,
  normalizeAutomationId,
  normalizeAutomationName,
  normalizeAutomationRevision,
  normalizeAutomationSchedule,
} from '../../shared/automation-domain';
import type {
  AutomationAction,
  AutomationSchedule,
  BackupPolicy,
  DataImportCounts,
  InboxCategory,
  ScheduleKind,
  TaskStatus,
  WorkspaceColor,
  WorkspaceTheme,
  WorkspaceViewId,
} from '../../shared/contracts';
import {
  normalizeInboxCategory,
  normalizeInboxContent,
  normalizeInboxId,
} from '../../shared/inbox-domain';
import {
  normalizeNoteBody,
  normalizeNoteId,
  normalizeNoteRevision,
  normalizeNoteTitle,
} from '../../shared/note-domain';
import {
  normalizeScheduleCivilDate,
  normalizeScheduleId,
  normalizeScheduleKind,
  normalizeScheduleRange,
  normalizeScheduleRevision,
  normalizeScheduleTitle,
} from '../../shared/schedule-domain';
import {
  normalizeTaskCivilDate,
  normalizeTaskId,
  normalizeTaskStatus,
  normalizeTaskTitle,
} from '../../shared/task-domain';
import {
  createWorkspaceNameKey,
  normalizeWorkspaceColor,
  normalizeWorkspaceId,
  normalizeWorkspaceName,
  normalizeWorkspacePreferencesPatch,
} from '../../shared/workspace-domain';
import { AutomationRepository } from '../automations/automation-repository';
import { BrowserService } from '../browser/browser-service';
import { BackupPolicyRepository } from '../database/backup-policy-repository';
import { DEFAULT_MIGRATIONS } from '../database/default-migrations';
import { DatabaseIntegrityError } from '../database/errors';
import { MetadataRepository } from '../database/metadata-repository';
import { MigrationRunner } from '../database/migration-runner';
import {
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from '../database/sqlite-adapter';
import type { Migration } from '../database/types';
import { InboxService } from '../inbox/inbox-service';
import { NoteService } from '../notes/note-service';
import { ScheduleService } from '../schedule/schedule-service';
import { SearchService } from '../search/search-service';
import { normalizeBrowserUrl } from '../security/browser-url';
import { TaskService } from '../tasks/task-service';
import { TerminalPreferenceRepository } from '../terminal/terminal-preference-repository';
import { WorkspaceService } from '../workspaces/workspace-service';
import {
  DATA_PACKAGE_FORMAT,
  DATA_PACKAGE_FORMAT_VERSION,
  LEGACY_DATA_PACKAGE_FORMAT_VERSION,
  DataPackageError,
  PORTABLE_RECORD_TYPES,
  canonicalJson,
  type JsonValue,
  type ParsedPortablePackage,
  type PortableDataRecord,
  type PortableRecordType,
} from './package-format';
import { DEFAULT_MAX_IMPORT_STAGING_BYTES, type ImportStagingDriver } from './staging';

export const PORTABLE_DATABASE_SCHEMA_VERSION = 9;
export const SUPPORTED_PORTABLE_SOURCE_SCHEMA_VERSIONS = Object.freeze([7, 8, 9] as const);
const MAX_PORTABLE_LOGICAL_RECORDS = 100_000;
const MAX_PORTABLE_WORKSPACES = 500;
const MAX_PORTABLE_BROWSER_TABS = 6_000;
const MAX_PORTABLE_BROWSER_BOOKMARKS = 25_000;
const STAGING_DATABASE_PAGE_SIZE = 4096;

export interface DatabaseImportStagingDriverOptions {
  readonly localBackupPolicy: BackupPolicy;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly adapterFactory?: SqliteAdapterFactory;
  readonly migrations?: readonly Migration[];
  readonly timeoutMs?: number;
  readonly maxDatabaseBytes?: number;
}

interface AppStateRecord {
  readonly currentWorkspaceId: string;
  readonly updatedAt: string;
}

interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly color: WorkspaceColor;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface WorkspacePreferenceRecord {
  readonly workspaceId: string;
  readonly activeView: WorkspaceViewId;
  readonly theme: WorkspaceTheme;
  readonly sidebarCollapsed: boolean;
  readonly browserOpen: boolean;
  readonly browserWidth: number;
  readonly terminalOpen: boolean;
  readonly terminalHeight: number;
  readonly updatedAt: string;
}

interface InboxEntryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly content: string;
  readonly category: InboxCategory;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface TaskRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly plannedFor: string | null;
  readonly sourceInboxEntryId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface NoteRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly body: string;
  readonly revision: number;
  readonly sourceInboxEntryId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface ScheduleItemRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly kind: ScheduleKind;
  readonly scheduledFor: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface BrowserTabRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface BrowserStateRecord {
  readonly workspaceId: string;
  readonly activeTabId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

interface BrowserBookmarkRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly title: string;
  readonly createdAt: string;
}

interface AutomationDefinitionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: AutomationSchedule;
  readonly action: AutomationAction;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface PortableDatabaseModel {
  readonly appState: AppStateRecord;
  readonly workspaces: readonly WorkspaceRecord[];
  readonly preferences: readonly WorkspacePreferenceRecord[];
  readonly inboxEntries: readonly InboxEntryRecord[];
  readonly tasks: readonly TaskRecord[];
  readonly notes: readonly NoteRecord[];
  readonly scheduleItems: readonly ScheduleItemRecord[];
  readonly browserTabs: readonly BrowserTabRecord[];
  readonly browserStates: readonly BrowserStateRecord[];
  readonly browserBookmarks: readonly BrowserBookmarkRecord[];
  readonly automations: readonly AutomationDefinitionRecord[];
}

/**
 * Reads only user-visible logical data from an already-open, healthy current database.
 * Records are grouped by type and deterministically sorted within every group.
 */
export function readPortableDatabaseRecords(
  database: SqliteAdapter,
  migrations: readonly Migration[] = DEFAULT_MIGRATIONS,
): readonly PortableDataRecord[] {
  validateDatabaseSnapshot(database, migrations);
  const records = readRawPortableRecords(database);
  decodePortableRecords(records);
  return records;
}

/**
 * Builds and independently validates the SQLite file consumed by AtomicImportStager.
 * The source package never supplies metadata, backup state, FTS rows, or host terminal settings.
 */
export class DatabaseImportStagingDriver implements ImportStagingDriver {
  readonly #localBackupPolicy: BackupPolicy;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #adapterFactory: SqliteAdapterFactory;
  readonly #migrations: readonly Migration[];
  readonly #timeoutMs: number;
  readonly #maxDatabaseBytes: number;

  constructor({
    localBackupPolicy,
    now = () => new Date(),
    idFactory = randomUUID,
    adapterFactory = createNodeSqliteAdapter,
    migrations = DEFAULT_MIGRATIONS,
    timeoutMs = 5_000,
    maxDatabaseBytes = DEFAULT_MAX_IMPORT_STAGING_BYTES,
  }: DatabaseImportStagingDriverOptions) {
    this.#localBackupPolicy = validateBackupPolicy(localBackupPolicy);
    this.#now = now;
    this.#idFactory = idFactory;
    this.#adapterFactory = adapterFactory;
    this.#migrations = migrations;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new TypeError('The import database timeout is invalid.');
    }
    this.#timeoutMs = timeoutMs;
    if (
      !Number.isSafeInteger(maxDatabaseBytes) ||
      maxDatabaseBytes < 1 ||
      maxDatabaseBytes > DEFAULT_MAX_IMPORT_STAGING_BYTES
    ) {
      throw new TypeError('The import database size limit is invalid.');
    }
    this.#maxDatabaseBytes = maxDatabaseBytes;
    assertCurrentMigrationSet(this.#migrations);
  }

  async build(packageData: ParsedPortablePackage, temporaryPath: string): Promise<void> {
    const model = pausePortableAutomations(decodePortablePackage(packageData));
    const expectedLogicalDigest = digestPortableModel(model);
    const timestamp = readClockTimestamp(this.#now);
    const databaseId = this.#idFactory();
    const stagingPath = resolve(temporaryPath);
    const database = this.#adapterFactory(stagingPath, { timeoutMs: this.#timeoutMs });
    try {
      try {
        database.open();
        configureStagingPragmas(database, this.#timeoutMs, this.#maxDatabaseBytes);
        const migration = new MigrationRunner(this.#migrations).apply(database);
        if (
          migration.fromVersion !== 0 ||
          migration.toVersion !== PORTABLE_DATABASE_SCHEMA_VERSION
        ) {
          throw new DatabaseIntegrityError(
            'The import staging database was not created from empty.',
          );
        }

        database.exec('BEGIN IMMEDIATE');
        new MetadataRepository(database).initializeWithinTransaction(timestamp, databaseId);
        insertLocalBackupState(database, this.#localBackupPolicy, timestamp);
        insertPortableModel(database, model);
        database.exec('COMMIT');

        validateFtsContentIntegrity(database);
        validateDatabaseSnapshot(database, this.#migrations, this.#localBackupPolicy);
        assertLogicalDigest(
          decodePortableRecords(readRawPortableRecords(database)),
          expectedLogicalDigest,
        );
      } catch (error) {
        if (database.isOpen && database.isTransaction) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // Preserve the validation or write error that made the staging file unusable.
          }
        }
        throw error;
      } finally {
        database.close();
      }
      await assertNoSqliteSidecars(stagingPath);
    } catch (error) {
      await removeSqliteSidecars(stagingPath);
      throw error;
    }
  }

  async validate(stagingPath: string, packageData: ParsedPortablePackage): Promise<void> {
    const resolvedPath = resolve(stagingPath);
    const expectedLogicalDigest = digestPortableModel(
      pausePortableAutomations(decodePortablePackage(packageData)),
    );
    const database = this.#adapterFactory(resolvedPath, { timeoutMs: this.#timeoutMs });
    try {
      try {
        database.open();
        configureStagingPragmas(database, this.#timeoutMs, this.#maxDatabaseBytes);
        validateFtsContentIntegrity(database);
        database.exec('PRAGMA query_only = ON');
        validateDatabaseSnapshot(database, this.#migrations, this.#localBackupPolicy);
        assertLogicalDigest(
          decodePortableRecords(readRawPortableRecords(database)),
          expectedLogicalDigest,
        );
      } finally {
        database.close();
      }
      await assertNoSqliteSidecars(resolvedPath);
    } finally {
      await removeSqliteSidecars(resolvedPath);
    }
  }
}

function readRawPortableRecords(database: SqliteAdapter): PortableDataRecord[] {
  const records: PortableDataRecord[] = [];
  for (const row of database.all<Record<string, unknown>>(
    `SELECT current_workspace_id AS currentWorkspaceId, updated_at AS updatedAt
     FROM workspace_app_state
     ORDER BY singleton`,
  )) {
    records.push(
      portableRecord('app-state', {
        currentWorkspaceId: readSqlString(row.currentWorkspaceId, 'current workspace id'),
        updatedAt: readSqlString(row.updatedAt, 'workspace state timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, name, color, created_at AS createdAt, updated_at AS updatedAt,
            archived_at AS archivedAt
     FROM workspaces
     ORDER BY created_at, id`,
  )) {
    records.push(
      portableRecord('workspace', {
        id: readSqlString(row.id, 'workspace id'),
        name: readSqlString(row.name, 'workspace name'),
        color: readSqlString(row.color, 'workspace color'),
        createdAt: readSqlString(row.createdAt, 'workspace creation timestamp'),
        updatedAt: readSqlString(row.updatedAt, 'workspace update timestamp'),
        archivedAt: readSqlNullableString(row.archivedAt, 'workspace archive timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT workspace_id AS workspaceId, active_view AS activeView, theme,
            sidebar_collapsed AS sidebarCollapsed, browser_open AS browserOpen,
            browser_width AS browserWidth, terminal_open AS terminalOpen,
            terminal_height AS terminalHeight, updated_at AS updatedAt
     FROM workspace_preferences
     ORDER BY workspace_id`,
  )) {
    records.push(
      portableRecord('workspace-preference', {
        workspaceId: readSqlString(row.workspaceId, 'workspace preference id'),
        activeView: readSqlString(row.activeView, 'workspace active view'),
        theme: readSqlString(row.theme, 'workspace theme'),
        sidebarCollapsed: readSqlBoolean(row.sidebarCollapsed, 'workspace sidebar state'),
        browserOpen: readSqlBoolean(row.browserOpen, 'workspace browser state'),
        browserWidth: readSqlInteger(row.browserWidth, 'workspace browser width'),
        terminalOpen: readSqlBoolean(row.terminalOpen, 'workspace terminal state'),
        terminalHeight: readSqlInteger(row.terminalHeight, 'workspace terminal height'),
        updatedAt: readSqlString(row.updatedAt, 'workspace preference timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, workspace_id AS workspaceId, content, category,
            created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
     FROM inbox_entries
     ORDER BY workspace_id, created_at, id`,
  )) {
    records.push(
      portableRecord('inbox-entry', {
        id: readSqlString(row.id, 'inbox entry id'),
        workspaceId: readSqlString(row.workspaceId, 'inbox workspace id'),
        content: readSqlString(row.content, 'inbox content'),
        category: readSqlString(row.category, 'inbox category'),
        createdAt: readSqlString(row.createdAt, 'inbox creation timestamp'),
        updatedAt: readSqlString(row.updatedAt, 'inbox update timestamp'),
        archivedAt: readSqlNullableString(row.archivedAt, 'inbox archive timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, workspace_id AS workspaceId, title, status, planned_for AS plannedFor,
            source_inbox_entry_id AS sourceInboxEntryId, created_at AS createdAt,
            updated_at AS updatedAt, completed_at AS completedAt
     FROM tasks
     ORDER BY workspace_id, created_at, id`,
  )) {
    records.push(
      portableRecord('task', {
        id: readSqlString(row.id, 'task id'),
        workspaceId: readSqlString(row.workspaceId, 'task workspace id'),
        title: readSqlString(row.title, 'task title'),
        status: readSqlString(row.status, 'task status'),
        plannedFor: readSqlNullableString(row.plannedFor, 'task planned date'),
        sourceInboxEntryId: readSqlNullableString(row.sourceInboxEntryId, 'task inbox source'),
        createdAt: readSqlString(row.createdAt, 'task creation timestamp'),
        updatedAt: readSqlString(row.updatedAt, 'task update timestamp'),
        completedAt: readSqlNullableString(row.completedAt, 'task completion timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, workspace_id AS workspaceId, title, body, revision,
            source_inbox_entry_id AS sourceInboxEntryId, created_at AS createdAt,
            updated_at AS updatedAt, archived_at AS archivedAt
     FROM notes
     ORDER BY workspace_id, created_at, id`,
  )) {
    records.push(
      portableRecord('note', {
        id: readSqlString(row.id, 'note id'),
        workspaceId: readSqlString(row.workspaceId, 'note workspace id'),
        title: readSqlString(row.title, 'note title'),
        body: readSqlString(row.body, 'note body'),
        revision: readSqlInteger(row.revision, 'note revision'),
        sourceInboxEntryId: readSqlNullableString(row.sourceInboxEntryId, 'note inbox source'),
        createdAt: readSqlString(row.createdAt, 'note creation timestamp'),
        updatedAt: readSqlString(row.updatedAt, 'note update timestamp'),
        archivedAt: readSqlNullableString(row.archivedAt, 'note archive timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, workspace_id AS workspaceId, title, kind,
            scheduled_for AS scheduledFor, start_minute AS startMinute,
            end_minute AS endMinute, revision, created_at AS createdAt,
            updated_at AS updatedAt, archived_at AS archivedAt
     FROM schedule_items
     ORDER BY workspace_id, scheduled_for, start_minute, end_minute, id`,
  )) {
    records.push(
      portableRecord('schedule-item', {
        id: readSqlString(row.id, 'schedule item id'),
        workspaceId: readSqlString(row.workspaceId, 'schedule workspace id'),
        title: readSqlString(row.title, 'schedule title'),
        kind: readSqlString(row.kind, 'schedule kind'),
        scheduledFor: readSqlString(row.scheduledFor, 'schedule date'),
        startMinute: readSqlInteger(row.startMinute, 'schedule start minute'),
        endMinute: readSqlInteger(row.endMinute, 'schedule end minute'),
        revision: readSqlInteger(row.revision, 'schedule revision'),
        createdAt: readSqlString(row.createdAt, 'schedule creation timestamp'),
        updatedAt: readSqlString(row.updatedAt, 'schedule update timestamp'),
        archivedAt: readSqlNullableString(row.archivedAt, 'schedule archive timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, workspace_id AS workspaceId, url, title,
            created_at AS createdAt, updated_at AS updatedAt
     FROM browser_tabs
     ORDER BY workspace_id, created_at, id`,
  )) {
    records.push(
      portableRecord('browser-tab', {
        id: readSqlString(row.id, 'browser tab id'),
        workspaceId: readSqlString(row.workspaceId, 'browser tab workspace id'),
        url: readSqlString(row.url, 'browser tab URL'),
        title: readSqlString(row.title, 'browser tab title'),
        createdAt: readSqlString(row.createdAt, 'browser tab creation timestamp'),
        updatedAt: readSqlString(row.updatedAt, 'browser tab update timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT workspace_id AS workspaceId, active_tab_id AS activeTabId,
            revision, updated_at AS updatedAt
     FROM browser_workspace_state
     ORDER BY workspace_id`,
  )) {
    records.push(
      portableRecord('browser-state', {
        workspaceId: readSqlString(row.workspaceId, 'browser state workspace id'),
        activeTabId: readSqlString(row.activeTabId, 'active browser tab id'),
        revision: readSqlInteger(row.revision, 'browser state revision'),
        updatedAt: readSqlString(row.updatedAt, 'browser state update timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, workspace_id AS workspaceId, url, title, created_at AS createdAt
     FROM browser_bookmarks
     ORDER BY workspace_id, created_at, id`,
  )) {
    records.push(
      portableRecord('browser-bookmark', {
        id: readSqlString(row.id, 'browser bookmark id'),
        workspaceId: readSqlString(row.workspaceId, 'browser bookmark workspace id'),
        url: readSqlString(row.url, 'browser bookmark URL'),
        title: readSqlString(row.title, 'browser bookmark title'),
        createdAt: readSqlString(row.createdAt, 'browser bookmark creation timestamp'),
      }),
    );
  }
  for (const row of database.all<Record<string, unknown>>(
    `SELECT id, workspace_id AS workspaceId, name, enabled, cadence,
            local_time_minute AS localTimeMinute, weekday,
            action_kind AS actionKind, action_title AS actionTitle,
            action_body AS actionBody, revision, created_at AS createdAt,
            updated_at AS updatedAt, archived_at AS archivedAt
     FROM automations
     ORDER BY workspace_id, created_at, id`,
  )) {
    const actionKind = readSqlString(row.actionKind, 'automation action kind');
    const actionTitle = readSqlString(row.actionTitle, 'automation action title');
    const actionBody = readSqlNullableString(row.actionBody, 'automation action body');
    records.push(
      portableRecord('automation-definition', {
        id: readSqlString(row.id, 'automation id'),
        workspaceId: readSqlString(row.workspaceId, 'automation workspace id'),
        name: readSqlString(row.name, 'automation name'),
        enabled: readSqlBoolean(row.enabled, 'automation enabled state'),
        schedule: {
          cadence: readSqlString(row.cadence, 'automation cadence'),
          localTimeMinute: readSqlInteger(row.localTimeMinute, 'automation local time'),
          weekday: row.weekday === null ? null : readSqlInteger(row.weekday, 'automation weekday'),
        },
        action:
          actionKind === 'create-today-task'
            ? { kind: actionKind, title: actionTitle }
            : { kind: actionKind, title: actionTitle, body: actionBody },
        revision: readSqlInteger(row.revision, 'automation revision'),
        createdAt: readSqlString(row.createdAt, 'automation creation timestamp'),
        updatedAt: readSqlString(row.updatedAt, 'automation update timestamp'),
        archivedAt: readSqlNullableString(row.archivedAt, 'automation archive timestamp'),
      }),
    );
  }
  return records;
}

function decodePortablePackage(packageData: ParsedPortablePackage): PortableDatabaseModel {
  assertPlainObject(packageData, 'The parsed data package is invalid.');
  assertPlainObject(packageData.manifest, 'The data package manifest is invalid.');
  const formatMatchesSchema =
    (packageData.manifest.formatVersion === LEGACY_DATA_PACKAGE_FORMAT_VERSION &&
      (packageData.manifest.sourceSchemaVersion === 7 ||
        packageData.manifest.sourceSchemaVersion === 8)) ||
    (packageData.manifest.formatVersion === DATA_PACKAGE_FORMAT_VERSION &&
      packageData.manifest.sourceSchemaVersion === 9);
  if (
    packageData.manifest.format !== DATA_PACKAGE_FORMAT ||
    !formatMatchesSchema ||
    !SUPPORTED_PORTABLE_SOURCE_SCHEMA_VERSIONS.some(
      (version) => version === packageData.manifest.sourceSchemaVersion,
    ) ||
    packageData.manifest.recordCount !== packageData.records.length
  ) {
    throw new DataPackageError('The data package manifest does not match its records.');
  }
  const model = decodePortableRecords(packageData.records);
  if (
    packageData.manifest.formatVersion === LEGACY_DATA_PACKAGE_FORMAT_VERSION &&
    model.automations.length !== 0
  ) {
    throw new DataPackageError('A legacy data package cannot contain automation definitions.');
  }
  const counts = countPortableModel(model);
  if (!sameCounts(packageData.manifest.counts, counts)) {
    throw new DataPackageError('The data package counts do not match its records.');
  }
  const current = model.workspaces.find(({ id }) => id === model.appState.currentWorkspaceId);
  if (!current || packageData.currentWorkspaceName !== current.name) {
    throw new DataPackageError('The data package current workspace preview is invalid.');
  }
  return model;
}

function decodePortableRecords(records: readonly PortableDataRecord[]): PortableDatabaseModel {
  if (!Array.isArray(records)) {
    throw new DataPackageError('The data package records are invalid.');
  }
  let appState: AppStateRecord | undefined;
  const workspaces: WorkspaceRecord[] = [];
  const preferences: WorkspacePreferenceRecord[] = [];
  const inboxEntries: InboxEntryRecord[] = [];
  const tasks: TaskRecord[] = [];
  const notes: NoteRecord[] = [];
  const scheduleItems: ScheduleItemRecord[] = [];
  const browserTabs: BrowserTabRecord[] = [];
  const browserStates: BrowserStateRecord[] = [];
  const browserBookmarks: BrowserBookmarkRecord[] = [];
  const automations: AutomationDefinitionRecord[] = [];

  for (const value of records as readonly unknown[]) {
    assertExactObjectKeys(value, ['data', 'type'], 'The data package record is invalid.');
    const record = value as { readonly data: unknown; readonly type: unknown };
    if (
      typeof record.type !== 'string' ||
      !PORTABLE_RECORD_TYPES.includes(record.type as PortableRecordType)
    ) {
      throw new DataPackageError('The data package record type is invalid.');
    }
    const data = record.data;
    switch (record.type as PortableRecordType) {
      case 'app-state':
        if (appState) {
          throw new DataPackageError('The data package repeats its application state.');
        }
        appState = decodeAppState(data);
        break;
      case 'workspace':
        workspaces.push(decodeWorkspace(data));
        break;
      case 'workspace-preference':
        preferences.push(decodeWorkspacePreference(data));
        break;
      case 'inbox-entry':
        inboxEntries.push(decodeInboxEntry(data));
        break;
      case 'task':
        tasks.push(decodeTask(data));
        break;
      case 'note':
        notes.push(decodeNote(data));
        break;
      case 'schedule-item':
        scheduleItems.push(decodeScheduleItem(data));
        break;
      case 'browser-tab':
        browserTabs.push(decodeBrowserTab(data));
        break;
      case 'browser-state':
        browserStates.push(decodeBrowserState(data));
        break;
      case 'browser-bookmark':
        browserBookmarks.push(decodeBrowserBookmark(data));
        break;
      case 'automation-definition':
        automations.push(decodeAutomationDefinition(data));
        break;
    }
  }
  if (!appState) {
    throw new DataPackageError('The data package application state is missing.');
  }

  const model: PortableDatabaseModel = {
    appState,
    workspaces: sortBy(workspaces, (item) => `${item.createdAt}\0${item.id}`),
    preferences: sortBy(preferences, (item) => item.workspaceId),
    inboxEntries: sortBy(
      inboxEntries,
      (item) => `${item.workspaceId}\0${item.createdAt}\0${item.id}`,
    ),
    tasks: sortBy(tasks, (item) => `${item.workspaceId}\0${item.createdAt}\0${item.id}`),
    notes: sortBy(notes, (item) => `${item.workspaceId}\0${item.createdAt}\0${item.id}`),
    scheduleItems: sortBy(
      scheduleItems,
      (item) =>
        `${item.workspaceId}\0${item.scheduledFor}\0${item.startMinute
          .toString()
          .padStart(4, '0')}\0${item.endMinute.toString().padStart(4, '0')}\0${item.id}`,
    ),
    browserTabs: sortBy(
      browserTabs,
      (item) => `${item.workspaceId}\0${item.createdAt}\0${item.id}`,
    ),
    browserStates: sortBy(browserStates, (item) => item.workspaceId),
    browserBookmarks: sortBy(
      browserBookmarks,
      (item) => `${item.workspaceId}\0${item.createdAt}\0${item.id}`,
    ),
    automations: sortBy(
      automations,
      (item) => `${item.workspaceId}\0${item.createdAt}\0${item.id}`,
    ),
  };
  validatePortableModelLimits(model);
  validatePortableRelationships(model);
  return model;
}

function validatePortableModelLimits(model: PortableDatabaseModel): void {
  const totalRecords =
    1 +
    model.workspaces.length +
    model.preferences.length +
    model.inboxEntries.length +
    model.tasks.length +
    model.notes.length +
    model.scheduleItems.length +
    model.browserTabs.length +
    model.browserStates.length +
    model.browserBookmarks.length +
    model.automations.length;
  const activeWorkspaceIds = new Set(
    model.workspaces.filter(({ archivedAt }) => archivedAt === null).map(({ id }) => id),
  );
  const activeAutomationCount = model.automations.filter(
    ({ archivedAt, workspaceId }) => archivedAt === null && activeWorkspaceIds.has(workspaceId),
  ).length;
  if (
    totalRecords > MAX_PORTABLE_LOGICAL_RECORDS ||
    model.workspaces.length > MAX_PORTABLE_WORKSPACES ||
    model.browserStates.length > MAX_PORTABLE_WORKSPACES ||
    model.browserTabs.length > MAX_PORTABLE_BROWSER_TABS ||
    model.browserBookmarks.length > MAX_PORTABLE_BROWSER_BOOKMARKS ||
    activeAutomationCount > AUTOMATION_ACTIVE_GLOBAL_LIMIT
  ) {
    throw new DataPackageError('The data package exceeds the logical database limits.');
  }
}

function decodeAppState(value: unknown): AppStateRecord {
  const data = exactPayload(value, ['currentWorkspaceId', 'updatedAt'], 'application state');
  return {
    currentWorkspaceId: normalizedValue(
      data.currentWorkspaceId,
      normalizeWorkspaceId,
      'current workspace id',
    ),
    updatedAt: readIsoTimestamp(data.updatedAt, 'workspace state update time'),
  };
}

function decodeWorkspace(value: unknown): WorkspaceRecord {
  const data = exactPayload(
    value,
    ['archivedAt', 'color', 'createdAt', 'id', 'name', 'updatedAt'],
    'workspace',
  );
  const createdAt = readIsoTimestamp(data.createdAt, 'workspace creation time');
  const updatedAt = readIsoTimestamp(data.updatedAt, 'workspace update time');
  const archivedAt = readNullableIsoTimestamp(data.archivedAt, 'workspace archive time');
  if (archivedAt !== null && archivedAt < createdAt) {
    throw new DataPackageError('The data package workspace archive time is invalid.');
  }
  return {
    id: normalizedValue(data.id, normalizeWorkspaceId, 'workspace id'),
    name: normalizedValue(data.name, normalizeWorkspaceName, 'workspace name'),
    color: normalizedValue(data.color, normalizeWorkspaceColor, 'workspace color'),
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function decodeWorkspacePreference(value: unknown): WorkspacePreferenceRecord {
  const data = exactPayload(
    value,
    [
      'activeView',
      'browserOpen',
      'browserWidth',
      'sidebarCollapsed',
      'terminalHeight',
      'terminalOpen',
      'theme',
      'updatedAt',
      'workspaceId',
    ],
    'workspace preference',
  );
  let preferences;
  try {
    preferences = normalizeWorkspacePreferencesPatch({
      activeView: data.activeView,
      theme: data.theme,
      sidebarCollapsed: data.sidebarCollapsed,
      browserOpen: data.browserOpen,
      browserWidth: data.browserWidth,
      terminalOpen: data.terminalOpen,
      terminalHeight: data.terminalHeight,
    });
  } catch (error) {
    throw new DataPackageError('The workspace preference values are invalid.', { cause: error });
  }
  return {
    workspaceId: normalizedValue(data.workspaceId, normalizeWorkspaceId, 'workspace preference id'),
    activeView: preferences.activeView as WorkspaceViewId,
    theme: preferences.theme as WorkspaceTheme,
    sidebarCollapsed: preferences.sidebarCollapsed as boolean,
    browserOpen: preferences.browserOpen as boolean,
    browserWidth: preferences.browserWidth as number,
    terminalOpen: preferences.terminalOpen as boolean,
    terminalHeight: preferences.terminalHeight as number,
    updatedAt: readIsoTimestamp(data.updatedAt, 'workspace preference update time'),
  };
}

function decodeInboxEntry(value: unknown): InboxEntryRecord {
  const data = exactPayload(
    value,
    ['archivedAt', 'category', 'content', 'createdAt', 'id', 'updatedAt', 'workspaceId'],
    'inbox entry',
  );
  const createdAt = readIsoTimestamp(data.createdAt, 'inbox creation time');
  const updatedAt = readIsoTimestamp(data.updatedAt, 'inbox update time');
  const archivedAt = readNullableIsoTimestamp(data.archivedAt, 'inbox archive time');
  assertTimestampOrder(createdAt, updatedAt, archivedAt, 'inbox entry');
  return {
    id: normalizedValue(data.id, normalizeInboxId, 'inbox entry id'),
    workspaceId: normalizedValue(data.workspaceId, normalizeWorkspaceId, 'inbox workspace id'),
    content: normalizedValue(data.content, normalizeInboxContent, 'inbox content'),
    category: normalizedValue(data.category, normalizeInboxCategory, 'inbox category'),
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function decodeTask(value: unknown): TaskRecord {
  const data = exactPayload(
    value,
    [
      'completedAt',
      'createdAt',
      'id',
      'plannedFor',
      'sourceInboxEntryId',
      'status',
      'title',
      'updatedAt',
      'workspaceId',
    ],
    'task',
  );
  const status = normalizedValue(data.status, normalizeTaskStatus, 'task status');
  const createdAt = readIsoTimestamp(data.createdAt, 'task creation time');
  const updatedAt = readIsoTimestamp(data.updatedAt, 'task update time');
  const completedAt = readNullableIsoTimestamp(data.completedAt, 'task completion time');
  if (updatedAt < createdAt || (status === 'completed') !== (completedAt !== null)) {
    throw new DataPackageError('The task timestamps or completion state are invalid.');
  }
  if (completedAt !== null && (completedAt < createdAt || updatedAt < completedAt)) {
    throw new DataPackageError('The task completion timestamp ordering is invalid.');
  }
  return {
    id: normalizedValue(data.id, normalizeTaskId, 'task id'),
    workspaceId: normalizedValue(data.workspaceId, normalizeWorkspaceId, 'task workspace id'),
    title: normalizedValue(data.title, normalizeTaskTitle, 'task title'),
    status,
    plannedFor:
      data.plannedFor === null
        ? null
        : normalizedValue(data.plannedFor, normalizeTaskCivilDate, 'task planned date'),
    sourceInboxEntryId:
      data.sourceInboxEntryId === null
        ? null
        : normalizedValue(data.sourceInboxEntryId, normalizeInboxId, 'task inbox source'),
    createdAt,
    updatedAt,
    completedAt,
  };
}

function decodeNote(value: unknown): NoteRecord {
  const data = exactPayload(
    value,
    [
      'archivedAt',
      'body',
      'createdAt',
      'id',
      'revision',
      'sourceInboxEntryId',
      'title',
      'updatedAt',
      'workspaceId',
    ],
    'note',
  );
  const createdAt = readIsoTimestamp(data.createdAt, 'note creation time');
  const updatedAt = readIsoTimestamp(data.updatedAt, 'note update time');
  const archivedAt = readNullableIsoTimestamp(data.archivedAt, 'note archive time');
  assertTimestampOrder(createdAt, updatedAt, archivedAt, 'note');
  return {
    id: normalizedValue(data.id, normalizeNoteId, 'note id'),
    workspaceId: normalizedValue(data.workspaceId, normalizeWorkspaceId, 'note workspace id'),
    title: normalizedValue(data.title, normalizeNoteTitle, 'note title'),
    body: normalizedValue(data.body, normalizeNoteBody, 'note body'),
    revision: normalizedValue(data.revision, normalizeNoteRevision, 'note revision'),
    sourceInboxEntryId:
      data.sourceInboxEntryId === null
        ? null
        : normalizedValue(data.sourceInboxEntryId, normalizeInboxId, 'note inbox source'),
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function decodeScheduleItem(value: unknown): ScheduleItemRecord {
  const data = exactPayload(
    value,
    [
      'archivedAt',
      'createdAt',
      'endMinute',
      'id',
      'kind',
      'revision',
      'scheduledFor',
      'startMinute',
      'title',
      'updatedAt',
      'workspaceId',
    ],
    'schedule item',
  );
  let range;
  try {
    range = normalizeScheduleRange(data.startMinute, data.endMinute);
  } catch (error) {
    throw new DataPackageError('The schedule item time range is invalid.', { cause: error });
  }
  const createdAt = readIsoTimestamp(data.createdAt, 'schedule creation time');
  const updatedAt = readIsoTimestamp(data.updatedAt, 'schedule update time');
  const archivedAt = readNullableIsoTimestamp(data.archivedAt, 'schedule archive time');
  assertTimestampOrder(createdAt, updatedAt, archivedAt, 'schedule item');
  return {
    id: normalizedValue(data.id, normalizeScheduleId, 'schedule item id'),
    workspaceId: normalizedValue(data.workspaceId, normalizeWorkspaceId, 'schedule workspace id'),
    title: normalizedValue(data.title, normalizeScheduleTitle, 'schedule title'),
    kind: normalizedValue(data.kind, normalizeScheduleKind, 'schedule kind'),
    scheduledFor: normalizedValue(data.scheduledFor, normalizeScheduleCivilDate, 'schedule date'),
    startMinute: range.startMinute,
    endMinute: range.endMinute,
    revision: normalizedValue(data.revision, normalizeScheduleRevision, 'schedule revision'),
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function decodeBrowserTab(value: unknown): BrowserTabRecord {
  const data = exactPayload(
    value,
    ['createdAt', 'id', 'title', 'updatedAt', 'url', 'workspaceId'],
    'browser tab',
  );
  const createdAt = readIsoTimestamp(data.createdAt, 'browser tab creation time');
  const updatedAt = readIsoTimestamp(data.updatedAt, 'browser tab update time');
  if (updatedAt < createdAt) {
    throw new DataPackageError('The browser tab update time precedes its creation time.');
  }
  return {
    id: normalizedValue(data.id, normalizeBrowserId, 'browser tab id'),
    workspaceId: normalizedValue(
      data.workspaceId,
      normalizeWorkspaceId,
      'browser tab workspace id',
    ),
    url: normalizedValue(data.url, normalizeBrowserUrl, 'browser tab URL'),
    title: normalizedValue(data.title, normalizeBrowserTitle, 'browser tab title'),
    createdAt,
    updatedAt,
  };
}

function decodeBrowserState(value: unknown): BrowserStateRecord {
  const data = exactPayload(
    value,
    ['activeTabId', 'revision', 'updatedAt', 'workspaceId'],
    'browser state',
  );
  return {
    workspaceId: normalizedValue(
      data.workspaceId,
      normalizeWorkspaceId,
      'browser state workspace id',
    ),
    activeTabId: normalizedValue(data.activeTabId, normalizeBrowserId, 'active browser tab id'),
    revision: normalizedValue(data.revision, normalizeBrowserRevision, 'browser state revision'),
    updatedAt: readIsoTimestamp(data.updatedAt, 'browser state update time'),
  };
}

function decodeBrowserBookmark(value: unknown): BrowserBookmarkRecord {
  const data = exactPayload(
    value,
    ['createdAt', 'id', 'title', 'url', 'workspaceId'],
    'browser bookmark',
  );
  const url = normalizedValue(data.url, normalizeBrowserUrl, 'browser bookmark URL');
  if (url === 'about:blank') {
    throw new DataPackageError('A browser bookmark must use HTTP or HTTPS.');
  }
  return {
    id: normalizedValue(data.id, normalizeBrowserId, 'browser bookmark id'),
    workspaceId: normalizedValue(
      data.workspaceId,
      normalizeWorkspaceId,
      'browser bookmark workspace id',
    ),
    url,
    title: normalizedValue(data.title, normalizeBrowserTitle, 'browser bookmark title'),
    createdAt: readIsoTimestamp(data.createdAt, 'browser bookmark creation time'),
  };
}

function decodeAutomationDefinition(value: unknown): AutomationDefinitionRecord {
  const data = exactPayload(
    value,
    [
      'action',
      'archivedAt',
      'createdAt',
      'enabled',
      'id',
      'name',
      'revision',
      'schedule',
      'updatedAt',
      'workspaceId',
    ],
    'automation definition',
  );
  const schedulePayload = exactPayload(
    data.schedule,
    ['cadence', 'localTimeMinute', 'weekday'],
    'automation schedule',
  );
  const actionValue = data.action;
  if (!isPlainObject(actionValue) || typeof actionValue.kind !== 'string') {
    throw new DataPackageError('The data package automation action is invalid.');
  }
  const actionPayload = exactPayload(
    actionValue,
    actionValue.kind === 'create-today-task' ? ['kind', 'title'] : ['body', 'kind', 'title'],
    'automation action',
  );
  let schedule: AutomationSchedule;
  let action: AutomationAction;
  try {
    schedule = normalizeAutomationSchedule(schedulePayload);
    action = normalizeAutomationAction(actionPayload);
    if (
      canonicalJson(schedule) !== canonicalJson(schedulePayload) ||
      canonicalJson(action) !== canonicalJson(actionPayload)
    ) {
      throw new TypeError('Automation values are not in persisted form.');
    }
  } catch (error) {
    throw new DataPackageError('The data package automation schedule or action is invalid.', {
      cause: error,
    });
  }
  if (typeof data.enabled !== 'boolean') {
    throw new DataPackageError('The data package automation enabled state is invalid.');
  }
  const createdAt = readIsoTimestamp(data.createdAt, 'automation creation time');
  const updatedAt = readIsoTimestamp(data.updatedAt, 'automation update time');
  const archivedAt = readNullableIsoTimestamp(data.archivedAt, 'automation archive time');
  assertTimestampOrder(createdAt, updatedAt, archivedAt, 'automation');
  if (archivedAt !== null && data.enabled) {
    throw new DataPackageError('An archived automation cannot be enabled.');
  }
  return {
    id: normalizedValue(data.id, normalizeAutomationId, 'automation id'),
    workspaceId: normalizedValue(data.workspaceId, normalizeWorkspaceId, 'automation workspace id'),
    name: normalizedValue(data.name, normalizeAutomationName, 'automation name'),
    enabled: data.enabled,
    schedule,
    action,
    revision: normalizedValue(data.revision, normalizeAutomationRevision, 'automation revision'),
    createdAt,
    updatedAt,
    archivedAt,
  };
}

function validatePortableRelationships(model: PortableDatabaseModel): void {
  if (model.workspaces.length === 0) {
    throw new DataPackageError('The data package contains no workspaces.');
  }
  const workspaces = uniqueMap(model.workspaces, ({ id }) => id, 'workspace');
  const activeNameKeys = new Set<string>();
  let activeCount = 0;
  for (const workspace of model.workspaces) {
    if (workspace.archivedAt === null) {
      activeCount += 1;
      const nameKey = createWorkspaceNameKey(workspace.name);
      if (activeNameKeys.has(nameKey)) {
        throw new DataPackageError('The data package repeats an active workspace name.');
      }
      activeNameKeys.add(nameKey);
    }
  }
  if (activeCount < 1) {
    throw new DataPackageError('The data package contains no active workspace.');
  }
  const currentWorkspace = workspaces.get(model.appState.currentWorkspaceId);
  if (!currentWorkspace || currentWorkspace.archivedAt !== null) {
    throw new DataPackageError('The data package current workspace is missing or archived.');
  }
  const preferences = uniqueMap(
    model.preferences,
    ({ workspaceId }) => workspaceId,
    'workspace preference',
  );
  if (preferences.size !== workspaces.size) {
    throw new DataPackageError('Every imported workspace must have one preference record.');
  }
  for (const preference of model.preferences) {
    requireWorkspace(workspaces, preference.workspaceId, 'workspace preference');
  }

  const inboxEntries = uniqueMap(model.inboxEntries, ({ id }) => id, 'inbox entry');
  for (const entry of model.inboxEntries) {
    requireWorkspace(workspaces, entry.workspaceId, 'inbox entry');
  }

  uniqueMap(model.tasks, ({ id }) => id, 'task');
  uniqueMap(model.notes, ({ id }) => id, 'note');
  const usedInboxSources = new Set<string>();
  for (const items of [model.tasks, model.notes]) {
    for (const item of items) {
      requireWorkspace(workspaces, item.workspaceId, 'inbox conversion');
      if (item.sourceInboxEntryId === null) continue;
      const source = inboxEntries.get(item.sourceInboxEntryId);
      if (
        !source ||
        source.workspaceId !== item.workspaceId ||
        source.archivedAt === null ||
        usedInboxSources.has(item.sourceInboxEntryId)
      ) {
        throw new DataPackageError(
          'An imported task or note has a missing, active, reused, or cross-workspace inbox source.',
        );
      }
      usedInboxSources.add(item.sourceInboxEntryId);
    }
  }

  uniqueMap(model.scheduleItems, ({ id }) => id, 'schedule item');
  for (const item of model.scheduleItems) {
    requireWorkspace(workspaces, item.workspaceId, 'schedule item');
  }

  const tabs = uniqueMap(model.browserTabs, ({ id }) => id, 'browser tab');
  const states = uniqueMap(
    model.browserStates,
    ({ workspaceId }) => workspaceId,
    'browser workspace state',
  );
  uniqueMap(model.browserBookmarks, ({ id }) => id, 'browser bookmark');
  const tabCounts = new Map<string, number>();
  const bookmarkCounts = new Map<string, number>();
  const latestBrowserTimestamp = new Map<string, string>();
  const bookmarkUrls = new Set<string>();

  for (const tab of model.browserTabs) {
    requireWorkspace(workspaces, tab.workspaceId, 'browser tab');
    if (!states.has(tab.workspaceId)) {
      throw new DataPackageError('An imported browser tab has no workspace state.');
    }
    tabCounts.set(tab.workspaceId, (tabCounts.get(tab.workspaceId) ?? 0) + 1);
    updateLatestTimestamp(latestBrowserTimestamp, tab.workspaceId, tab.updatedAt);
  }
  for (const bookmark of model.browserBookmarks) {
    requireWorkspace(workspaces, bookmark.workspaceId, 'browser bookmark');
    if (!states.has(bookmark.workspaceId)) {
      throw new DataPackageError('An imported browser bookmark has no workspace state.');
    }
    const urlKey = `${bookmark.workspaceId}\0${bookmark.url}`;
    if (bookmarkUrls.has(urlKey)) {
      throw new DataPackageError('The data package repeats a workspace bookmark URL.');
    }
    bookmarkUrls.add(urlKey);
    bookmarkCounts.set(bookmark.workspaceId, (bookmarkCounts.get(bookmark.workspaceId) ?? 0) + 1);
    updateLatestTimestamp(latestBrowserTimestamp, bookmark.workspaceId, bookmark.createdAt);
  }
  for (const state of model.browserStates) {
    requireWorkspace(workspaces, state.workspaceId, 'browser state');
    const activeTab = tabs.get(state.activeTabId);
    if (!activeTab || activeTab.workspaceId !== state.workspaceId) {
      throw new DataPackageError(
        'An imported browser state points to a missing or cross-workspace tab.',
      );
    }
    if ((latestBrowserTimestamp.get(state.workspaceId) ?? state.updatedAt) > state.updatedAt) {
      throw new DataPackageError('An imported browser state predates its workspace browser data.');
    }
  }
  for (const [workspaceId, count] of tabCounts) {
    if (count < 1 || count > BROWSER_MAX_TABS || !states.has(workspaceId)) {
      throw new DataPackageError('The imported browser tab count is invalid.');
    }
  }
  for (const [workspaceId, count] of bookmarkCounts) {
    if (count < 1 || count > BROWSER_MAX_BOOKMARKS || !states.has(workspaceId)) {
      throw new DataPackageError('The imported browser bookmark count is invalid.');
    }
  }

  uniqueMap(model.automations, ({ id }) => id, 'automation');
  const enabledAutomationCounts = new Map<string, number>();
  for (const automation of model.automations) {
    const workspace = requireWorkspace(workspaces, automation.workspaceId, 'automation');
    if (workspace.archivedAt !== null && automation.enabled) {
      throw new DataPackageError('An automation in an archived workspace cannot be enabled.');
    }
    if (!automation.enabled) continue;
    const enabled = (enabledAutomationCounts.get(automation.workspaceId) ?? 0) + 1;
    if (enabled > AUTOMATION_ENABLED_WORKSPACE_LIMIT) {
      throw new DataPackageError('The imported enabled automation count is invalid.');
    }
    enabledAutomationCounts.set(automation.workspaceId, enabled);
  }
}

function updateLatestTimestamp(
  timestamps: Map<string, string>,
  workspaceId: string,
  candidate: string,
): void {
  const current = timestamps.get(workspaceId);
  if (current === undefined || candidate > current) {
    timestamps.set(workspaceId, candidate);
  }
}

function insertPortableModel(database: SqliteAdapter, model: PortableDatabaseModel): void {
  if (!database.isTransaction) {
    throw new DatabaseIntegrityError('Import data writes require an active transaction.');
  }
  const temporaryNames = createTemporaryWorkspaceNames(model.workspaces);
  for (const workspace of model.workspaces) {
    const temporaryName =
      workspace.archivedAt === null ? workspace.name : temporaryNames.get(workspace.id);
    if (!temporaryName) {
      throw new DatabaseIntegrityError('An archived workspace staging name is missing.');
    }
    database.run(
      `INSERT INTO workspaces (
         id, name, name_key, color, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [
        workspace.id,
        temporaryName,
        createWorkspaceNameKey(temporaryName),
        workspace.color,
        workspace.createdAt,
        workspace.updatedAt,
      ],
    );
  }
  for (const preference of model.preferences) {
    database.run(
      `INSERT INTO workspace_preferences (
         workspace_id, active_view, theme, sidebar_collapsed, browser_open,
         browser_width, terminal_open, terminal_height, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        preference.workspaceId,
        preference.activeView,
        preference.theme,
        toSqlBoolean(preference.sidebarCollapsed),
        toSqlBoolean(preference.browserOpen),
        preference.browserWidth,
        toSqlBoolean(preference.terminalOpen),
        preference.terminalHeight,
        preference.updatedAt,
      ],
    );
  }
  database.run(
    `INSERT INTO workspace_app_state (singleton, current_workspace_id, updated_at)
     VALUES (1, ?, ?)`,
    [model.appState.currentWorkspaceId, model.appState.updatedAt],
  );
  for (const entry of model.inboxEntries) {
    database.run(
      `INSERT INTO inbox_entries (
         id, workspace_id, content, category, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.workspaceId,
        entry.content,
        entry.category,
        entry.createdAt,
        entry.updatedAt,
        entry.archivedAt,
      ],
    );
  }
  for (const task of model.tasks) {
    database.run(
      `INSERT INTO tasks (
         id, workspace_id, title, status, planned_for, source_inbox_entry_id,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.workspaceId,
        task.title,
        task.status,
        task.plannedFor,
        task.sourceInboxEntryId,
        task.createdAt,
        task.updatedAt,
        task.completedAt,
      ],
    );
  }
  for (const note of model.notes) {
    database.run(
      `INSERT INTO notes (
         id, workspace_id, title, body, revision, source_inbox_entry_id,
         created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        note.id,
        note.workspaceId,
        note.title,
        note.body,
        note.revision,
        note.sourceInboxEntryId,
        note.createdAt,
        note.updatedAt,
        note.archivedAt,
      ],
    );
  }
  for (const item of model.scheduleItems) {
    database.run(
      `INSERT INTO schedule_items (
         id, workspace_id, title, kind, scheduled_for, start_minute, end_minute,
         revision, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.workspaceId,
        item.title,
        item.kind,
        item.scheduledFor,
        item.startMinute,
        item.endMinute,
        item.revision,
        item.createdAt,
        item.updatedAt,
        item.archivedAt,
      ],
    );
  }
  for (const tab of model.browserTabs) {
    database.run(
      `INSERT INTO browser_tabs (
         id, workspace_id, url, title, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [tab.id, tab.workspaceId, tab.url, tab.title, tab.createdAt, tab.updatedAt],
    );
  }
  for (const state of model.browserStates) {
    database.run(
      `INSERT INTO browser_workspace_state (
         workspace_id, active_tab_id, revision, updated_at
       ) VALUES (?, ?, ?, ?)`,
      [state.workspaceId, state.activeTabId, state.revision, state.updatedAt],
    );
  }
  for (const bookmark of model.browserBookmarks) {
    database.run(
      `INSERT INTO browser_bookmarks (id, workspace_id, url, title, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [bookmark.id, bookmark.workspaceId, bookmark.url, bookmark.title, bookmark.createdAt],
    );
  }
  const automationsByWorkspace = new Map<string, AutomationDefinitionRecord[]>();
  for (const automation of model.automations) {
    const definitions = automationsByWorkspace.get(automation.workspaceId) ?? [];
    definitions.push(automation);
    automationsByWorkspace.set(automation.workspaceId, definitions);
  }
  for (const workspace of model.workspaces) {
    if (workspace.archivedAt === null) continue;
    for (const automation of automationsByWorkspace.get(workspace.id) ?? []) {
      insertAutomationDefinition(database, automation);
    }
    archiveImportedWorkspace(database, workspace);
  }
  for (const workspace of model.workspaces) {
    if (workspace.archivedAt !== null) continue;
    for (const automation of automationsByWorkspace.get(workspace.id) ?? []) {
      insertAutomationDefinition(database, automation);
    }
  }
}

function insertAutomationDefinition(
  database: SqliteAdapter,
  automation: AutomationDefinitionRecord,
): void {
  database.run(
    `INSERT INTO automations (
       id, workspace_id, name, cadence, local_time_minute, weekday,
       action_kind, action_title, action_body, enabled, effective_at,
       revision, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
    [
      automation.id,
      automation.workspaceId,
      automation.name,
      automation.schedule.cadence,
      automation.schedule.localTimeMinute,
      automation.schedule.weekday,
      automation.action.kind,
      automation.action.title,
      automation.action.kind === 'create-note' ? automation.action.body : null,
      automation.revision,
      automation.createdAt,
      automation.updatedAt,
      automation.archivedAt,
    ],
  );
}

function archiveImportedWorkspace(database: SqliteAdapter, workspace: WorkspaceRecord): void {
  if (workspace.archivedAt === null) {
    throw new DatabaseIntegrityError('An active imported workspace cannot be archived.');
  }
  const result = database.run(
    `UPDATE workspaces
     SET name = ?, name_key = ?, archived_at = ?
     WHERE id = ? AND archived_at IS NULL`,
    [workspace.name, createWorkspaceNameKey(workspace.name), workspace.archivedAt, workspace.id],
  );
  if (Number(result.changes) !== 1) {
    throw new DatabaseIntegrityError('An imported workspace could not be archived.');
  }
}

function createTemporaryWorkspaceNames(
  workspaces: readonly WorkspaceRecord[],
): ReadonlyMap<string, string> {
  const usedKeys = new Set(
    workspaces
      .filter(({ archivedAt }) => archivedAt === null)
      .map(({ name }) => createWorkspaceNameKey(name)),
  );
  const result = new Map<string, string>();
  for (const workspace of workspaces) {
    if (workspace.archivedAt === null) continue;
    const base = `Import ${workspace.id}`;
    let candidate = base;
    let suffix = 1;
    while (usedKeys.has(createWorkspaceNameKey(candidate))) {
      candidate = `${base} ${suffix}`;
      suffix += 1;
    }
    usedKeys.add(createWorkspaceNameKey(candidate));
    result.set(workspace.id, candidate);
  }
  return result;
}

function insertLocalBackupState(
  database: SqliteAdapter,
  policy: BackupPolicy,
  timestamp: string,
): void {
  database.run(
    `INSERT INTO backup_policy (
       singleton, enabled, cadence, local_time_minute, weekday,
       retention_count, revision, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toSqlBoolean(policy.enabled),
      policy.cadence,
      policy.localTimeMinute,
      policy.weekday,
      policy.retentionCount,
      policy.revision,
      policy.updatedAt,
    ],
  );
  database.run(
    `INSERT INTO backup_run_state (
       singleton, last_attempt_at, last_success_at, last_success_bucket,
       last_error_code, consecutive_failures, updated_at
     ) VALUES (1, NULL, NULL, NULL, NULL, 0, ?)`,
    [timestamp],
  );
}

function validateDatabaseSnapshot(
  database: SqliteAdapter,
  migrations: readonly Migration[],
  expectedBackupPolicy?: BackupPolicy,
): void {
  assertCurrentMigrationSet(migrations);
  const migrationRunner = new MigrationRunner(migrations);
  const applied = migrationRunner.validateApplied(database);
  if (
    applied.length !== PORTABLE_DATABASE_SCHEMA_VERSION ||
    applied.at(-1)?.version !== PORTABLE_DATABASE_SCHEMA_VERSION
  ) {
    throw new DatabaseIntegrityError('The portable database schema is not current.');
  }

  const quickCheck = database.all<Record<string, unknown>>('PRAGMA quick_check');
  if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok') {
    throw new DatabaseIntegrityError('The portable database quick check failed.');
  }
  if (database.all<Record<string, unknown>>('PRAGMA foreign_key_check').length !== 0) {
    throw new DatabaseIntegrityError('The portable database contains foreign-key violations.');
  }

  new MetadataRepository(database).read();
  const execute = async <T>(operation: (target: SqliteAdapter) => Promise<T> | T): Promise<T> =>
    operation(database);
  new WorkspaceService({ execute }).validateSnapshot(database);
  new TerminalPreferenceRepository(database).validateSnapshot();
  new InboxService({ execute }).validateSnapshot(database);
  new TaskService({ execute }).validateSnapshot(database);
  new NoteService({ execute }).validateSnapshot(database);
  new ScheduleService({ execute }).validateSnapshot(database);
  new BrowserService({ execute }).validateSnapshot(database);
  new SearchService({ execute }).validateSnapshot(database);
  new AutomationRepository(database).validateSnapshot();

  const backup = new BackupPolicyRepository(database);
  const policy = backup.readPolicy();
  const runState = backup.readRunState();
  if (expectedBackupPolicy && !sameBackupPolicy(policy, expectedBackupPolicy)) {
    throw new DatabaseIntegrityError(
      'The staged database did not preserve the local backup policy.',
    );
  }
  if (
    expectedBackupPolicy &&
    (runState.lastAttemptAt !== null ||
      runState.lastSuccessAt !== null ||
      runState.lastSuccessBucket !== null ||
      runState.lastErrorCode !== null ||
      runState.consecutiveFailures !== 0)
  ) {
    throw new DatabaseIntegrityError('The staged database backup run state is not fresh.');
  }
  if (expectedBackupPolicy) validateImportedAutomationState(database);
}

function validateImportedAutomationState(database: SqliteAdapter): void {
  const activeState = database.get<{ present: unknown }>(
    `SELECT 1 AS present
     FROM automations
     WHERE enabled <> 0 OR effective_at IS NOT NULL
     LIMIT 1`,
  );
  const runState = database.get<{ present: unknown }>(
    `SELECT 1 AS present
     FROM automation_run_state
     WHERE last_attempt_at IS NOT NULL
        OR last_attempt_occurrence IS NOT NULL
        OR last_success_at IS NOT NULL
        OR last_success_occurrence IS NOT NULL
        OR last_output_kind IS NOT NULL
        OR last_error_code IS NOT NULL
        OR consecutive_failures <> 0
        OR next_retry_at IS NOT NULL
     LIMIT 1`,
  );
  const occurrence = database.get<{ present: unknown }>(
    `SELECT 1 AS present
     FROM automation_occurrences
     LIMIT 1`,
  );
  if (activeState || runState || occurrence) {
    throw new DatabaseIntegrityError(
      'The staged database automation definitions are not freshly paused.',
    );
  }
}

function configureStagingPragmas(
  database: SqliteAdapter,
  timeoutMs: number,
  maxDatabaseBytes: number,
): void {
  database.exec(`
    PRAGMA page_size = ${STAGING_DATABASE_PAGE_SIZE};
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = ${timeoutMs};
    PRAGMA trusted_schema = OFF;
  `);
  const pageSize = readPragmaInteger(database, 'page_size');
  if (pageSize !== STAGING_DATABASE_PAGE_SIZE) {
    throw new DatabaseIntegrityError('The import staging database page size is invalid.');
  }
  const allowedPages = Math.floor(maxDatabaseBytes / pageSize);
  if (allowedPages < 1) {
    throw new DatabaseIntegrityError('The import staging database size limit is too small.');
  }
  database.exec(`PRAGMA max_page_count = ${allowedPages}`);
  const journalMode = database.get<Record<string, unknown>>('PRAGMA journal_mode')?.journal_mode;
  if (journalMode !== 'delete') {
    throw new DatabaseIntegrityError('The import staging database is not a single-file journal.');
  }
  const maximumPages = readPragmaInteger(database, 'max_page_count');
  const currentPages = readPragmaInteger(database, 'page_count', true);
  if (
    maximumPages > allowedPages ||
    currentPages > allowedPages ||
    currentPages * pageSize > maxDatabaseBytes
  ) {
    throw new DatabaseIntegrityError('The import staging database exceeded its size limit.');
  }
}

function readPragmaInteger(database: SqliteAdapter, name: string, allowZero = false): number {
  const value = database.get<Record<string, unknown>>(`PRAGMA ${name}`)?.[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new DatabaseIntegrityError(`The import staging ${name} setting is invalid.`);
  }
  return value;
}

function validateFtsContentIntegrity(database: SqliteAdapter): void {
  for (const table of [
    'inbox_entries_search',
    'tasks_search',
    'notes_search',
    'schedule_items_search',
    'browser_tabs_search',
    'browser_bookmarks_search',
  ] as const) {
    database.run(`INSERT INTO ${table} (${table}, rank) VALUES ('integrity-check', 1)`);
  }
}

function pausePortableAutomations(model: PortableDatabaseModel): PortableDatabaseModel {
  return {
    ...model,
    automations: model.automations.map((automation) => ({
      ...automation,
      enabled: false,
    })),
  };
}

function digestPortableModel(model: PortableDatabaseModel): string {
  const hash = createHash('sha256');
  hash.update('daily-workbench-portable-database-v1\0', 'utf8');
  const append = (type: PortableRecordType, values: readonly unknown[]): void => {
    hash.update(`${type}\0${values.length}\0`, 'utf8');
    for (const value of values) {
      const canonical = canonicalJson(value);
      hash.update(`${Buffer.byteLength(canonical, 'utf8')}:`, 'utf8');
      hash.update(canonical, 'utf8');
    }
  };
  append('app-state', [model.appState]);
  append('workspace', model.workspaces);
  append('workspace-preference', model.preferences);
  append('inbox-entry', model.inboxEntries);
  append('task', model.tasks);
  append('note', model.notes);
  append('schedule-item', model.scheduleItems);
  append('browser-tab', model.browserTabs);
  append('browser-state', model.browserStates);
  append('browser-bookmark', model.browserBookmarks);
  append('automation-definition', model.automations);
  return hash.digest('hex');
}

function assertLogicalDigest(model: PortableDatabaseModel, expected: string): void {
  if (digestPortableModel(model) !== expected) {
    throw new DatabaseIntegrityError(
      'The staged database logical data does not match its import package.',
    );
  }
}

async function assertNoSqliteSidecars(databasePath: string): Promise<void> {
  for (const path of sqliteSidecarPaths(databasePath)) {
    const entry = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (entry) {
      throw new DatabaseIntegrityError('The import staging database left a journal sidecar.');
    }
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all(
    sqliteSidecarPaths(databasePath).map((path) =>
      rm(path, { force: true }).catch(() => undefined),
    ),
  );
}

function sqliteSidecarPaths(databasePath: string): readonly string[] {
  return [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
}

function assertCurrentMigrationSet(migrations: readonly Migration[]): void {
  const runner = new MigrationRunner(migrations);
  if (runner.latestVersion !== PORTABLE_DATABASE_SCHEMA_VERSION) {
    throw new TypeError('The import codec requires the current v9 migration set.');
  }
}

function validateBackupPolicy(value: BackupPolicy): BackupPolicy {
  if (!isPlainObject(value)) {
    throw new TypeError('The local backup policy is invalid.');
  }
  const expectedKeys = [
    'cadence',
    'enabled',
    'localTimeMinute',
    'retentionCount',
    'revision',
    'updatedAt',
    'weekday',
  ];
  if (!sameStringArray(Object.keys(value).sort(), expectedKeys)) {
    throw new TypeError('The local backup policy is invalid.');
  }
  if (
    typeof value.enabled !== 'boolean' ||
    (value.cadence !== 'daily' && value.cadence !== 'weekly') ||
    !isIntegerInRange(value.localTimeMinute, 0, 1_439) ||
    !isIntegerInRange(value.retentionCount, 1, 90) ||
    !isIntegerInRange(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
    (value.cadence === 'daily' && value.weekday !== null) ||
    (value.cadence === 'weekly' && !isIntegerInRange(value.weekday, 0, 6)) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    throw new TypeError('The local backup policy is invalid.');
  }
  return Object.freeze({ ...value });
}

function sameBackupPolicy(left: BackupPolicy, right: BackupPolicy): boolean {
  return (
    left.enabled === right.enabled &&
    left.cadence === right.cadence &&
    left.localTimeMinute === right.localTimeMinute &&
    left.weekday === right.weekday &&
    left.retentionCount === right.retentionCount &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt
  );
}

function readClockTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('The import database clock is invalid.');
  }
  return value.toISOString();
}

function countPortableModel(model: PortableDatabaseModel): DataImportCounts {
  return {
    workspaces: model.workspaces.length,
    archivedWorkspaces: model.workspaces.filter(({ archivedAt }) => archivedAt !== null).length,
    inboxEntries: model.inboxEntries.length,
    tasks: model.tasks.length,
    notes: model.notes.length,
    scheduleItems: model.scheduleItems.length,
    browserTabs: model.browserTabs.length,
    browserBookmarks: model.browserBookmarks.length,
    automations: model.automations.length,
    enabledAutomations: model.automations.filter(({ enabled }) => enabled).length,
  };
}

function sameCounts(left: DataImportCounts, right: DataImportCounts): boolean {
  if (!isPlainObject(left)) return false;
  const keys: readonly (keyof DataImportCounts)[] = [
    'archivedWorkspaces',
    'automations',
    'browserBookmarks',
    'browserTabs',
    'enabledAutomations',
    'inboxEntries',
    'notes',
    'scheduleItems',
    'tasks',
    'workspaces',
  ];
  if (!sameStringArray(Object.keys(left).sort(), [...keys])) return false;
  return keys.every((key) => left[key] === right[key]);
}

function requireWorkspace(
  workspaces: ReadonlyMap<string, WorkspaceRecord>,
  workspaceId: string,
  label: string,
): WorkspaceRecord {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) {
    throw new DataPackageError(`An imported ${label} points to a missing workspace.`);
  }
  return workspace;
}

function uniqueMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      throw new DataPackageError(`The data package repeats a ${label}.`);
    }
    result.set(key, value);
  }
  return result;
}

function sortBy<T>(values: readonly T[], keyOf: (value: T) => string): T[] {
  return [...values].sort((left, right) => {
    const leftKey = keyOf(left);
    const rightKey = keyOf(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function exactPayload(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  assertExactObjectKeys(value, keys, `The data package ${label} payload is invalid.`);
  return value as Record<string, unknown>;
}

function assertExactObjectKeys(value: unknown, keys: readonly string[], message: string): void {
  if (!isPlainObject(value) || !sameStringArray(Object.keys(value).sort(), [...keys].sort())) {
    throw new DataPackageError(message);
  }
}

function assertPlainObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new DataPackageError(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedValue<T>(value: unknown, normalize: (candidate: never) => T, label: string): T {
  try {
    const normalized = normalize(value as never);
    if (normalized !== value) {
      throw new TypeError('The value is not in persisted form.');
    }
    return normalized;
  } catch (error) {
    throw new DataPackageError(`The data package ${label} is invalid.`, { cause: error });
  }
}

function readIsoTimestamp(value: unknown, label: string): string {
  if (!isIsoTimestamp(value)) {
    throw new DataPackageError(`The data package ${label} is invalid.`);
  }
  return value;
}

function readNullableIsoTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : readIsoTimestamp(value, label);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function assertTimestampOrder(
  createdAt: string,
  updatedAt: string,
  archivedAt: string | null,
  label: string,
): void {
  if (
    updatedAt < createdAt ||
    (archivedAt !== null && (archivedAt < createdAt || updatedAt < archivedAt))
  ) {
    throw new DataPackageError(`The data package ${label} timestamp ordering is invalid.`);
  }
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function portableRecord(
  type: PortableRecordType,
  data: { readonly [key: string]: JsonValue },
): PortableDataRecord {
  return { type, data };
}

function readSqlString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${label}.`);
  }
  return value;
}

function readSqlNullableString(value: unknown, label: string): string | null {
  return value === null ? null : readSqlString(value, label);
}

function readSqlInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${label}.`);
  }
  return value as number;
}

function readSqlBoolean(value: unknown, label: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${label}.`);
  }
  return value === 1;
}

function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}
