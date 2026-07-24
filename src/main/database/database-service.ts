import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type {
  AutomationCreateInput,
  AutomationSetEnabledInput,
  AutomationSnapshot,
  AutomationTargetInput,
  AutomationUpdateInput,
  BackupPolicy,
  BackupPolicyUpdateInput,
  BackupRunErrorCode,
  DatabaseBackupInfo,
  DatabaseStatus,
  FocusSnapshot,
  FocusStartInput,
  FocusTargetInput,
  InboxArchiveResult,
  InboxCategorizeInput,
  InboxCreateInput,
  InboxSnapshot,
  InboxTargetInput,
  InboxUndoInput,
  NoteArchiveInput,
  NoteConversionResult,
  NoteConvertInboxInput,
  NoteCreateInput,
  NoteSnapshot,
  NoteUpdateInput,
  ScheduleCreateInput,
  ScheduleSnapshot,
  ScheduleTargetInput,
  ScheduleUpdateInput,
  SearchQueryInput,
  SearchSnapshot,
  TaskConversionResult,
  TaskConvertInboxInput,
  TaskCreateInput,
  TaskPlanningInput,
  TaskRenameInput,
  TaskSnapshot,
  TaskStatusInput,
  WorkspaceArchiveSnapshot,
  WorkspaceCreateInput,
  WorkspacePreferences,
  WorkspacePreferencesInput,
  WorkspaceRenameInput,
  WorkspaceRestoreInput,
  WorkspaceRestoreResult,
  WorkspaceSnapshot,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  AutomationService,
  type AutomationRunInput,
  type AutomationRunResult,
  type StoredAutomation,
} from '../automations';
import {
  BrowserService,
  type BrowserBookmarkDataInput,
  type BrowserCreateTabDataInput,
  type BrowserData,
  type BrowserTabDataInput,
  type BrowserTabMetadataInput,
  type BrowserWorkspaceDataInput,
} from '../browser';
import { readPortableDatabaseRecords, type PortableDataRecord } from '../data-portability';
import { FocusService, type FocusReconcileResult } from '../focus';
import { InboxService } from '../inbox';
import { NoteService } from '../notes';
import { ScheduleService } from '../schedule';
import { SearchService } from '../search';
import { TaskService } from '../tasks';
import { TerminalPreferenceRepository } from '../terminal/terminal-preference-repository';
import type {
  StoredTerminalPreferences,
  TerminalPreferenceStore,
  TerminalProfilePreferenceWrite,
  TerminalWorkingDirectoryPreferenceWrite,
  TerminalWslDistributionPreferenceWrite,
} from '../terminal/terminal-preference-types';
import { WORKSPACE_RECOVERY_SCHEMA_VERSION, WorkspaceService } from '../workspaces';
import { BackupManager, toDatabaseBackupInfo } from './backup-manager';
import { BackupPolicyRepository } from './backup-policy-repository';
import type { BackupSchedulerPersistentState } from './backup-scheduler';
import { DEFAULT_MIGRATIONS } from './default-migrations';
import {
  DatabaseError,
  DatabaseIntegrityError,
  DatabaseOpenError,
  DatabasePathError,
  DatabaseStateError,
} from './errors';
import { MetadataRepository } from './metadata-repository';
import { MigrationRunner } from './migration-runner';
import {
  databaseFileExists,
  prepareDatabaseBackupDirectory,
  prepareDatabaseDataDirectory,
  resolveDatabasePaths,
} from './paths';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from './sqlite-adapter';
import type {
  BackupReason,
  BackupResult,
  BackupRetentionResult,
  DatabaseHealth,
  DatabaseInitializationResult,
  Migration,
} from './types';

const DATABASE_INITIALIZATION_INTENT = 'database-initializing-v1';
const DATABASE_INITIALIZATION_INTENT_CONTENT = 'daily-workbench-database-initializing-v1\n';
const DATABASE_INITIALIZATION_SENTINEL = 'database-initialized-v1';
const DATABASE_INITIALIZATION_SENTINEL_CONTENT = 'daily-workbench-database-initialized-v1\n';

interface TextRow {
  value: string;
}

interface IntegrityRow {
  quick_check: string;
}

interface CheckpointRow {
  busy: unknown;
  log: unknown;
  checkpointed: unknown;
}

interface DatabaseFoundationHealth {
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly latestMigrationVersion: number;
  readonly appliedMigrations: number;
  readonly journalMode: 'wal';
  readonly foreignKeys: true;
  readonly busyTimeoutMs: number;
  readonly synchronous: 'normal';
  readonly trustedSchema: false;
  readonly integrity: 'ok';
}

export interface DatabaseServiceOptions {
  readonly dataDirectory: string;
  readonly databaseFileName?: string;
  readonly migrations?: readonly Migration[];
  readonly adapterFactory?: SqliteAdapterFactory;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly workspaceIdFactory?: () => string;
  readonly inboxIdFactory?: () => string;
  readonly inboxUndoTokenFactory?: () => string;
  readonly inboxMonotonicNowMs?: () => number;
  readonly taskIdFactory?: () => string;
  readonly taskTodayFactory?: () => string;
  readonly noteIdFactory?: () => string;
  readonly scheduleIdFactory?: () => string;
  readonly scheduleTodayFactory?: () => string;
  readonly focusIdFactory?: () => string;
  readonly focusTodayFactory?: () => string;
  readonly automationIdFactory?: () => string;
  readonly automationTaskIdFactory?: () => string;
  readonly automationNoteIdFactory?: () => string;
  readonly browserTabIdFactory?: () => string;
  readonly browserBookmarkIdFactory?: () => string;
}

