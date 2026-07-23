import { describe, expect, it } from 'vitest';
import type { BackupPolicy } from '../src/shared/contracts';
import { calculateBackupSchedule } from '../src/main/database/backup-schedule';

const basePolicy: BackupPolicy = {
  enabled: true,
  cadence: 'daily',
  localTimeMinute: 120,
  weekday: null,
  retentionCount: 14,
  revision: 1,
  updatedAt: new Date(2026, 6, 20, 12).toISOString(),
};

describe('backup schedule calculation', () => {
  it('returns no run for a disabled policy', () => {
    expect(
      calculateBackupSchedule(
        { ...basePolicy, enabled: false },
        { lastSuccessAt: null, lastSuccessBucket: null },
        new Date(2026, 6, 22, 12),
      ),
    ).toEqual({
      due: false,
      dueBucket: null,
      scheduledFor: null,
      nextRunAt: null,
    });
  });

  it('catches up one missed daily run and does not repeat its bucket', () => {
    const now = new Date(2026, 6, 22, 12);
    const due = calculateBackupSchedule(
      basePolicy,
      { lastSuccessAt: null, lastSuccessBucket: null },
      now,
    );
    expect(due).toMatchObject({
      due: true,
      dueBucket: 'daily:2026-07-22',
      nextRunAt: now.toISOString(),
    });

    const completedAt = new Date(2026, 6, 22, 12, 1).toISOString();
    const next = calculateBackupSchedule(
      basePolicy,
      {
        lastSuccessAt: completedAt,
        lastSuccessBucket: 'daily:2026-07-22',
      },
      new Date(2026, 6, 22, 13),
    );
    expect(next.due).toBe(false);
    expect(new Date(next.nextRunAt as string).getDate()).toBe(23);
  });

  it('uses the selected weekday for weekly schedules', () => {
    const policy: BackupPolicy = {
      ...basePolicy,
      cadence: 'weekly',
      weekday: 1,
      updatedAt: new Date(2026, 6, 1).toISOString(),
    };
    const decision = calculateBackupSchedule(
      policy,
      { lastSuccessAt: null, lastSuccessBucket: null },
      new Date(2026, 6, 22, 12),
    );
    expect(decision.due).toBe(true);
    expect(decision.dueBucket).toBe('weekly:2026-07-20');
  });

  it('uses a minimum elapsed interval to resist clock and timezone rewinds', () => {
    const lastSuccess = new Date(2026, 6, 21, 10);
    const decision = calculateBackupSchedule(
      basePolicy,
      {
        lastSuccessAt: lastSuccess.toISOString(),
        lastSuccessBucket: 'daily:2026-07-21',
      },
      new Date(2026, 6, 22, 3),
    );
    expect(decision.due).toBe(false);
    expect(new Date(decision.nextRunAt as string).getTime()).toBe(
      lastSuccess.getTime() + 20 * 60 * 60 * 1_000,
    );
  });
});
