import type {
  BackupPolicy,
  BackupPolicyUpdateInput,
  BackupRunErrorCode,
  DataExportResult,
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
    const schedule = await this.#scheduler.start();
    return this.#readSnapshot(schedule);
  }

  stop(): Promise<void> {
    this.#notificationGeneration += 1;
    return this.#scheduler.stop();
  }

  async getManagementSnapshot(): Promise<DataManagementSnapshot> {
    const schedule = await this.#scheduler.getState();
    return this.#readSnapshot(schedule);
  }

  async updateBackupPolicy(input: BackupPolicyUpdateInput): Promise<DataManagementSnapshot> {
    await this.#database.updateBackupPolicy(input);
    await this.#scheduler.evaluate();
    const schedule = await this.#scheduler.evaluate();
    const snapshot = await this.#readSnapshot(schedule);
    this.#emit(snapshot);
    return snapshot;
  }

  exportData(): Promise<DataExportResult> {
    return this.#portability.exportData();
  }

  chooseImport(): Promise<DataImportSelection> {
    return this.#portability.chooseImport();
  }

  commitImport(input: DataImportCommitInput): Promise<DataImportCommitResult> {
    return this.#portability.commitImport(input);
  }

  cancelImport(input: DataImportTargetInput): Promise<void> {
    return this.#portability.cancelImport(input);
  }

  async #readSnapshot(schedule: DataManagementSnapshot['schedule']) {
    const [database, backups] = await Promise.all([
      this.#database.getStatus(),
      this.#database.listBackups(),
    ]);
    return { database, backups, schedule };
  }

  #queueNotification(schedule: DataManagementSnapshot['schedule']): void {
    const generation = ++this.#notificationGeneration;
    void this.#readSnapshot(schedule)
      .then((snapshot) => {
        if (generation === this.#notificationGeneration) this.#emit(snapshot);
      })
      .catch(this.#onError);
  }

  #emit(snapshot: DataManagementSnapshot): void {
    try {
      this.#onStateChange(snapshot);
    } catch (error) {
      this.#onError(error);
    }
  }
}
