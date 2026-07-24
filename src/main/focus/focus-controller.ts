import type {
  FocusChangedEvent,
  FocusSession,
  FocusSnapshot,
  FocusStartInput,
  FocusTargetInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import { normalizeFocusRemainingSeconds, normalizeFocusTimestamp } from '../../shared/focus-domain';
import { FocusOperationError } from './focus-errors';
import type { FocusReconcileResult } from './focus-service';

export interface FocusControllerDatabase {
  getFocusSnapshot(input: WorkspaceTargetInput): Promise<FocusSnapshot>;
  startFocusSession(input: FocusStartInput): Promise<FocusSnapshot>;
  pauseFocusSession(input: FocusTargetInput): Promise<FocusSnapshot>;
  resumeFocusSession(input: FocusTargetInput): Promise<FocusSnapshot>;
  cancelFocusSession(input: FocusTargetInput): Promise<FocusSnapshot>;
  reconcileFocusSession(): Promise<FocusReconcileResult>;
  pauseRunningFocusSession(): Promise<FocusReconcileResult>;
}

export interface FocusControllerTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface FocusControllerOptions {
  readonly database: FocusControllerDatabase;
  readonly now?: () => Date;
  readonly timer?: FocusControllerTimer;
  readonly maximumWakeDelayMs?: number;
  readonly onChanged?: (event: FocusChangedEvent) => void;
  readonly onError?: (error: unknown) => void;
}

const defaultTimer: FocusControllerTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class FocusController {
  readonly #database: FocusControllerDatabase;
  readonly #now: () => Date;
  readonly #timer: FocusControllerTimer;
  readonly #maximumWakeDelayMs: number;
  readonly #onChanged: (event: FocusChangedEvent) => void;
  readonly #onError: (error: unknown) => void;
  #started = false;
  #timerHandle: unknown;
  #evaluation: Promise<void> | undefined;
  readonly #operations = new Set<Promise<unknown>>();
  #trackedSession: FocusSession | null = null;
  #stopPromise: Promise<void> | undefined;

  constructor({
    database,
    now = () => new Date(),
    timer = defaultTimer,
    maximumWakeDelayMs = 60_000,
    onChanged = () => undefined,
    onError = () => undefined,
  }: FocusControllerOptions) {
    if (
      !Number.isSafeInteger(maximumWakeDelayMs) ||
      maximumWakeDelayMs < 1 ||
      maximumWakeDelayMs > 60_000
    ) {
      throw new TypeError('Focus wake delay must be an integer from 1 to 60000 milliseconds.');
    }
    this.#database = database;
    this.#now = now;
    this.#timer = timer;
    this.#maximumWakeDelayMs = maximumWakeDelayMs;
    this.#onChanged = onChanged;
    this.#onError = onError;
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<FocusSnapshot> {
    return this.#runWhileStarted(async () => {
      await this.evaluate();
      const snapshot = await this.#database.getFocusSnapshot(input);
      this.#track(snapshot.session);
      return snapshot;
    });
  }

  startSession(input: FocusStartInput): Promise<FocusSnapshot> {
    return this.#runWhileStarted(async () => {
      const snapshot = await this.#database.startFocusSession(input);
      this.#track(snapshot.session);
      this.#emit({ workspaceId: input.workspaceId, reason: 'transition' });
      return snapshot;
    });
  }

  pauseSession(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#runWhileStarted(() =>
      this.#mutate(input.workspaceId, () => this.#database.pauseFocusSession(input)),
    );
  }

  resumeSession(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#runWhileStarted(() =>
      this.#mutate(input.workspaceId, () => this.#database.resumeFocusSession(input)),
    );
  }

  cancelSession(input: FocusTargetInput): Promise<FocusSnapshot> {
    return this.#runWhileStarted(() =>
      this.#mutate(input.workspaceId, () => this.#database.cancelFocusSession(input)),
    );
  }

  start(): Promise<void> {
    if (this.#stopPromise) {
      return Promise.reject(new FocusOperationError('The focus controller is stopping.'));
    }
    if (this.#started) return this.evaluate();
    this.#started = true;
    return this.evaluate().catch((error) => {
      if (this.#started) {
        this.#started = false;
        this.#clearTimer();
      }
      throw error;
    });
  }

  evaluate(): Promise<void> {
    if (!this.#started) return Promise.resolve();
    if (this.#evaluation) return this.#evaluation;
    const evaluation = (async () => {
      const result = await this.#database.reconcileFocusSession();
      this.#track(result.session);
      if (result.changed && result.changedWorkspaceId !== null) {
        this.#emit({ workspaceId: result.changedWorkspaceId, reason: 'timer' });
      }
    })();
    this.#evaluation = evaluation;
    return evaluation.finally(() => {
      if (this.#evaluation === evaluation) this.#evaluation = undefined;
    });
  }

  handleExternalChange(): Promise<void> {
    if (!this.#started) return Promise.resolve();
    return this.#runWhileStarted(() => this.#handleExternalChange());
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#started = false;
    this.#clearTimer();
    const operation = (async () => {
      const pending = [...(this.#evaluation ? [this.#evaluation] : []), ...this.#operations];
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === 'rejected') this.#safeError(result.reason);
      }
      const previous = this.#trackedSession;
      const result = await this.#database.pauseRunningFocusSession();
      this.#trackedSession = result.session;
      if (result.changed && result.changedWorkspaceId !== null) {
        this.#emit({ workspaceId: result.changedWorkspaceId, reason: 'transition' });
      } else if (!sameSession(previous, result.session) && previous) {
        this.#emit({ workspaceId: previous.workspaceId, reason: 'external' });
      }
    })();
    const stop = operation.finally(() => {
      if (this.#stopPromise === stop) this.#stopPromise = undefined;
    });
    this.#stopPromise = stop;
    return stop;
  }

  #runWhileStarted<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#started || this.#stopPromise) {
      return Promise.reject(new FocusOperationError('The focus controller is not running.'));
    }
    let running: Promise<T>;
    try {
      running = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#operations.add(running);
    return running.finally(() => {
      this.#operations.delete(running);
    });
  }

  async #mutate(
    workspaceId: string,
    operation: () => Promise<FocusSnapshot>,
  ): Promise<FocusSnapshot> {
    const snapshot = await operation();
    this.#track(snapshot.session);
    this.#emit({ workspaceId, reason: 'transition' });
    return snapshot;
  }

  async #handleExternalChange(): Promise<void> {
    const previous = this.#trackedSession;
    const result = await this.#database.reconcileFocusSession();
    this.#track(result.session);
    const emitted = new Set<string>();
    if (result.changed && result.changedWorkspaceId !== null) {
      emitted.add(result.changedWorkspaceId);
      this.#emit({ workspaceId: result.changedWorkspaceId, reason: 'timer' });
    }
    if (!sameSession(previous, result.session)) {
      for (const workspaceId of [previous?.workspaceId, result.session?.workspaceId]) {
        if (workspaceId && !emitted.has(workspaceId)) {
          emitted.add(workspaceId);
          this.#emit({ workspaceId, reason: 'external' });
        }
      }
    }
  }

  #track(session: FocusSession | null): void {
    this.#trackedSession = session;
    this.#clearTimer();
    if (!this.#started || session?.status !== 'running' || session.deadlineAt === null) return;
    let remainingMilliseconds: number;
    try {
      const persistedUpperBound =
        normalizeFocusRemainingSeconds(session.remainingSeconds, false) * 1_000;
      const deadline = Date.parse(
        normalizeFocusTimestamp(session.deadlineAt, 'Focus controller deadline'),
      );
      remainingMilliseconds = Math.max(
        0,
        Math.min(persistedUpperBound, deadline - this.#validNow().getTime()),
      );
    } catch (error) {
      this.#safeError(error);
      return;
    }
    const delay = Math.min(this.#maximumWakeDelayMs, Math.max(0, remainingMilliseconds));
    this.#timerHandle = this.#timer.set(() => {
      this.#timerHandle = undefined;
      void this.evaluate().catch((error) => this.#safeError(error));
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timerHandle === undefined) return;
    this.#timer.clear(this.#timerHandle);
    this.#timerHandle = undefined;
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) throw new TypeError('Focus controller clock is invalid.');
    return now;
  }

  #emit(event: FocusChangedEvent): void {
    try {
      this.#onChanged(event);
    } catch (error) {
      this.#safeError(error);
    }
  }

  #safeError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // Diagnostics cannot change controller state.
    }
  }
}

function sameSession(left: FocusSession | null, right: FocusSession | null): boolean {
  return (
    left?.id === right?.id &&
    left?.workspaceId === right?.workspaceId &&
    left?.revision === right?.revision &&
    left?.status === right?.status
  );
}
