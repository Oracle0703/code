import { describe, expect, it } from 'vitest';
import {
  addCivilDays,
  createRollingPlanningDays,
  isDateInRollingPlanningWindow,
  planningDateForTask,
  planningTokenForDate,
  planningWindowEndDate,
} from '../src/shared/planning-domain';

describe('rolling planning domain', () => {
  it('creates one authoritative seven-day token window across month and leap-day boundaries', () => {
    expect(createRollingPlanningDays('2028-02-27')).toEqual([
      { token: 'day-0', date: '2028-02-27' },
      { token: 'day-1', date: '2028-02-28' },
      { token: 'day-2', date: '2028-02-29' },
      { token: 'day-3', date: '2028-03-01' },
      { token: 'day-4', date: '2028-03-02' },
      { token: 'day-5', date: '2028-03-03' },
      { token: 'day-6', date: '2028-03-04' },
    ]);
  });

  it('advances civil calendar fields instead of elapsed local-day milliseconds', () => {
    expect(addCivilDays('2026-12-29', 6)).toBe('2027-01-04');
    expect(addCivilDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addCivilDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('maps only fixed task tokens into the current rolling window', () => {
    expect(planningDateForTask('none', '2026-07-23')).toBeNull();
    expect(planningDateForTask('day-0', '2026-07-23')).toBe('2026-07-23');
    expect(planningDateForTask('day-6', '2026-07-23')).toBe('2026-07-29');
    expect(planningTokenForDate('2026-07-26', '2026-07-23')).toBe('day-3');
    expect(planningTokenForDate('2026-07-30', '2026-07-23')).toBeNull();
    expect(planningWindowEndDate('2026-07-23')).toBe('2026-07-29');
    expect(isDateInRollingPlanningWindow('2026-07-29', '2026-07-23')).toBe(true);
    expect(isDateInRollingPlanningWindow('2026-07-30', '2026-07-23')).toBe(false);
  });

  it('rejects malformed dates, fractional offsets, and calendar overflow', () => {
    expect(() => createRollingPlanningDays('2026-02-30')).toThrow();
    expect(() => addCivilDays('2026-07-23', 0.5)).toThrow();
    expect(() => createRollingPlanningDays('9999-12-31')).toThrow();
  });
});
