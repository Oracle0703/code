import type { BackupPolicy } from '../../shared/contracts';

const DAILY_MINIMUM_INTERVAL_MS = 20 * 60 * 60 * 1_000;
const WEEKLY_MINIMUM_INTERVAL_MS = 6 * 24 * 60 * 60 * 1_000;

export interface BackupScheduleHistory {
  readonly lastSuccessAt: string | null;
  readonly lastSuccessBucket: string | null;
}

export interface BackupScheduleDecision {
  readonly due: boolean;
  readonly dueBucket: string | null;
  readonly scheduledFor: string | null;
  readonly nextRunAt: string | null;
}

export function calculateBackupSchedule(
  policy: BackupPolicy,
  history: BackupScheduleHistory,
  now: Date,
): BackupScheduleDecision {
  assertValidDate(now, 'current time');
  validatePolicy(policy);
  validateHistory(history);

  if (!policy.enabled) {
    return {
      due: false,
      dueBucket: null,
      scheduledFor: null,
      nextRunAt: null,
    };
  }

  const policyUpdatedAt = new Date(policy.updatedAt);
  const lastSuccessAt = history.lastSuccessAt === null ? null : new Date(history.lastSuccessAt);
  const anchor = lastSuccessAt && lastSuccessAt > policyUpdatedAt ? lastSuccessAt : policyUpdatedAt;
  const latest = latestOccurrenceAtOrBefore(policy, now);
  const bucket = formatBackupBucket(policy.cadence, latest);
  const minimumInterval =
    policy.cadence === 'daily' ? DAILY_MINIMUM_INTERVAL_MS : WEEKLY_MINIMUM_INTERVAL_MS;
  const intervalSatisfied =
    lastSuccessAt === null || now.getTime() - lastSuccessAt.getTime() >= minimumInterval;
  const isNewOccurrence =
    latest > anchor && history.lastSuccessBucket !== bucket && intervalSatisfied;

  if (isNewOccurrence) {
    return {
      due: true,
      dueBucket: bucket,
      scheduledFor: latest.toISOString(),
      nextRunAt: now.toISOString(),
    };
  }

  let next = nextOccurrenceAfter(policy, now);
  if (lastSuccessAt !== null) {
    const intervalBoundary = new Date(lastSuccessAt.getTime() + minimumInterval);
    if (intervalBoundary > now && intervalBoundary < next) {
      next = intervalBoundary;
    }
  }
  return {
    due: false,
    dueBucket: null,
    scheduledFor: null,
    nextRunAt: next.toISOString(),
  };
}

export function formatBackupBucket(cadence: BackupPolicy['cadence'], occurrence: Date): string {
  assertValidDate(occurrence, 'backup occurrence');
  return `${cadence}:${formatLocalCivilDate(occurrence)}`;
}

function latestOccurrenceAtOrBefore(policy: BackupPolicy, now: Date): Date {
  const occurrence = atLocalMinute(now, policy.localTimeMinute);
  if (policy.cadence === 'daily') {
    if (occurrence > now) occurrence.setDate(occurrence.getDate() - 1);
    return occurrence;
  }

  const weekday = policy.weekday;
  if (weekday === null) {
    throw new TypeError('A weekly backup policy requires a weekday.');
  }
  const daysSinceTarget = (occurrence.getDay() - weekday + 7) % 7;
  occurrence.setDate(occurrence.getDate() - daysSinceTarget);
  if (occurrence > now) occurrence.setDate(occurrence.getDate() - 7);
  return occurrence;
}

function nextOccurrenceAfter(policy: BackupPolicy, now: Date): Date {
  const latest = latestOccurrenceAtOrBefore(policy, now);
  const next = new Date(latest);
  next.setDate(next.getDate() + (policy.cadence === 'daily' ? 1 : 7));
  return next;
}

function atLocalMinute(date: Date, localTimeMinute: number): Date {
  const hour = Math.floor(localTimeMinute / 60);
  const minute = localTimeMinute % 60;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function formatLocalCivilDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(date.getDate()).padStart(2, '0')}`;
}

function validatePolicy(policy: BackupPolicy): void {
  if (
    typeof policy.enabled !== 'boolean' ||
    (policy.cadence !== 'daily' && policy.cadence !== 'weekly') ||
    !Number.isSafeInteger(policy.localTimeMinute) ||
    policy.localTimeMinute < 0 ||
    policy.localTimeMinute > 1_439 ||
    !Number.isSafeInteger(policy.retentionCount) ||
    policy.retentionCount < 1 ||
    policy.retentionCount > 90 ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 1
  ) {
    throw new TypeError('The backup policy is invalid.');
  }
  if (
    (policy.cadence === 'daily' && policy.weekday !== null) ||
    (policy.cadence === 'weekly' &&
      (!Number.isSafeInteger(policy.weekday) ||
        (policy.weekday as number) < 0 ||
        (policy.weekday as number) > 6))
  ) {
    throw new TypeError('The backup policy weekday is invalid.');
  }
  assertIsoTimestamp(policy.updatedAt, 'backup policy update time');
}

function validateHistory(history: BackupScheduleHistory): void {
  if (history.lastSuccessAt !== null) {
    assertIsoTimestamp(history.lastSuccessAt, 'last successful backup time');
  }
  if (
    history.lastSuccessBucket !== null &&
    !/^(?:daily|weekly):\d{4}-\d{2}-\d{2}$/u.test(history.lastSuccessBucket)
  ) {
    throw new TypeError('The last successful backup bucket is invalid.');
  }
  if ((history.lastSuccessAt === null) !== (history.lastSuccessBucket === null)) {
    throw new TypeError('The last successful backup state is incomplete.');
  }
}

function assertIsoTimestamp(value: string, name: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError(`The ${name} is invalid.`);
  }
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`The ${name} is invalid.`);
  }
}