type ServiceState = 'closed' | 'opening' | 'open' | 'closing' | 'poisoned';

export class DatabaseService implements TerminalPreferenceStore {
  readonly #paths;
  readonly #adapterFactory: SqliteAdapterFactory;
  readonly #migrationRunner: MigrationRunner;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #workspaceService: WorkspaceService;
  readonly #inboxService: InboxService;
  readonly #taskService: TaskService;
  readonly #noteService: NoteService;
  readonly #scheduleService: ScheduleService;
  readonly #focusService: FocusService;
  readonly #automationService: AutomationService;
  readonly #searchService: SearchService;
  readonly #browserService: BrowserService;
  #state: ServiceState = 'closed';
  #database: SqliteAdapter | undefined;
  #backupManager: BackupManager | undefined;
  #initialization: DatabaseInitializationResult | undefined;
  #openPromise: Promise<DatabaseInitializationResult> | undefined;
  #closePromise: Promise<void> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #fatalOperationError: DatabaseIntegrityError | undefined;

  constructor({
    dataDirectory,
    databaseFileName,
    migrations = DEFAULT_MIGRATIONS,
    adapterFactory = createNodeSqliteAdapter,
    now = () => new Date(),
    idFactory = randomUUID,
    workspaceIdFactory = randomUUID,
    inboxIdFactory = randomUUID,
    inboxUndoTokenFactory = randomUUID,
    inboxMonotonicNowMs,
    taskIdFactory = randomUUID,
    taskTodayFactory,
    noteIdFactory = randomUUID,
    scheduleIdFactory = randomUUID,
    scheduleTodayFactory,
    focusIdFactory = randomUUID,
    focusTodayFactory,
    automationIdFactory = randomUUID,
    automationTaskIdFactory = randomUUID,
    automationNoteIdFactory = randomUUID,
    browserTabIdFactory = randomUUID,
    browserBookmarkIdFactory = randomUUID,
  }: DatabaseServiceOptions) {
    this.#paths = resolveDatabasePaths(dataDirectory, databaseFileName);
    this.#adapterFactory = adapterFactory;
    this.#migrationRunner = new MigrationRunner(migrations);
    this.#now = now;
    this.#idFactory = idFactory;
    this.#workspaceService = new WorkspaceService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      idFactory: workspaceIdFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
    this.#inboxService = new InboxService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      idFactory: inboxIdFactory,
      undoTokenFactory: inboxUndoTokenFactory,
      monotonicNowMs: inboxMonotonicNowMs,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
    this.#taskService = new TaskService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      idFactory: taskIdFactory,
      todayFactory: taskTodayFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
    this.#noteService = new NoteService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      idFactory: noteIdFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
    this.#scheduleService = new ScheduleService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      idFactory: scheduleIdFactory,
      todayFactory: scheduleTodayFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
    this.#focusService = new FocusService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      idFactory: focusIdFactory,
      todayFactory: focusTodayFactory ?? taskTodayFactory ?? scheduleTodayFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
    this.#automationService = new AutomationService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      automationIdFactory,
      taskIdFactory: automationTaskIdFactory,
      noteIdFactory: automationNoteIdFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
    this.#searchService = new SearchService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      todayFactory: scheduleTodayFactory,
    });
    this.#browserService = new BrowserService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      tabIdFactory: browserTabIdFactory,
      bookmarkIdFactory: browserBookmarkIdFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
  }

  async open(): Promise<DatabaseInitializationResult> {
    if (this.#state === 'open' && this.#initialization) {
      return this.#initialization;
    }
    if (this.#state === 'opening' && this.#openPromise) {
      return this.#openPromise;
    }
    if (this.#state === 'closing') {
      throw new DatabaseStateError('The database is closing.');
    }
    if (this.#state === 'poisoned' || this.#fatalOperationError) {
      throw new DatabaseStateError(
        'The database entered a fatal state and must be closed before it can reopen.',
        { cause: this.#fatalOperationError },
      );
    }

    this.#inboxService.clearUndoTokens();
    this.#fatalOperationError = undefined;
    this.#state = 'opening';
    this.#openPromise = this.#initialize();
    try {
      const result = await this.#openPromise;
      this.#initialization = result;
      this.#state = 'open';
      return result;
    } catch (error) {
      this.#database?.close();
      this.#database = undefined;
      this.#backupManager = undefined;
      this.#initialization = undefined;
      this.#fatalOperationError = undefined;
      this.#inboxService.clearUndoTokens();
      this.#state = 'closed';
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseOpenError('The database could not be opened.', { cause: error });
    } finally {
      this.#openPromise = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') {
      return;
    }
    if (this.#state === 'opening' && this.#openPromise) {
      try {
        await this.#openPromise;
      } catch {
        return;
      }
      return this.close();
    }
    if (this.#state === 'closing' && this.#closePromise) {
      return this.#closePromise;
    }

    this.#state = 'closing';
    this.#closePromise = (async () => {
      await this.#operationTail;
      this.#inboxService.clearUndoTokens();
      const database = this.#database;
      let closeError: unknown;
      if (database?.isOpen) {
        try {
          const checkpoint = database.get<CheckpointRow>('PRAGMA wal_checkpoint(TRUNCATE)');
          if (
            !checkpoint ||
            !isNonNegativeInteger(checkpoint.busy) ||
            !isNonNegativeInteger(checkpoint.log) ||
            !isNonNegativeInteger(checkpoint.checkpointed) ||
            checkpoint.busy !== 0
          ) {
            throw new DatabaseIntegrityError(
              'The SQLite WAL could not be fully checkpointed during shutdown.',
            );
          }
        } catch (error) {
          closeError = error;
        }
        try {
          database.close();
        } catch (error) {
          closeError ??= error;
        }
      }
      this.#database = undefined;
      this.#backupManager = undefined;
      this.#initialization = undefined;
      this.#fatalOperationError = undefined;
      this.#state = 'closed';
      this.#closePromise = undefined;
      if (closeError) {
        throw new DatabaseOpenError('The database could not be checkpointed during shutdown.', {
          cause: closeError,
        });
      }
    })();
    return this.#closePromise;
  }

  async validateExistingFile(): Promise<void> {
    if (this.#state !== 'closed') {
      throw new DatabaseStateError(
        'An existing database file can only be validated by a closed service.',
      );
    }
    if (!(await databaseFileExists(this.#paths.databasePath))) {
      throw new DatabasePathError('The database file is missing.');
    }
    const before = await lstat(this.#paths.databasePath);

    const snapshot = this.#adapterFactory(this.#paths.databasePath, {
      readOnly: true,
      timeoutMs: 5_000,
    });
    try {
      snapshot.open();
      const opened = await assertOpenedDatabasePath(snapshot, this.#paths.databasePath);
      if (!samePreOpenFile(before, opened)) {
        throw new DatabasePathError('The existing database changed before it could be opened.');
      }
      snapshot.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        PRAGMA trusted_schema = OFF;
        PRAGMA query_only = ON;
      `);
      this.#validateSnapshot(snapshot, this.#migrationRunner.latestVersion);
      const after = await assertOpenedDatabasePath(snapshot, this.#paths.databasePath);
      if (!samePreOpenFile(opened, after)) {
        throw new DatabasePathError('The existing database changed while it was validated.');
      }
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseOpenError('The existing database file could not be validated.', {
        cause: error,
      });
    } finally {
      snapshot.close();
    }
  }

  getStatus(): Promise<DatabaseStatus> {
    return this.#enqueue(async (database, backups) => {
      const health = this.#readHealth(database);
      return {
        schemaVersion: health.schemaVersion,
        appliedMigrations: health.appliedMigrations,
        sqliteVersion: health.sqliteVersion,
        journalMode: health.journalMode,
        integrityCheck: health.integrity,
        backupCount: await backups.count(),
      };
    });
  }

  createBackup(): Promise<DatabaseBackupInfo> {
    return this.#createBackup('manual');
  }

  listBackups(): Promise<DatabaseBackupInfo[]> {
    return this.#enqueue((_database, backups) => backups.list());
  }

  validateExistingBackup(
    backupId: string,
    expectedReason: BackupReason,
  ): Promise<DatabaseBackupInfo> {
    if (this.#state === 'open') {
      return this.#enqueue((_database, backups) =>
        backups.validateReference(backupId, expectedReason),
      );
    }
    if (this.#state === 'closed') {
      return this.#createBackupManager().validateReference(backupId, expectedReason);
    }
    return Promise.reject(
      new DatabaseStateError(
        'A database backup cannot be validated while the database is changing state.',
      ),
    );
  }

  readPortableRecords(): Promise<readonly PortableDataRecord[]> {
    return this.#enqueue((database) =>
      readPortableDatabaseRecords(database, DEFAULT_MIGRATIONS, this.#now),
    );
  }

  getBackupSchedulerState(): Promise<BackupSchedulerPersistentState> {
    return this.#enqueue((database) => {
      const repository = new BackupPolicyRepository(database);
      const policy = repository.readPolicy();
      const runState = repository.readRunState();
      return {
        policy,
        lastAttemptAt: runState.lastAttemptAt,
        lastSuccessAt: runState.lastSuccessAt,
        lastSuccessBucket: runState.lastSuccessBucket,
        lastErrorCode: runState.lastErrorCode,
        consecutiveFailures: runState.consecutiveFailures,
      };
    });
  }

  updateBackupPolicy(input: BackupPolicyUpdateInput): Promise<BackupPolicy> {
    return this.#enqueue((database) =>
      new BackupPolicyRepository(database).updatePolicy(input, this.#now().toISOString()),
    );
  }

  recordBackupAttempt(timestamp: string): Promise<void> {
    return this.#enqueue((database) => {
      new BackupPolicyRepository(database).recordAttempt(timestamp);
    });
  }

  recordBackupResult(input: {
    readonly attemptedAt: string;
    readonly completedAt: string;
    readonly successfulBucket?: string;
    readonly errorCode?: BackupRunErrorCode;
  }): Promise<void> {
    return this.#enqueue((database) => {
      new BackupPolicyRepository(database).recordResult(input);
    });
  }

  createScheduledBackup(): Promise<DatabaseBackupInfo> {
    return this.#createBackup('scheduled');
  }

  createPreImportBackup(): Promise<DatabaseBackupInfo> {
    return this.#createBackup('pre-import');
  }

  pruneScheduledBackups(protectedBackupId: string): Promise<BackupRetentionResult> {
    return this.#enqueue((database, backups) => {
      const policy = new BackupPolicyRepository(database).readPolicy();
      return backups.pruneScheduled(policy.retentionCount, protectedBackupId);
    });
  }

  getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.getSnapshot();
  }

  getWorkspaceArchiveSnapshot(): Promise<WorkspaceArchiveSnapshot> {
    return this.#workspaceService.getArchiveSnapshot();
  }

  createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.create(input);
  }

  renameWorkspace(input: WorkspaceRenameInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.rename(input);
  }

  activateWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.activate(input);
  }

  archiveWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.archive(input);
  }

  restoreWorkspace(input: WorkspaceRestoreInput): Promise<WorkspaceRestoreResult> {
    return this.#workspaceService.restore(input);
  }

  updateWorkspacePreferences(input: WorkspacePreferencesInput): Promise<WorkspacePreferences> {
    return this.#workspaceService.updatePreferences(input);
  }

  getTerminalPreferences(workspaceId: string): Promise<StoredTerminalPreferences> {
    return this.#enqueue((database) =>
      new TerminalPreferenceRepository(database).read(workspaceId),
    );
  }

  updateTerminalProfilePreference(
    input: TerminalProfilePreferenceWrite,
  ): Promise<StoredTerminalPreferences> {
    return this.#enqueue((database) =>
      new TerminalPreferenceRepository(database).updateProfile(input, this.#now().toISOString()),
    );
  }

  updateTerminalWorkingDirectoryPreference(
    input: TerminalWorkingDirectoryPreferenceWrite,
  ): Promise<StoredTerminalPreferences> {
    return this.#enqueue((database) =>
      new TerminalPreferenceRepository(database).updateWorkingDirectory(
        input,
        this.#now().toISOString(),
      ),
    );
  }

  updateTerminalWslDistributionPreference(
    input: TerminalWslDistributionPreferenceWrite,
  ): Promise<StoredTerminalPreferences> {
    return this.#enqueue((database) =>
      new TerminalPreferenceRepository(database).updateWslDistribution(
        input,
        this.#now().toISOString(),
      ),
    );
  }

  getInboxSnapshot(input: WorkspaceTargetInput): Promise<InboxSnapshot> {
    return this.#inboxService.getSnapshot(input);
  }

  createInboxEntry(input: InboxCreateInput): Promise<InboxSnapshot> {
    return this.#inboxService.create(input);
  }

  categorizeInboxEntry(input: InboxCategorizeInput): Promise<InboxSnapshot> {
    return this.#inboxService.categorize(input);
  }

  archiveInboxEntry(input: InboxTargetInput): Promise<InboxArchiveResult> {
    return this.#inboxService.archive(input);
  }

  undoInboxArchive(input: InboxUndoInput): Promise<InboxSnapshot> {
    return this.#inboxService.undoArchive(input);
  }

  getTaskSnapshot(input: WorkspaceTargetInput): Promise<TaskSnapshot> {
    return this.#taskService.getSnapshot(input);
  }

  createTask(input: TaskCreateInput): Promise<TaskSnapshot> {
    return this.#taskService.create(input);
  }

  renameTask(input: TaskRenameInput): Promise<TaskSnapshot> {
    return this.#taskService.rename(input);
  }

  updateTaskStatus(input: TaskStatusInput): Promise<TaskSnapshot> {
    return this.#taskService.updateStatus(input);
  }

  updateTaskPlanning(input: TaskPlanningInput): Promise<TaskSnapshot> {
    return this.#taskService.updatePlanning(input);
  }

  convertInboxToTask(input: TaskConvertInboxInput): Promise<TaskConversionResult> {
    return this.#taskService.convertInbox(input);
  }

  getNoteSnapshot(input: WorkspaceTargetInput): Promise<NoteSnapshot> {
    return this.#noteService.getSnapshot(input);
  }

  createNote(input: NoteCreateInput): Promise<NoteSnapshot> {
    return this.#noteService.create(input);
  }

  updateNote(input: NoteUpdateInput): Promise<NoteSnapshot> {
    return this.#noteService.update(input);
  }

  archiveNote(input: NoteArchiveInput): Promise<NoteSnapshot> {
    return this.#noteService.archive(input);
  }

  convertInboxToNote(input: NoteConvertInboxInput): Promise<NoteConversionResult> {
    return this.#noteService.convertInbox(input);
  }

  getScheduleSnapshot(input: WorkspaceTargetInput): Promise<ScheduleSnapshot> {
    return this.#scheduleService.getSnapshot(input);
  }

  createScheduleItem(input: ScheduleCreateInput): Promise<ScheduleSnapshot> {
    return this.#scheduleService.create(input);
  }

  updateScheduleItem(input: ScheduleUpdateInput): Promise<ScheduleSnapshot> {
    return this.#scheduleService.update(input);
  }

  archiveScheduleItem(input: ScheduleTargetInput): Promise<ScheduleSnapshot> {
    return this.#scheduleService.archive(input);
  }

  getFocusSnapshot(input: WorkspaceTargetInput): Promise<FocusSnapshot> {
    return this.#focusService.getSnapshot(input);
  }

  startFocusSession(input: FocusStartInput): Promise<FocusSnapshot> {
    return this.#focusService.start(input);
  }

  pauseFocusSession(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#focusService.pause(input);
  }

  resumeFocusSession(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#focusService.resume(input);
  }

  cancelFocusSession(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#focusService.cancel(input);
  }

  reconcileFocusSession(): Promise<FocusReconcileResult> {
    return this.#focusService.reconcileOpenSession();
  }

  pauseRunningFocusSession(): Promise<FocusReconcileResult> {
    return this.#focusService.pauseRunningSession();
  }

  getAutomationSnapshot(input: WorkspaceTargetInput): Promise<AutomationSnapshot> {
    return this.#automationService.getSnapshot(input);
  }

  createAutomation(input: AutomationCreateInput): Promise<AutomationSnapshot> {
    return this.#automationService.create(input);
  }

  updateAutomation(input: AutomationUpdateInput): Promise<AutomationSnapshot> {
    return this.#automationService.update(input);
  }

  setAutomationEnabled(input: AutomationSetEnabledInput): Promise<AutomationSnapshot> {
    return this.#automationService.setEnabled(input);
  }

  archiveAutomation(input: AutomationTargetInput): Promise<AutomationSnapshot> {
    return this.#automationService.archive(input);
  }

  readAutomationSchedulerEntries(): Promise<readonly StoredAutomation[]> {
    return this.#automationService.readSchedulerEntries();
  }

  runAutomationOccurrence(input: AutomationRunInput): Promise<AutomationRunResult> {
    return this.#automationService.runOccurrence(input);
  }

  search(input: SearchQueryInput): Promise<SearchSnapshot> {
    return this.#searchService.query(input);
  }

  getBrowserData(input: BrowserWorkspaceDataInput): Promise<BrowserData> {
    return this.#browserService.getData(input);
  }

  createBrowserTab(input: BrowserCreateTabDataInput): Promise<BrowserData> {
    return this.#browserService.createTab(input);
  }

  activateBrowserTab(input: BrowserTabDataInput): Promise<BrowserData> {
    return this.#browserService.activateTab(input);
  }

  closeBrowserTab(input: BrowserTabDataInput): Promise<BrowserData> {
    return this.#browserService.closeTab(input);
  }

  persistBrowserTabMetadata(input: BrowserTabMetadataInput): Promise<BrowserData> {
    return this.#browserService.persistTabMetadata(input);
  }

  toggleBrowserBookmark(input: BrowserTabDataInput): Promise<BrowserData> {
    return this.#browserService.toggleBookmark(input);
  }

  removeBrowserBookmark(input: BrowserBookmarkDataInput): Promise<BrowserData> {
    return this.#browserService.removeBookmark(input);
  }

  async #initialize(): Promise<DatabaseInitializationResult> {
    await prepareDatabaseDataDirectory(this.#paths);
    const legacyBackupDirectoryExisted = await inspectLegacyBackupDirectory(
      this.#paths.backupDirectory,
    );
    const initializedBefore = await inspectDatabaseInitializationSentinel(
      this.#paths.dataDirectory,
    );
    const initializationIntentBefore = await inspectDatabaseInitializationIntent(
      this.#paths.dataDirectory,
    );
    const existed = await databaseFileExists(this.#paths.databasePath);
    const existingEntry = existed ? await lstat(this.#paths.databasePath) : undefined;
    const existingSize = existingEntry?.size ?? 0;
    const backups = this.#createBackupManager();
    const recognizedBackupCount = legacyBackupDirectoryExisted ? await backups.count() : 0;
    const retryingInitialization =
      initializationIntentBefore && !initializedBefore && recognizedBackupCount === 0;
    if (existingEntry && existingEntry.size === 0 && !retryingInitialization) {
      throw new DatabaseOpenError(
        'The existing database file is empty; refusing to initialize it as a new database.',
      );
    }
    if (
      !existed &&
      (initializedBefore ||
        recognizedBackupCount > 0 ||
        (legacyBackupDirectoryExisted && !retryingInitialization))
    ) {
      throw new DatabaseOpenError(
        'The main database is missing while prior application data still exists; refusing to create an empty database.',
      );
    }
    if (!existed && !retryingInitialization) {
      await ensureDatabaseInitializationIntent(this.#paths.dataDirectory);
    }
    await prepareDatabaseBackupDirectory(this.#paths);
    const database = this.#adapterFactory(this.#paths.databasePath, { timeoutMs: 5_000 });
    this.#database = database;

    try {
      database.open();
      const openedEntry = await assertOpenedDatabasePath(database, this.#paths.databasePath);
      if (
        existingEntry &&
        !(existingEntry.size === 0 && retryingInitialization
          ? sameInitializingFileIdentity(existingEntry, openedEntry)
          : samePreOpenFile(existingEntry, openedEntry))
      ) {
        throw new DatabasePathError(
          'The database changed before its existing file could be opened.',
        );
      }
      await chmod(this.#paths.databasePath, 0o600);
      configureDesktopPragmas(database);

      this.#backupManager = backups;

      const plan = this.#migrationRunner.plan(database);
      let preMigrationBackup: BackupResult | undefined;
      if (existingSize > 0 && plan.pending.length > 0 && !retryingInitialization) {
        preMigrationBackup = await backups.create(database, 'pre-migration', plan.currentVersion);
      }

      const migration = this.#migrationRunner.apply(database);
      this.#readFoundationHealth(database);
      const openedAt = this.#now().toISOString();
      database.exec('BEGIN IMMEDIATE');
      let health: DatabaseHealth;
      try {
        new MetadataRepository(database).initializeWithinTransaction(openedAt, this.#idFactory());
        this.#workspaceService.initializeWithinTransaction(
          database,
          openedAt,
          migration.toVersion >= WORKSPACE_RECOVERY_SCHEMA_VERSION,
        );
        if (migration.toVersion >= 8) {
          new TerminalPreferenceRepository(database).validateSnapshot();
        }
        new BackupPolicyRepository(database).initializeWithinTransaction(openedAt);
        this.#inboxService.validateSnapshot(database);
        this.#taskService.validateSnapshot(database);
        this.#noteService.validateSnapshot(database);
        this.#scheduleService.validateSnapshot(database);
        if (migration.toVersion >= 9) {
          this.#automationService.validateSnapshot(database);
        }
        if (migration.toVersion >= 10) {
          this.#focusService.validateSnapshot(database);
        }
        this.#browserService.validateSnapshot(database);
        this.#searchService.validateSnapshot(database);
        this.#searchService.validateContentIntegrity(database);
        health = this.#readHealth(database);
        database.exec('COMMIT');
      } catch (error) {
        try {
          if (database.isTransaction) {
            database.exec('ROLLBACK');
          }
        } catch {
          // Preserve the startup integrity error.
        }
        throw error;
      }

      const finalEntry = await assertOpenedDatabasePath(database, this.#paths.databasePath);
      if (finalEntry.size < 1 || !sameFileIdentity(openedEntry, finalEntry)) {
        throw new DatabasePathError('The database path changed while it was initialized.');
      }
      await ensureDatabaseInitializationSentinel(this.#paths.dataDirectory);
      await removeDatabaseInitializationIntent(this.#paths.dataDirectory);
      return { health, migration, preMigrationBackup };
    } catch (error) {
      database.close();
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseOpenError('The database could not be initialized.', { cause: error });
    }
  }

  #createBackup(reason: 'manual' | 'scheduled' | 'pre-import'): Promise<DatabaseBackupInfo> {
    return this.#enqueue(async (database, backups) => {
      const schemaVersion = this.#migrationRunner.validateApplied(database).length;
      const result = await backups.create(database, reason, schemaVersion);
      return toDatabaseBackupInfo(result);
    });
  }

  #createBackupManager(): BackupManager {
    return new BackupManager({
      paths: this.#paths,
      adapterFactory: this.#adapterFactory,
      validateSnapshot: (snapshot, version) => this.#validateSnapshot(snapshot, version),
      now: this.#now,
      idFactory: this.#idFactory,
    });
  }

  #enqueue<T>(
    operation: (database: SqliteAdapter, backups: BackupManager) => Promise<T> | T,
  ): Promise<T> {
    if (this.#state === 'poisoned' || this.#fatalOperationError) {
      return Promise.reject(
        new DatabaseStateError('The database is unavailable after a fatal transaction failure.', {
          cause: this.#fatalOperationError,
        }),
      );
    }
    if (this.#state !== 'open' || !this.#database || !this.#backupManager) {
      return Promise.reject(new DatabaseStateError('The database is not open.'));
    }

    const database = this.#database;
    const backups = this.#backupManager;
    const result = this.#operationTail.then(() => {
      if (this.#fatalOperationError) {
        throw new DatabaseStateError(
          'The database is unavailable after a fatal transaction failure.',
          { cause: this.#fatalOperationError },
        );
      }
      return operation(database, backups);
    });
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #markPoisoned(error: DatabaseIntegrityError): void {
    this.#fatalOperationError = error;
    if (this.#state === 'open') {
      this.#state = 'poisoned';
    }
  }

  #validateSnapshot(database: SqliteAdapter, expectedVersion: number): void {
    const applied = this.#migrationRunner.validateApplied(database);
    if (applied.length !== expectedVersion) {
      throw new DatabaseIntegrityError('The database backup schema version is invalid.');
    }
    assertIntegrity(database);
    if (expectedVersion > 0) {
      new MetadataRepository(database).read();
    }
    if (expectedVersion >= 2) {
      this.#workspaceService.validateSnapshot(
        database,
        expectedVersion >= WORKSPACE_RECOVERY_SCHEMA_VERSION,
      );
    }
    if (expectedVersion >= 3) {
      this.#inboxService.validateSnapshot(database);
    }
    if (expectedVersion >= 4) {
      this.#taskService.validateSnapshot(database);
    }
    if (expectedVersion >= 5) {
      this.#noteService.validateSnapshot(database);
      this.#scheduleService.validateSnapshot(database);
    }
    if (expectedVersion >= 6) {
      this.#browserService.validateSnapshot(database);
    }
    if (expectedVersion >= 7) {
      new BackupPolicyRepository(database).readPolicy();
      new BackupPolicyRepository(database).readRunState();
      this.#searchService.validateSnapshot(database);
    }
    if (expectedVersion >= 8) {
      new TerminalPreferenceRepository(database).validateSnapshot();
    }
    if (expectedVersion >= 9) {
      this.#automationService.validateSnapshot(database);
    }
    if (expectedVersion >= 10) {
      this.#focusService.validateSnapshot(database);
    }
  }

  #readHealth(database: SqliteAdapter): DatabaseHealth {
    const foundation = this.#readFoundationHealth(database);
    const metadata = new MetadataRepository(database).read();
    return {
      status: 'ok',
      databasePath: this.#paths.databasePath,
      ...foundation,
      databaseId: metadata.databaseId,
    };
  }

  #readFoundationHealth(database: SqliteAdapter): DatabaseFoundationHealth {
    const applied = this.#migrationRunner.validateApplied(database);
    assertIntegrity(database);

    const sqliteVersion = readTextValue(database, 'SELECT sqlite_version() AS value');
    const journalMode = readPragmaText(database, 'journal_mode').toLowerCase();
    const foreignKeys = readPragmaNumber(database, 'foreign_keys', 'foreign_keys');
    const busyTimeoutMs = readPragmaNumber(database, 'busy_timeout', 'timeout');
    const synchronous = readPragmaNumber(database, 'synchronous', 'synchronous');
    const trustedSchema = readPragmaNumber(database, 'trusted_schema', 'trusted_schema');
    if (
      journalMode !== 'wal' ||
      foreignKeys !== 1 ||
      busyTimeoutMs !== 5_000 ||
      synchronous !== 1 ||
      trustedSchema !== 0
    ) {
      throw new DatabaseIntegrityError('The database connection safety settings are invalid.');
    }

    return {
      sqliteVersion,
      schemaVersion: applied.length,
      latestMigrationVersion: this.#migrationRunner.latestVersion,
      appliedMigrations: applied.length,
      journalMode,
      foreignKeys: true,
      busyTimeoutMs,
      synchronous: 'normal',
      trustedSchema: false,
      integrity: 'ok',
    };
  }
}

async function assertOpenedDatabasePath(
  database: SqliteAdapter,
  expectedPath: string,
): Promise<Stats> {
  const location = database.location;
  if (!location || resolve(location) !== expectedPath) {
    throw new DatabasePathError('The opened database resolved outside its controlled path.');
  }
  const entry = await lstat(expectedPath).catch((error: unknown) => {
    throw new DatabasePathError('The opened database file could not be inspected.', {
      cause: error,
    });
  });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new DatabasePathError('The opened database path must remain a regular file.');
  }
  return entry;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 && left.ino !== 0 && right.dev !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.birthtimeMs !== 0 && right.birthtimeMs !== 0 && left.birthtimeMs === right.birthtimeMs
  );
}

function samePreOpenFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.size > 0 &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameInitializingFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    left.size === 0 &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return samePreOpenFile(left, right) && left.ctimeMs === right.ctimeMs;
}

async function inspectLegacyBackupDirectory(backupDirectory: string): Promise<boolean> {
  const entry = await lstat(backupDirectory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DatabasePathError('The legacy backup directory could not be inspected.', {
      cause: error,
    });
  });
  if (!entry) return false;
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new DatabasePathError(
      'The backup path must be a real directory, not a file or symbolic link.',
    );
  }
  return true;
}

async function inspectDatabaseInitializationSentinel(dataDirectory: string): Promise<boolean> {
  return (
    (await inspectDatabaseMarker(
      dataDirectory,
      DATABASE_INITIALIZATION_SENTINEL,
      DATABASE_INITIALIZATION_SENTINEL_CONTENT,
      'initialization sentinel',
    )) !== undefined
  );
}

async function inspectDatabaseInitializationIntent(dataDirectory: string): Promise<boolean> {
  return (
    (await inspectDatabaseMarker(
      dataDirectory,
      DATABASE_INITIALIZATION_INTENT,
      DATABASE_INITIALIZATION_INTENT_CONTENT,
      'initialization intent',
    )) !== undefined
  );
}

async function inspectDatabaseMarker(
  dataDirectory: string,
  fileName: string,
  content: string,
  label: string,
): Promise<Stats | undefined> {
  const markerPath = databaseMarkerPath(dataDirectory, fileName, label);
  const before = await lstat(markerPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DatabasePathError(`The database ${label} could not be inspected.`, { cause: error });
  });
  if (!before) return undefined;
  const expected = Buffer.from(content, 'utf8');
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.byteLength) {
    throw new DatabasePathError(`The database ${label} is invalid.`);
  }

  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(markerPath, flags).catch((error: unknown) => {
    throw new DatabasePathError(`The database ${label} could not be opened.`, {
      cause: error,
    });
  });
  try {
    const opened = await handle.stat();
    if (!sameStableFile(before, opened)) {
      throw new DatabasePathError(`The database ${label} changed before it was opened.`);
    }
    const contents = await handle.readFile();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(markerPath)]);
    if (
      !contents.equals(expected) ||
      !sameStableFile(opened, afterHandle) ||
      !sameStableFile(opened, afterPath)
    ) {
      throw new DatabasePathError(`The database ${label} changed while it was read.`);
    }
    return afterPath;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensureDatabaseInitializationSentinel(dataDirectory: string): Promise<void> {
  await ensureDatabaseMarker(
    dataDirectory,
    DATABASE_INITIALIZATION_SENTINEL,
    DATABASE_INITIALIZATION_SENTINEL_CONTENT,
    'initialization sentinel',
  );
}

async function ensureDatabaseInitializationIntent(dataDirectory: string): Promise<void> {
  await ensureDatabaseMarker(
    dataDirectory,
    DATABASE_INITIALIZATION_INTENT,
    DATABASE_INITIALIZATION_INTENT_CONTENT,
    'initialization intent',
  );
}

async function ensureDatabaseMarker(
  dataDirectory: string,
  fileName: string,
  content: string,
  label: string,
): Promise<void> {
  if ((await inspectDatabaseMarker(dataDirectory, fileName, content, label)) !== undefined) {
    await syncDirectory(dataDirectory);
    return;
  }

  const markerPath = databaseMarkerPath(dataDirectory, fileName, label);
  const temporaryPath = resolve(dataDirectory, `.${fileName}.${randomUUID()}.partial`);
  if (dirname(temporaryPath) !== dataDirectory) {
    throw new DatabasePathError(`The database ${label} escaped its data directory.`);
  }
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, markerPath);
    await syncDirectory(dataDirectory);
    if ((await inspectDatabaseMarker(dataDirectory, fileName, content, label)) === undefined) {
      throw new DatabasePathError(`The database ${label} was not published.`);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof DatabaseError) throw error;
    throw new DatabasePathError(`The database ${label} could not be published.`, {
      cause: error,
    });
  }
}

async function removeDatabaseInitializationIntent(dataDirectory: string): Promise<void> {
  const intentPath = databaseMarkerPath(
    dataDirectory,
    DATABASE_INITIALIZATION_INTENT,
    'initialization intent',
  );
  const inspected = await inspectDatabaseMarker(
    dataDirectory,
    DATABASE_INITIALIZATION_INTENT,
    DATABASE_INITIALIZATION_INTENT_CONTENT,
    'initialization intent',
  );
  if (!inspected) return;
  const beforeRemoval = await lstat(intentPath).catch((error: unknown) => {
    throw new DatabasePathError(
      'The database initialization intent could not be revalidated before removal.',
      { cause: error },
    );
  });
  if (!sameStableFile(inspected, beforeRemoval)) {
    throw new DatabasePathError(
      'The database initialization intent changed before it could be removed.',
    );
  }
  await rm(intentPath);
  await syncDirectory(dataDirectory);
}

function databaseMarkerPath(dataDirectory: string, fileName: string, label: string): string {
  const path = resolve(dataDirectory, fileName);
  if (dirname(path) !== dataDirectory) {
    throw new DatabasePathError(`The database ${label} escaped its data directory.`);
  }
  return path;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertIntegrity(database: SqliteAdapter): void {
  const quickCheck = database.all<IntegrityRow>('PRAGMA quick_check');
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new DatabaseIntegrityError('The SQLite quick check failed.');
  }
  if (database.all<Record<string, unknown>>('PRAGMA foreign_key_check').length !== 0) {
    throw new DatabaseIntegrityError('The SQLite foreign-key check failed.');
  }
}

function readTextValue(database: SqliteAdapter, sql: string): string {
  const row = database.get<TextRow>(sql);
  if (!row || typeof row.value !== 'string' || row.value.length === 0) {
    throw new DatabaseIntegrityError('SQLite returned an invalid text status value.');
  }
  return row.value;
}

function readPragmaText(database: SqliteAdapter, pragma: 'journal_mode'): string {
  const row = database.get<Record<string, unknown>>(`PRAGMA ${pragma}`);
  const value = row?.[pragma];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${pragma} value.`);
  }
  return value;
}

function readPragmaNumber(
  database: SqliteAdapter,
  pragma: 'busy_timeout' | 'foreign_keys' | 'synchronous' | 'trusted_schema',
  field: 'foreign_keys' | 'synchronous' | 'timeout' | 'trusted_schema',
): number {
  const row = database.get<Record<string, unknown>>(`PRAGMA ${pragma}`);
  const value = row?.[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${pragma} value.`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
