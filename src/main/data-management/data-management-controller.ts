import type {
  BackupPolicy,
  BackupPolicyUpdateInput,
  BackupRunErrorCode,
  DataExportResult,
  DatabaseBackupRestoreInput,
  DatabaseBackupRestoreResult,
  DataImportCommitInput,
  DataImportCommitResult,
  DataImportSelection,
  DataImportTargetInput,
  DataManagementSnapshot,
  DatabaseBackupInfo,
  DatabaseStatus,
} from '../../shared/contracts';
import { DatabaseStateError } from '../database/errors';
import {
  BackupScheduler,
  type BackupSchedulerOptions,
  type BackupSchedulerPersistentState,
  type BackupSchedulerTimer,
} from '../database/backup-scheduler';
import type { BackupRetentionResult } from '../database/types';

export interface DataManagementDatabase {
  getStatus(): Promise<DatabaseStatus>;
  createBackup(): Promise<DatabaseBackupInfo>;
  listBackups(): Promise<DatabaseBackupInfo[]>;
  getBackupSchedulerState(): Promise<BackupSchedulerPersistentState>;
  updateBackupPolicy(input: BackupPolicyUpdateInput): Promise<BackupPolicy>;
  recordBackupAttempt(timestamp: string): Promise<void>;
  recordBackupResult(input: {
    readonly attemptedAt: string;
    readonly completedAt: string;
    readonly successfulBucket?: string;
    readonly errorCode?: BackupRunErrorCode;
  }): Promise<void>;
  createScheduledBackup(): Promise<DatabaseBackupInfo>;
  pruneScheduledBackups(protectedBackupId: string): Promise<BackupRetentionResult>;
}

export interface DataPortabilityOperations {
  exportData(): Promise<DataExportResult>;
  chooseImport(): Promise<DataImportSelection>;
  commitImport(input: DataImportCommitInput): Promise<DataImportCommitResult>;
  cancelImport(input: DataImportTargetInput): Promise<void>;
  restoreBackup(input: DatabaseBackupRestoreInput): Promise<DatabaseBackupRestoreResult>;
}

export interface DataManagementControllerOptions {
  readonly database: DataManagementDatabase;
  readonly portability: DataPortabilityOperations;
  readonly now?: () => Date;
  readonly timer?: BackupSchedulerTimer;
  readonly maximumWakeDelayMs?: number;
  readonly onStateChange?: (snapshot: DataManagementSnapshot) => void;
  readonly onError?: (error: unknown) => void;
}

export class DataManagementController implements DataPortabilityOperations {
  readonly #database: DataManagementDatabase;
  readonly #portability: DataPortabilityOperations;
  readonly #scheduler: BackupScheduler;
  readonly #onStateChange: (snapshot: DataManagementSnapshot) => void;
  readonly #onError: (error: unknown) => void;
  #notificationGeneration = 0;
  #operation: string | null = null;
  #stopped = false;

  constructor({
    database,
    portability,
    now,
    timer,
    maximumWakeDelayMs,
    onStateChange = () => undefined,
    onError = () => undefined,
  }: DataManagementControllerOptions) {
    this.#database = database;
    this.#portability = portability;
    this.#onStateChange = onStateChange;
    this.#onError = onError;
    const schedulerOptions: BackupSchedulerOptions = {
      store: {
        readState: () => database.getBackupSchedulerState(),
        recordAttempt: (timestamp) => database.recordBackupAttempt(timestamp),
        recordResult: (result) => database.recordBackupResult(result),
      },
      backups: {
        createScheduledBackup: () => database.createScheduledBackup(),
        pruneScheduled: (protectedBackupId) => database.pruneScheduledBackups(protectedBackupId),
      },
      classifyError: (error) =>
        error instanceof DatabaseStateError ? 'database-unavailable' : 'backup-failed',
      onStateChange: (schedule) => this.#queueNotification(schedule),
      onError,
      ...(now ? { now } : {}),
      ...(timer ? { timer } : {}),
      ...(maximumWakeDelayMs ? { maximumWakeDelayMs } : {}),
    };
    this.#scheduler = new BackupScheduler(schedulerOptions);
  }

  async start(): Promise<DataManagementSnapshot> {
    this.#stopped = false;
    const schedule = await this.#scheduler.start();
    return this.#readSnapshot(schedule);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#notificationGeneration += 1;
    await this.#scheduler.stop();
    this.#notificationGeneration += 1;
  }

  async getManagementSnapshot(): Promise<DataManagementSnapshot> {
    const schedule = await this.#scheduler.getState();
    return this.#readSnapshot(schedule);
  }

  createBackup(): Promise<DatabaseBackupInfo> {
    return this.#exclusive('manual-backup', () => this.#database.createBackup());
  }

  updateBackupPolicy(input: BackupPolicyUpdateInput): Promise<DataManagementSnapshot> {
    return this.#exclusive('update-policy', async () => {
      await this.#database.updateBackupPolicy(input);
      await this.#scheduler.evaluate();
      const schedule = await this.#scheduler.evaluate();
      const snapshot = await this.#readSnapshot(schedule);
      this.#emit(snapshot);
      return snapshot;
    });
  }

  exportData(): Promise<DataExportResult> {
    return this.#exclusive('export', () => this.#portability.exportData());
  }

  chooseImport(): Promise<DataImportSelection> {
    return this.#exclusive('choose-import', () => this.#portability.chooseImport());
  }

  commitImport(input: DataImportCommitInput): Promise<DataImportCommitResult> {
    return this.#exclusive('commit-import', () => this.#portability.commitImport(input));
  }

  cancelImport(input: DataImportTargetInput): Promise<void> {
    return this.#exclusive('cancel-import', () => this.#portability.cancelImport(input));
  }

  restoreBackup(input: DatabaseBackupRestoreInput): Promise<DatabaseBackupRestoreResult> {
    return this.#exclusive('restore-backup', () => this.#portability.restoreBackup(input));
  }

  async #readSnapshot(schedule: DataManagementSnapshot['schedule']) {
    const [database, backups] = await Promise.all([
      this.#database.getStatus(),
      this.#database.listBackups(),
    ]);
    return { database, backups, schedule };
  }

  #queueNotification(schedule: DataManagementSnapshot['schedule']): void {
    if (this.#stopped) return;
    const generation = ++this.#notificationGeneration;
    void this.#readSnapshot(schedule)
      .then((snapshot) => {
        if (!this.#stopped && generation === this.#notificationGeneration) this.#emit(snapshot);
      })
      .catch(this.#onError);
  }

  #emit(snapshot: DataManagementSnapshot): void {
    if (this.#stopped) return;
    try {
      this.#onStateChange(snapshot);
    } catch (error) {
      this.#onError(error);
    }
  }

  #exclusive<T>(operation: string, task: () => Promise<T>): Promise<T> {
    if (this.#stopped) {
      return Promise.reject(new Error('Data management has stopped for application shutdown.'));
    }
    if (this.#operation) {
      return Promise.reject(new Error('Another data management operation is already running.'));
    }
    this.#operation = operation;
    return task().finally(() => {
      if (this.#operation === operation) this.#operation = null;
    });
  }
}
