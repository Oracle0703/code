import type {
  BackupPolicy,
  BackupRunErrorCode,
  BackupScheduleState,
  DatabaseBackupInfo,
} from '../../shared/contracts';
import {
  calculateBackupSchedule,
  type BackupScheduleDecision,
  type BackupScheduleHistory,
} from './backup-schedule';
import type { BackupRetentionResult } from './types';

const DEFAULT_MAXIMUM_WAKE_DELAY_MS = 30 * 60 * 1_000;
const INITIAL_RETRY_DELAY_MS = 5 * 60 * 1_000;
const MAXIMUM_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;

export interface BackupSchedulerPersistentState extends BackupScheduleHistory {
  readonly policy: BackupPolicy;
  readonly lastAttemptAt: string | null;
  readonly lastErrorCode: BackupRunErrorCode | null;
  readonly consecutiveFailures: number;
}

export interface BackupSchedulerStore {
  readState(): Promise<BackupSchedulerPersistentState>;
  recordAttempt(timestamp: string): Promise<void>;
  recordResult(result: {
    readonly attemptedAt: string;
    readonly completedAt: string;
    readonly successfulBucket?: string;
    readonly errorCode?: BackupRunErrorCode;
  }): Promise<void>;
}

export interface ScheduledBackupOperations {
  createScheduledBackup(): Promise<DatabaseBackupInfo>;
  pruneScheduled(protectedBackupId: string): Promise<BackupRetentionResult>;
}

export interface BackupSchedulerTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface BackupSchedulerOptions {
  readonly store: BackupSchedulerStore;
  readonly backups: ScheduledBackupOperations;
  readonly now?: () => Date;
  readonly timer?: BackupSchedulerTimer;
  readonly maximumWakeDelayMs?: number;
  readonly classifyError?: (error: unknown) => BackupRunErrorCode;
  readonly onStateChange?: (state: BackupScheduleState) => void;
  readonly onError?: (error: unknown) => void;
}

export class BackupScheduler {
  readonly #store: BackupSchedulerStore;
  readonly #backups: ScheduledBackupOperations;
  readonly #now: () => Date;
  readonly #timer: BackupSchedulerTimer;
  readonly #maximumWakeDelayMs: number;
  readonly #classifyError: (error: unknown) => BackupRunErrorCode;
  readonly #onStateChange: (state: BackupScheduleState) => void;
  readonly #onError: (error: unknown) => void;
  #started = false;
  #stopping = false;
  #timerHandle: unknown;
  #evaluation: Promise<BackupScheduleState> | null = null;
  #running = false;

  constructor({
    store,
    backups,
    now = () => new Date(),
    timer = defaultTimer,
    maximumWakeDelayMs = DEFAULT_MAXIMUM_WAKE_DELAY_MS,
    classifyError = () => 'backup-failed',
    onStateChange = () => undefined,
    onError = () => undefined,
  }: BackupSchedulerOptions) {
    if (!Number.isSafeInteger(maximumWakeDelayMs) || maximumWakeDelayMs < 1_000) {
      throw new TypeError('The backup scheduler wake interval is invalid.');
    }
    this.#store = store;
    this.#backups = backups;
    this.#now = now;
    this.#timer = timer;
    this.#maximumWakeDelayMs = maximumWakeDelayMs;
    this.#classifyError = classifyError;
    this.#onStateChange = onStateChange;
    this.#onError = onError;
  }

  async start(): Promise<BackupScheduleState> {
    if (this.#started && !this.#stopping) return this.evaluate();
    this.#started = true;
    this.#stopping = false;
    return this.evaluate();
  }

  evaluate(): Promise<BackupScheduleState> {
    if (this.#evaluation) return this.#evaluation;
    this.#clearTimer();
    const evaluation = this.#evaluateOnce();
    this.#evaluation = evaluation;
    const clearEvaluation = (): void => {
      if (this.#evaluation === evaluation) this.#evaluation = null;
    };
    void evaluation.then(clearEvaluation, clearEvaluation);
    return evaluation;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    this.#clearTimer();
    await this.#evaluation?.catch(() => undefined);
    this.#stopping = false;
  }

  async getState(): Promise<BackupScheduleState> {
    const persistent = await this.#store.readState();
    return this.#toPublicState(
      persistent,
      calculateBackupSchedule(persistent.policy, persistent, this.#readNow()),
    );
  }

  async #evaluateOnce(): Promise<BackupScheduleState> {
    let persistent = await this.#store.readState();
    let decision = this.#calculateDecision(persistent);

    if (decision.due && decision.dueBucket && this.#started && !this.#stopping) {
      persistent = await this.#runBackup(persistent, decision.dueBucket);
      decision = this.#calculateDecision(persistent);
    }

    const snapshot = this.#toPublicState(persistent, decision);
    this.#emit(snapshot);
    if (this.#started && !this.#stopping) this.#schedule(decision);
    return snapshot;
  }

  async #runBackup(
    state: BackupSchedulerPersistentState,
    bucket: string,
  ): Promise<BackupSchedulerPersistentState> {
    const attemptedAt = this.#readNow().toISOString();
    this.#running = true;
    this.#emit(
      this.#toPublicState(state, {
        due: false,
        dueBucket: null,
        scheduledFor: null,
        nextRunAt: null,
      }),
    );

