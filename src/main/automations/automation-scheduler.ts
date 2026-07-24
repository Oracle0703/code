import type { AutomationRunErrorCode } from '../../shared/contracts';
import type { StoredAutomation } from './automation-repository';
import {
  calculateAutomationSchedule,
  type AutomationScheduleDecision,
} from './automation-schedule';
import type { AutomationRunInput, AutomationRunResult } from './automation-service';

const DEFAULT_MAXIMUM_WAKE_DELAY_MS = 60 * 1_000;
const MAX_RUNS_PER_EVALUATION = 10;
const DUE_BATCH_DELAY_MS = 1_000;

export interface AutomationSchedulerStore {
  readSchedulerEntries(): Promise<readonly StoredAutomation[]>;
  runOccurrence(input: AutomationRunInput): Promise<AutomationRunResult>;
}

export interface AutomationSchedulerTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface AutomationSchedulerOptions {
  readonly store: AutomationSchedulerStore;
  readonly now?: () => Date;
  readonly timer?: AutomationSchedulerTimer;
  readonly maximumWakeDelayMs?: number;
  readonly onRun?: (result: AutomationRunResult) => void;
  readonly onError?: (error: unknown, code: AutomationRunErrorCode) => void;
}

export class AutomationScheduler {
  readonly #store: AutomationSchedulerStore;
  readonly #now: () => Date;
  readonly #timer: AutomationSchedulerTimer;
  readonly #maximumWakeDelayMs: number;
  readonly #onRun: (result: AutomationRunResult) => void;
  readonly #onError: (error: unknown, code: AutomationRunErrorCode) => void;
  #started = false;
  #stopping = false;
  #generation = 0;
  #timerHandle: unknown;
  #evaluation: Promise<void> | null = null;

  constructor({
    store,
    now = () => new Date(),
    timer = defaultTimer,
    maximumWakeDelayMs = DEFAULT_MAXIMUM_WAKE_DELAY_MS,
    onRun = () => undefined,
    onError = () => undefined,
  }: AutomationSchedulerOptions) {
    if (!Number.isSafeInteger(maximumWakeDelayMs) || maximumWakeDelayMs < 1_000) {
      throw new TypeError('The automation scheduler wake interval is invalid.');
    }
    this.#store = store;
    this.#now = now;
    this.#timer = timer;
    this.#maximumWakeDelayMs = maximumWakeDelayMs;
    this.#onRun = onRun;
    this.#onError = onError;
  }

