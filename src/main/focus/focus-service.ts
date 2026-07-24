import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  FocusSnapshot,
  FocusStartInput,
  FocusTargetInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  FOCUS_DURATION_SECONDS,
  focusDeadlineAt,
  focusRemainingAt,
  normalizeFocusRevision,
  normalizeFocusSessionId,
  normalizeFocusTimestamp,
} from '../../shared/focus-domain';
import {
  formatLocalTaskDate,
  normalizeTaskCivilDate,
  normalizeTaskId,
} from '../../shared/task-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { TaskRepository } from '../tasks/task-repository';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  FocusConflictError,
  FocusError,
  FocusNotFoundError,
  FocusOperationError,
  FocusValidationError,
} from './focus-errors';
import { FocusRepository, type StoredFocusSession } from './focus-repository';

export type FocusOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface FocusServiceOptions {
  readonly execute: FocusOperationExecutor;
  readonly now?: () => Date;
  readonly todayFactory?: () => string;
  readonly idFactory?: () => string;
  readonly monotonicNowMs?: () => number;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

export interface FocusReconcileResult {
  readonly changed: boolean;
  readonly changedWorkspaceId: string | null;
  readonly session: FocusSnapshot['session'];
}

interface RunningClock {
  readonly sessionId: string;
  readonly deadlineAt: string;
  readonly monotonicDeadlineMs: number;
  readonly remainingUpperBound: number;
}

export class FocusService {
  readonly #execute: FocusOperationExecutor;
  readonly #now: () => Date;
  readonly #todayFactory: (() => string) | undefined;
  readonly #idFactory: () => string;
  readonly #monotonicNowMs: () => number;
  readonly #onFatalTransaction: (error: DatabaseIntegrityError) => void;
  #runningClock: RunningClock | undefined;

  constructor({
    execute,
    now = () => new Date(),
    todayFactory,
    idFactory = randomUUID,
    monotonicNowMs = () => performance.now(),
    onFatalTransaction = () => undefined,
  }: FocusServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#todayFactory = todayFactory;
    this.#idFactory = idFactory;
    this.#monotonicNowMs = monotonicNowMs;
    this.#onFatalTransaction = onFatalTransaction;
  }

  validateSnapshot(database: SqliteAdapter): void {
    new FocusRepository(database).validateSnapshot();
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<FocusSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    return this.#execute((database) =>
      this.#transaction(database, 'read focus sessions', (repository) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const now = this.#validNow();
        this.#reconcile(repository, now);
        return this.#snapshot(repository, workspaceId, now);
      }),
    );
  }

  start(input: FocusStartInput): Promise<FocusSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const taskId = input?.taskId === undefined ? null : this.#taskId(input.taskId);
    return this.#execute((database) =>
      this.#transaction(database, 'start a focus session', (repository) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const now = this.#validNow();
        const todayDate = this.#todayDate(now);
        this.#reconcile(repository, now);
        if (repository.findOpen()) {
          throw new FocusConflictError('Another focus session is already open.');
        }
        let taskUpdatedAt: string | undefined;
        if (taskId !== null) {
          const task = new TaskRepository(database).find(workspaceId, taskId);
          if (!task || task.status === 'completed' || task.plannedFor !== todayDate) {
            throw new FocusConflictError(
              'A focus task must be unfinished and planned for today in this workspace.',
            );
          }
          taskUpdatedAt = task.updatedAt;
        }
        const sessionId = this.#newSessionId();
        const timestamp = this.#timestampAtLeast(
          now,
          workspace.createdAt,
          workspace.updatedAt,
          ...(taskUpdatedAt ? [taskUpdatedAt] : []),
        );
        // Audit timestamps remain logically monotonic, while the countdown deadline follows the
        // current wall clock. After a clock rollback, the deadline may precede the audit timestamp.
        const deadlineAt = focusDeadlineAt(now, FOCUS_DURATION_SECONDS);
        repository.insert({
          id: sessionId,
          workspaceId,
          taskId,
          localDate: todayDate,
          remainingSeconds: FOCUS_DURATION_SECONDS,
          deadlineAt,
          timestamp,
        });
        this.#startRunningClock(sessionId, deadlineAt, FOCUS_DURATION_SECONDS);
        return this.#snapshot(repository, workspaceId, now);
      }),
    );
  }

  pause(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#transition(input, 'pause');
  }

  resume(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#transition(input, 'resume');
  }

  cancel(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#transition(input, 'cancel');
  }

  reconcileOpenSession(): Promise<FocusReconcileResult> {
    return this.#execute((database) =>
      this.#transaction(database, 'reconcile focus time', (repository) => {
        const result = this.#reconcile(repository, this.#validNow());
        return {
          ...result,
          session: toOpenSession(repository.findOpen()),
        };
      }),
    );
  }

  pauseRunningSession(): Promise<FocusReconcileResult> {
    return this.#execute((database) =>
      this.#transaction(database, 'pause focus during shutdown', (repository) => {
        const now = this.#validNow();
        const initial = repository.findOpen();
        if (!initial || initial.status === 'paused') {
          this.#clearRunningClock();
          return {
            changed: false,
            changedWorkspaceId: null,
            session: toOpenSession(initial),
          };
        }
        const remaining = this.#remaining(initial, now);
        const timestamp = this.#timestampAtLeast(now, initial.createdAt, initial.updatedAt);
        const changed =
          remaining === 0
            ? repository.complete(initial.workspaceId, initial.id, initial.revision, timestamp)
            : repository.pause(
                initial.workspaceId,
                initial.id,
                initial.revision,
                remaining,
                timestamp,
              );
        if (!changed) throw new FocusConflictError();
        this.#clearRunningClock(initial.id);
        return {
          changed: true,
          changedWorkspaceId: initial.workspaceId,
          session: toOpenSession(repository.findOpen()),
        };
      }),
    );
  }

  #transition(
    input: FocusTargetInput,
    operation: 'pause' | 'resume' | 'cancel',
  ): Promise<FocusSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const sessionId = this.#sessionId(input?.sessionId);
    const expectedRevision = this.#revision(input?.expectedRevision);
    return this.#execute((database) =>
      this.#transaction(database, `${operation} a focus session`, (repository) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const now = this.#validNow();
        const current = this.#requireSession(repository, workspaceId, sessionId);
        if (current.revision !== expectedRevision) throw new FocusConflictError();
        const timestamp = this.#timestampAtLeast(now, current.createdAt, current.updatedAt);

        if (operation === 'resume') {
          if (current.status !== 'paused') {
            throw new FocusConflictError('Only a paused focus session can resume.');
          }
          // Do not make a future logical updatedAt delay a resumed countdown after clock rollback.
          const deadlineAt = focusDeadlineAt(now, current.remainingSeconds);
          if (!repository.resume(workspaceId, sessionId, expectedRevision, deadlineAt, timestamp)) {
            throw new FocusConflictError();
          }
          this.#startRunningClock(sessionId, deadlineAt, current.remainingSeconds);
        } else {
          if (current.status !== 'running' && current.status !== 'paused') {
            throw new FocusConflictError('The focus session has already ended.');
          }
          const remaining =
            current.status === 'running' ? this.#remaining(current, now) : current.remainingSeconds;
          if (remaining === 0) {
            if (
              current.status !== 'running' ||
              !repository.complete(workspaceId, sessionId, expectedRevision, timestamp)
            ) {
              throw new FocusConflictError();
            }
            this.#clearRunningClock(sessionId);
          } else if (operation === 'pause') {
            if (
              current.status !== 'running' ||
              !repository.pause(workspaceId, sessionId, expectedRevision, remaining, timestamp)
            ) {
              throw new FocusConflictError('Only a running focus session can pause.');
            }
            this.#clearRunningClock(sessionId);
          } else if (
            !repository.cancel(workspaceId, sessionId, expectedRevision, remaining, timestamp)
          ) {
            throw new FocusConflictError();
          } else {
            this.#clearRunningClock(sessionId);
          }
        }
        return this.#snapshot(repository, workspaceId, now);
      }),
    );
  }

  #reconcile(repository: FocusRepository, now: Date): Omit<FocusReconcileResult, 'session'> {
    const current = repository.findOpen();
    if (!current || current.status === 'paused') {
      this.#clearRunningClock();
      return { changed: false, changedWorkspaceId: null };
    }
    const remaining = this.#remaining(current, now);
    const timestamp = this.#timestampAtLeast(now, current.createdAt, current.updatedAt);
    if (remaining === 0) {
      if (!repository.complete(current.workspaceId, current.id, current.revision, timestamp)) {
        throw new FocusConflictError();
      }
      this.#clearRunningClock(current.id);
      return { changed: true, changedWorkspaceId: current.workspaceId };
    }
    if (remaining < current.remainingSeconds) {
      if (
        !repository.checkpointRunning(
          current.workspaceId,
          current.id,
          current.revision,
          remaining,
          timestamp,
        )
      ) {
        throw new FocusConflictError();
      }
      return { changed: true, changedWorkspaceId: current.workspaceId };
    }
    return { changed: false, changedWorkspaceId: null };
  }

  #snapshot(repository: FocusRepository, workspaceId: string, observedAt: Date): FocusSnapshot {
    const todayDate = this.#todayDate(observedAt);
    return {
      workspaceId,
      todayDate,
      observedAt: observedAt.toISOString(),
      session: toOpenSession(repository.findOpen()),
      todayCompletedCount: repository.countCompleted(workspaceId, todayDate),
    };
  }

  #remaining(session: StoredFocusSession, now: Date): number {
    if (session.status !== 'running' || session.deadlineAt === null) {
      return session.remainingSeconds;
    }
    try {
      const wallRemaining = focusRemainingAt(session.remainingSeconds, session.deadlineAt, now);
      const monotonicNow = this.#validMonotonicNow();
      const clock = this.#runningClock;
      if (!clock || clock.sessionId !== session.id || clock.deadlineAt !== session.deadlineAt) {
        this.#runningClock = {
          sessionId: session.id,
          deadlineAt: session.deadlineAt,
          monotonicDeadlineMs: monotonicNow + wallRemaining * 1_000,
          remainingUpperBound: wallRemaining,
        };
        return wallRemaining;
      }
      const monotonicRemaining = Math.max(
        0,
        Math.ceil((clock.monotonicDeadlineMs - monotonicNow) / 1_000),
      );
      const remaining = Math.min(
        session.remainingSeconds,
        clock.remainingUpperBound,
        wallRemaining,
        monotonicRemaining,
      );
      this.#runningClock = { ...clock, remainingUpperBound: remaining };
      return remaining;
    } catch (error) {
      throw new DatabaseIntegrityError('The running focus session deadline is invalid.', {
        cause: error,
      });
    }
  }

  #startRunningClock(sessionId: string, deadlineAt: string, remainingSeconds: number): void {
    this.#runningClock = {
      sessionId,
      deadlineAt,
      monotonicDeadlineMs: this.#validMonotonicNow() + remainingSeconds * 1_000,
      remainingUpperBound: remainingSeconds,
    };
  }

  #clearRunningClock(sessionId?: string): void {
    if (sessionId !== undefined && this.#runningClock?.sessionId !== sessionId) return;
    this.#runningClock = undefined;
  }

  #transaction<T>(
    database: SqliteAdapter,
    operation: string,
    callback: (repository: FocusRepository) => T,
  ): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError('A focus operation encountered an active transaction.');
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(new FocusRepository(database));
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The focus operation escaped its transaction.');
      }
      commitStarted = true;
      database.exec('COMMIT');
      return result;
    } catch (error) {
      const transactionActiveAtFailure = database.isTransaction;
      let rollbackError: unknown;
      try {
        if (transactionStarted && transactionActiveAtFailure) database.exec('ROLLBACK');
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
      const transactionRemainsActive = database.isTransaction;
      const commitOutcomeUnknown = commitStarted && !transactionActiveAtFailure;
      if (
        rollbackError !== undefined ||
        transactionRemainsActive ||
        transactionEscaped ||
        commitOutcomeUnknown
      ) {
        const cause =
          rollbackError === undefined
            ? error
            : new AggregateError([error, rollbackError], 'The focus operation rollback failed.');
        const fatalError = new DatabaseIntegrityError(
          'The focus transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof FocusError || error instanceof DatabaseIntegrityError) throw error;
      throw new FocusOperationError(`The focus service could not ${operation}.`, { cause: error });
    }
  }

  #requireActiveWorkspace(database: SqliteAdapter, workspaceId: string) {
    const workspace = new WorkspaceRepository(database).findActive(workspaceId);
    if (!workspace) throw new FocusNotFoundError('The focus workspace is unavailable.');
    return workspace;
  }

  #requireSession(
    repository: FocusRepository,
    workspaceId: string,
    sessionId: string,
  ): StoredFocusSession {
    const session = repository.find(workspaceId, sessionId);
    if (!session) throw new FocusNotFoundError();
    return session;
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new FocusValidationError('Focus workspace id is invalid.', { cause: error });
    }
  }

  #taskId(value: unknown): string {
    try {
      return normalizeTaskId(value);
    } catch (error) {
      throw new FocusValidationError('Focus task id is invalid.', { cause: error });
    }
  }

  #sessionId(value: unknown): string {
    try {
      return normalizeFocusSessionId(value);
    } catch (error) {
      throw new FocusValidationError('Focus session id is invalid.', { cause: error });
    }
  }

  #newSessionId(): string {
    try {
      return normalizeFocusSessionId(this.#idFactory());
    } catch (error) {
      throw new FocusValidationError('Generated focus session id is invalid.', { cause: error });
    }
  }

  #revision(value: unknown): number {
    try {
      return normalizeFocusRevision(value);
    } catch (error) {
      throw new FocusValidationError('Focus session revision is invalid.', { cause: error });
    }
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new FocusValidationError('Focus clock is invalid.');
    return now;
  }

  #validMonotonicNow(): number {
    const now = this.#monotonicNowMs();
    if (!Number.isFinite(now) || now < 0) {
      throw new FocusValidationError('Focus monotonic clock is invalid.');
    }
    return now;
  }

  #todayDate(now: Date): string {
    try {
      return normalizeTaskCivilDate(
        this.#todayFactory === undefined ? formatLocalTaskDate(now) : this.#todayFactory(),
      );
    } catch (error) {
      throw new FocusValidationError('Focus local date is invalid.', { cause: error });
    }
  }

  #timestampAtLeast(now: Date, ...lowerBounds: readonly string[]): string {
    let latest = now.toISOString();
    for (const lowerBound of lowerBounds) {
      const timestamp = normalizeFocusTimestamp(lowerBound, 'Focus timestamp boundary');
      if (timestamp > latest) latest = timestamp;
    }
    return latest;
  }
}

function toOpenSession(session: StoredFocusSession | undefined): FocusSnapshot['session'] {
  if (!session) return null;
  if (session.status !== 'running' && session.status !== 'paused') {
    throw new DatabaseIntegrityError('A terminal focus session appeared as globally open.');
  }
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    taskId: session.taskId,
    taskTitle: session.taskTitle,
    status: session.status,
    remainingSeconds: session.remainingSeconds,
    deadlineAt: session.deadlineAt,
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}
