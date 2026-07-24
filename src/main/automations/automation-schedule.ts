import type { AutomationSchedule } from '../../shared/contracts';
import {
  normalizeAutomationSchedule,
  normalizeAutomationRevision,
} from '../../shared/automation-domain';
import { formatLocalTaskDate, normalizeTaskCivilDate } from '../../shared/task-domain';

export interface AutomationScheduleHistory {
  readonly enabled: boolean;
  readonly effectiveAt: string | null;
  readonly lastSuccessOccurrence: string | null;
  readonly lastAttemptOccurrence: string | null;
  readonly lastErrorCode: string | null;
  readonly nextRetryAt: string | null;
}

export interface AutomationScheduleDecision {
  readonly due: boolean;
  readonly occurrenceDate: string | null;
  readonly scheduledFor: string | null;
  readonly nextRunAt: string | null;
}

export function calculateAutomationSchedule(
  scheduleValue: AutomationSchedule,
  history: AutomationScheduleHistory,
  now: Date,
): AutomationScheduleDecision {
  const schedule = normalizeAutomationSchedule(scheduleValue);
  assertValidDate(now, 'automation current time');
  validateHistory(history);

  if (!history.enabled || history.effectiveAt === null) {
    return {
      due: false,
      occurrenceDate: null,
      scheduledFor: null,
      nextRunAt: null,
    };
  }

  const latest = latestOccurrenceAtOrBefore(schedule, now);
  const latestDate = formatLocalTaskDate(latest);
  const effectiveAt = new Date(history.effectiveAt);
  // A wall-clock rollback must never make an older civil-date occurrence eligible again.
  // Treat the success watermark as monotonic even though the system clock is not.
  const alreadySucceeded =
    history.lastSuccessOccurrence !== null && history.lastSuccessOccurrence >= latestDate;
  const eligible = latest > effectiveAt && !alreadySucceeded;
  if (eligible) {
    if (
      history.lastAttemptOccurrence === latestDate &&
      history.lastErrorCode !== null &&
      history.nextRetryAt !== null
    ) {
      const retryAt = new Date(history.nextRetryAt);
      if (retryAt > now) {
        return {
          due: false,
          occurrenceDate: latestDate,
          scheduledFor: latest.toISOString(),
          nextRunAt: retryAt.toISOString(),
        };
      }
    }
    return {
      due: true,
      occurrenceDate: latestDate,
      scheduledFor: latest.toISOString(),
      nextRunAt: now.toISOString(),
    };
  }

  const next = nextOccurrenceAfter(schedule, now);
  return {
    due: false,
    occurrenceDate: null,
    scheduledFor: null,
    nextRunAt: next.toISOString(),
  };
}

export function latestAutomationOccurrence(
  scheduleValue: AutomationSchedule,
  now: Date,
): { readonly occurrenceDate: string; readonly scheduledFor: string } {
  const schedule = normalizeAutomationSchedule(scheduleValue);
  assertValidDate(now, 'automation current time');
  const occurrence = latestOccurrenceAtOrBefore(schedule, now);
  return {
    occurrenceDate: formatLocalTaskDate(occurrence),
    scheduledFor: occurrence.toISOString(),
  };
}

export function normalizeAutomationOccurrenceDate(value: unknown): string {
  return normalizeTaskCivilDate(value);
}

export function normalizeDefinitionRevision(value: unknown): number {
  return normalizeAutomationRevision(value);
}

function latestOccurrenceAtOrBefore(schedule: AutomationSchedule, now: Date): Date {
  const occurrence = atLocalMinute(now, schedule.localTimeMinute);
  if (schedule.cadence === 'daily') {
    if (occurrence > now) occurrence.setDate(occurrence.getDate() - 1);
    return occurrence;
  }

  if (schedule.weekday === null) {
    throw new TypeError('A weekly automation requires a weekday.');
  }
  const daysSinceTarget = (occurrence.getDay() - schedule.weekday + 7) % 7;
  occurrence.setDate(occurrence.getDate() - daysSinceTarget);
  if (occurrence > now) occurrence.setDate(occurrence.getDate() - 7);
  return occurrence;
}

function nextOccurrenceAfter(schedule: AutomationSchedule, now: Date): Date {
  const latest = latestOccurrenceAtOrBefore(schedule, now);
  const next = new Date(latest);
  next.setDate(next.getDate() + (schedule.cadence === 'daily' ? 1 : 7));
  return next;
}

function atLocalMinute(date: Date, localTimeMinute: number): Date {
  const hour = Math.floor(localTimeMinute / 60);
  const minute = localTimeMinute % 60;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function validateHistory(history: AutomationScheduleHistory): void {
  if (typeof history.enabled !== 'boolean') {
    throw new TypeError('Automation enabled state is invalid.');
  }
  if ((history.effectiveAt === null) === history.enabled) {
    throw new TypeError('Automation effective state is inconsistent.');
  }
  if (history.effectiveAt !== null) assertIsoTimestamp(history.effectiveAt, 'effective time');
  if (history.lastSuccessOccurrence !== null) {
    normalizeAutomationOccurrenceDate(history.lastSuccessOccurrence);
  }
  if (history.lastAttemptOccurrence !== null) {
    normalizeAutomationOccurrenceDate(history.lastAttemptOccurrence);
  }
  if ((history.lastErrorCode === null) !== (history.nextRetryAt === null)) {
    throw new TypeError('Automation retry state is inconsistent.');
  }
  if (history.nextRetryAt !== null) assertIsoTimestamp(history.nextRetryAt, 'retry time');
}

function assertIsoTimestamp(value: string, name: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`Automation ${name} is invalid.`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) throw new TypeError(`${name} is invalid.`);
}