  async start(): Promise<void> {
    if (this.#started && !this.#stopping) return this.evaluate();
    this.#generation += 1;
    this.#started = true;
    this.#stopping = false;
    return this.evaluate();
  }

  evaluate(): Promise<void> {
    if (!this.#started || this.#stopping) return Promise.resolve();
    if (this.#evaluation) return this.#evaluation;
    this.#clearTimer();
    const generation = this.#generation;
    const evaluation = this.#evaluateOnce(generation);
    this.#evaluation = evaluation;
    const clear = (): void => {
      if (this.#evaluation === evaluation) this.#evaluation = null;
    };
    void evaluation.then(clear, clear);
    return evaluation;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    this.#generation += 1;
    this.#clearTimer();
    await this.#evaluation;
    this.#stopping = false;
  }

  async #evaluateOnce(generation: number): Promise<void> {
    let entries: readonly StoredAutomation[];
    try {
      entries = await this.#store.readSchedulerEntries();
    } catch (error) {
      this.#safeError(error, 'database-unavailable');
      this.#scheduleAfter(this.#maximumWakeDelayMs, generation);
      return;
    }
    if (!this.#isCurrent(generation)) return;

    const now = this.#readNow();
    const candidates = entries
      .map((automation) => ({
        automation,
        decision: this.#decision(automation, now),
      }))
      .filter(
        (
          candidate,
        ): candidate is {
          automation: StoredAutomation;
          decision: AutomationScheduleDecision & {
            due: true;
            occurrenceDate: string;
            scheduledFor: string;
          };
        } =>
          candidate.decision.due &&
          candidate.decision.occurrenceDate !== null &&
          candidate.decision.scheduledFor !== null,
      )
      .sort(
        (left, right) =>
          left.decision.scheduledFor.localeCompare(right.decision.scheduledFor) ||
          left.automation.id.localeCompare(right.automation.id),
      );

    let processed = 0;
    for (const candidate of candidates) {
      if (!this.#isCurrent(generation) || processed >= MAX_RUNS_PER_EVALUATION) break;
      processed += 1;
      try {
        const result = await this.#store.runOccurrence({
          automationId: candidate.automation.id,
          expectedRevision: candidate.automation.revision,
          occurrenceDate: candidate.decision.occurrenceDate,
          scheduledFor: candidate.decision.scheduledFor,
        });
        this.#safeRun(result);
      } catch (error) {
        this.#safeError(error, 'database-unavailable');
        this.#scheduleAfter(this.#maximumWakeDelayMs, generation);
        return;
      }
    }
    if (!this.#isCurrent(generation)) return;

    if (candidates.length > processed) {
      this.#scheduleAfter(DUE_BATCH_DELAY_MS, generation);
      return;
    }
    try {
      const refreshed = await this.#store.readSchedulerEntries();
      if (!this.#isCurrent(generation)) return;
      const nextRunAt = this.#nextRunAt(refreshed, this.#readNow());
      this.#scheduleAt(nextRunAt, generation);
    } catch (error) {
      this.#safeError(error, 'database-unavailable');
      this.#scheduleAfter(this.#maximumWakeDelayMs, generation);
    }
  }

  #decision(automation: StoredAutomation, now: Date): AutomationScheduleDecision {
    return calculateAutomationSchedule(
      automation.schedule,
      {
        enabled: automation.enabled,
        effectiveAt: automation.effectiveAt,
        lastSuccessOccurrence: automation.runState.lastSuccessOccurrence,
        lastAttemptOccurrence: automation.runState.lastAttemptOccurrence,
        lastErrorCode: automation.runState.lastErrorCode,
        nextRetryAt: automation.runState.nextRetryAt,
      },
      now,
    );
  }

  #nextRunAt(entries: readonly StoredAutomation[], now: Date): string | null {
    let next: string | null = null;
    for (const automation of entries) {
      const candidate = this.#decision(automation, now).nextRunAt;
      if (candidate !== null && (next === null || candidate < next)) next = candidate;
    }
    return next;
  }

  #scheduleAt(nextRunAt: string | null, generation: number): void {
    const now = this.#readNow().getTime();
    const requestedDelay =
      nextRunAt === null ? this.#maximumWakeDelayMs : Date.parse(nextRunAt) - now;
    this.#scheduleAfter(
      Math.max(1_000, Math.min(this.#maximumWakeDelayMs, requestedDelay)),
      generation,
    );
  }

  #scheduleAfter(delayMs: number, generation: number): void {
    if (!this.#isCurrent(generation)) return;
    this.#clearTimer();
    this.#timerHandle = this.#timer.set(() => {
      this.#timerHandle = undefined;
      if (this.#isCurrent(generation))
        void this.evaluate().catch((error) => {
          this.#safeError(error, 'database-unavailable');
        });
    }, delayMs);
  }

  #clearTimer(): void {
    if (this.#timerHandle === undefined) return;
    this.#timer.clear(this.#timerHandle);
    this.#timerHandle = undefined;
  }

  #isCurrent(generation: number): boolean {
    return this.#started && !this.#stopping && this.#generation === generation;
  }

  #readNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError('The automation scheduler clock returned an invalid date.');
    }
    return value;
  }

  #safeRun(result: AutomationRunResult): void {
    try {
      this.#onRun(result);
    } catch (error) {
      this.#safeError(error, 'action-failed');
    }
  }

  #safeError(error: unknown, code: AutomationRunErrorCode): void {
    try {
      this.#onError(error, code);
    } catch {
      // A diagnostic callback must never change scheduler lifecycle.
    }
  }
}

const defaultTimer: AutomationSchedulerTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
