import { FOCUS_STATES, type FocusState } from './contracts';

export const FOCUS_DURATION_SECONDS = 1_500;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function normalizeFocusSessionId(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError('Focus session id must be a lowercase UUID v4.');
  }
  return value;
}

export function normalizeFocusState(value: unknown): FocusState {
  if (typeof value !== 'string' || !FOCUS_STATES.includes(value as FocusState)) {
    throw new TypeError('Focus session state is not supported.');
  }
  return value as FocusState;
}

export function normalizeFocusRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Focus session revision must be a positive safe integer.');
  }
  return value as number;
}

export function normalizeFocusRemainingSeconds(value: unknown, allowZero = true): number {
  const minimum = allowZero ? 0 : 1;
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > FOCUS_DURATION_SECONDS
  ) {
    throw new TypeError(
      `Focus remaining time must be an integer between ${minimum} and ${FOCUS_DURATION_SECONDS}.`,
    );
  }
  return value as number;
}

export function normalizeFocusTimestamp(value: unknown, name = 'Focus timestamp'): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be an ISO timestamp.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${name} must be an ISO timestamp.`);
  }
  return value;
}

export function focusDeadlineAt(now: Date, remainingSeconds: number): string {
  if (!Number.isFinite(now.getTime())) throw new TypeError('Focus clock is invalid.');
  const remaining = normalizeFocusRemainingSeconds(remainingSeconds, false);
  const deadline = new Date(now.getTime() + remaining * 1_000);
  if (!Number.isFinite(deadline.getTime())) throw new TypeError('Focus deadline is invalid.');
  return deadline.toISOString();
}

export function focusRemainingAt(
  storedRemainingSeconds: number,
  deadlineAt: string,
  now: Date,
): number {
  const storedRemaining = normalizeFocusRemainingSeconds(storedRemainingSeconds, false);
  const deadline = Date.parse(normalizeFocusTimestamp(deadlineAt, 'Focus deadline'));
  if (!Number.isFinite(now.getTime())) throw new TypeError('Focus clock is invalid.');
  const remainingMilliseconds = deadline - now.getTime();
  if (remainingMilliseconds <= 0) return 0;
  return Math.min(storedRemaining, Math.ceil(remainingMilliseconds / 1_000));
}
