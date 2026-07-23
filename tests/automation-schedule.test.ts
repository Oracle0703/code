import { describe, expect, it } from 'vitest';
import { calculateAutomationSchedule } from '../src/main/automations/automation-schedule';

const DAILY = { cadence: 'daily', localTimeMinute: 8 * 60 + 30, weekday: null } as const;

describe('automation schedule', () => {
  it('runs only the latest missed occurrence instead of replaying a backlog', () => {
    const decision = calculateAutomationSchedule(
      DAILY,
      {
        enabled: true,
        effectiveAt: '2026-07-01T00:00:00.000Z',
        lastSuccessOccurrence: '2026-07-01',
        lastAttemptOccurrence: '2026-07-01',
        lastErrorCode: null,
        nextRetryAt: null,
      },
      new Date(2026, 6, 23, 12, 0, 0),
    );

    expect(decision).toMatchObject({
      due: true,
      occurrenceDate: '2026-07-23',
      nextRunAt: new Date(2026, 6, 23, 12, 0, 0).toISOString(),
    });
  });

  it('does not run an occurrence at or before the enable/update boundary', () => {
    const now = new Date(2026, 6, 23, 12, 0, 0);
    expect(
      calculateAutomationSchedule(
        DAILY,
        {
          enabled: true,
          effectiveAt: now.toISOString(),
          lastSuccessOccurrence: null,
          lastAttemptOccurrence: null,
          lastErrorCode: null,
          nextRetryAt: null,
        },
        now,
      ),
    ).toMatchObject({
      due: false,
      occurrenceDate: null,
      scheduledFor: null,
    });
  });

  it('uses the persisted retry time only for the same failed occurrence', () => {
    const now = new Date(2026, 6, 23, 12, 0, 0);
    const retryAt = new Date(2026, 6, 23, 12, 5, 0).toISOString();
    expect(
      calculateAutomationSchedule(
        DAILY,
        {
          enabled: true,
          effectiveAt: '2026-07-01T00:00:00.000Z',
          lastSuccessOccurrence: null,
          lastAttemptOccurrence: '2026-07-23',
          lastErrorCode: 'action-failed',
          nextRetryAt: retryAt,
        },
        now,
      ),
    ).toMatchObject({
      due: false,
      occurrenceDate: '2026-07-23',
      nextRunAt: retryAt,
    });

    expect(
      calculateAutomationSchedule(
        DAILY,
        {
          enabled: true,
          effectiveAt: '2026-07-01T00:00:00.000Z',
          lastSuccessOccurrence: null,
          lastAttemptOccurrence: '2026-07-22',
          lastErrorCode: 'action-failed',
          nextRetryAt: retryAt,
        },
        now,
      ).due,
    ).toBe(true);
  });

  it('deduplicates a completed local-day occurrence across repeated evaluation', () => {
    const now = new Date(2026, 6, 23, 12, 0, 0);
    const decision = calculateAutomationSchedule(
      DAILY,
      {
        enabled: true,
        effectiveAt: '2026-07-01T00:00:00.000Z',
        lastSuccessOccurrence: '2026-07-23',
        lastAttemptOccurrence: '2026-07-23',
        lastErrorCode: null,
        nextRetryAt: null,
      },
      now,
    );
    expect(decision.due).toBe(false);
    expect(decision.nextRunAt).toBe(new Date(2026, 6, 24, 8, 30, 0).toISOString());
  });

  it('keeps daily and weekly success watermarks monotonic after the clock moves backwards', () => {
    const daily = calculateAutomationSchedule(
      DAILY,
      {
        enabled: true,
        effectiveAt: '2026-07-01T00:00:00.000Z',
        lastSuccessOccurrence: '2026-07-23',
        lastAttemptOccurrence: '2026-07-23',
        lastErrorCode: null,
        nextRetryAt: null,
      },
      new Date(2026, 6, 20, 12, 0, 0),
    );
    expect(daily.due).toBe(false);
    expect(daily.nextRunAt).toBe(new Date(2026, 6, 21, 8, 30, 0).toISOString());

    const weekly = calculateAutomationSchedule(
      { cadence: 'weekly', localTimeMinute: 17 * 60, weekday: 1 },
      {
        enabled: true,
        effectiveAt: '2026-07-01T00:00:00.000Z',
        lastSuccessOccurrence: '2026-07-20',
        lastAttemptOccurrence: '2026-07-20',
        lastErrorCode: null,
        nextRetryAt: null,
      },
      new Date(2026, 6, 13, 18, 0, 0),
    );
    expect(weekly.due).toBe(false);
    expect(weekly.nextRunAt).toBe(new Date(2026, 6, 20, 17, 0, 0).toISOString());
  });

  it('selects the latest weekly occurrence', () => {
    const now = new Date(2026, 6, 23, 12, 0, 0);
    expect(
      calculateAutomationSchedule(
        { cadence: 'weekly', localTimeMinute: 17 * 60, weekday: 1 },
        {
          enabled: true,
          effectiveAt: '2026-07-01T00:00:00.000Z',
          lastSuccessOccurrence: null,
          lastAttemptOccurrence: null,
          lastErrorCode: null,
          nextRetryAt: null,
        },
        now,
      ),
    ).toMatchObject({
      due: true,
      occurrenceDate: '2026-07-20',
      scheduledFor: new Date(2026, 6, 20, 17, 0, 0).toISOString(),
    });
  });
});