    try {
      await this.#store.recordAttempt(attemptedAt);
      const backup = await this.#backups.createScheduledBackup();
      if (backup.reason !== 'scheduled') {
        throw new Error('The backup scheduler received a non-scheduled snapshot.');
      }
      const completedAt = this.#completionTimestamp(attemptedAt);
      try {
        // The database operation reads the current retention policy and applies it
        // within one serialized queue turn, so a stale scheduler snapshot can never
        // drive irreversible deletion.
        await this.#backups.pruneScheduled(backup.id);
        await this.#store.recordResult({
          attemptedAt,
          completedAt,
          successfulBucket: bucket,
        });
      } catch (error) {
        this.#onError(error);
        await this.#store.recordResult({
          attemptedAt,
          completedAt,
          errorCode: 'retention-failed',
        });
      }
    } catch (error) {
      this.#onError(error);
      const errorCode = this.#safeClassifyError(error);
      try {
        await this.#store.recordResult({
          attemptedAt,
          completedAt: this.#completionTimestamp(attemptedAt),
          errorCode,
        });
      } catch (recordError) {
        this.#onError(recordError);
      }
    } finally {
      this.#running = false;
    }
    return this.#store.readState();
  }

  #calculateDecision(persistent: BackupSchedulerPersistentState): BackupScheduleDecision {
    const now = this.#readNow();
    const decision = calculateBackupSchedule(persistent.policy, persistent, now);
    if (
      !decision.due ||
      persistent.consecutiveFailures < 1 ||
      persistent.lastAttemptAt === null ||
      persistent.lastErrorCode === null
    ) {
      return decision;
    }

    const exponent = Math.min(persistent.consecutiveFailures - 1, 16);
    const retryDelay = Math.min(MAXIMUM_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** exponent);
    const retryAt = new Date(Date.parse(persistent.lastAttemptAt) + retryDelay);
    if (retryAt <= now) return decision;
    return {
      due: false,
      dueBucket: null,
      scheduledFor: decision.scheduledFor,
      nextRunAt: retryAt.toISOString(),
    };
  }

  #toPublicState(
    persistent: BackupSchedulerPersistentState,
    decision: BackupScheduleDecision,
  ): BackupScheduleState {
    return {
      policy: persistent.policy,
      lastAttemptAt: persistent.lastAttemptAt,
      lastSuccessAt: persistent.lastSuccessAt,
      lastErrorCode: persistent.lastErrorCode,
      consecutiveFailures: persistent.consecutiveFailures,
      nextRunAt: this.#running ? null : decision.nextRunAt,
      running: this.#running,
    };
  }

  #schedule(decision: BackupScheduleDecision): void {
    const now = this.#readNow().getTime();
    const requestedDelay =
      decision.nextRunAt === null
        ? this.#maximumWakeDelayMs
        : new Date(decision.nextRunAt).getTime() - now;
    const delay = Math.max(1_000, Math.min(this.#maximumWakeDelayMs, requestedDelay));
    this.#timerHandle = this.#timer.set(() => {
      this.#timerHandle = undefined;
      void this.evaluate().catch(this.#onError);
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timerHandle === undefined) return;
    this.#timer.clear(this.#timerHandle);
    this.#timerHandle = undefined;
  }

  #safeClassifyError(error: unknown): BackupRunErrorCode {
    try {
      const result = this.#classifyError(error);
      if (
        result === 'backup-failed' ||
        result === 'retention-failed' ||
        result === 'database-unavailable'
      ) {
        return result;
      }
    } catch (classificationError) {
      this.#onError(classificationError);
    }
    return 'backup-failed';
  }

  #readNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('The backup scheduler clock returned an invalid date.');
    }
    return now;
  }

  #completionTimestamp(attemptedAt: string): string {
    const now = this.#readNow();
    const attemptTime = Date.parse(attemptedAt);
    return new Date(Math.max(now.getTime(), attemptTime)).toISOString();
  }

  #emit(state: BackupScheduleState): void {
    try {
      this.#onStateChange(state);
    } catch (error) {
      this.#onError(error);
    }
  }
}

const defaultTimer: BackupSchedulerTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
