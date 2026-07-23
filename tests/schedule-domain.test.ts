import { describe, expect, it } from 'vitest';
import {
  formatLocalScheduleDate,
  formatScheduleMinute,
  normalizeScheduleCivilDate,
  normalizeScheduleId,
  normalizeScheduleKind,
  normalizeScheduleRange,
  normalizeScheduleRevision,
  normalizeScheduleTitle,
} from '../src/shared/schedule-domain';

describe('schedule domain', () => {
  it('accepts bounded same-day ranges including both day edges', () => {
    expect(normalizeScheduleRange(0, 1)).toEqual({ startMinute: 0, endMinute: 1 });
    expect(normalizeScheduleRange(1439, 1440)).toEqual({
      startMinute: 1439,
      endMinute: 1440,
    });
    expect(formatScheduleMinute(0)).toBe('00:00');
    expect(formatScheduleMinute(1439)).toBe('23:59');
    expect(formatScheduleMinute(1440)).toBe('24:00');
  });

  it('rejects equal, reversed, fractional, and out-of-range minutes', () => {
    for (const range of [
      [60, 60],
      [61, 60],
      [-1, 30],
      [0, 1441],
      [0.5, 30],
    ] as const) {
      expect(() => normalizeScheduleRange(range[0], range[1])).toThrow(TypeError);
    }
  });

  it('validates civil dates without accepting SQLite-style overflow dates', () => {
    expect(normalizeScheduleCivilDate('2026-07-22')).toBe('2026-07-22');
    expect(() => normalizeScheduleCivilDate('2026-02-30')).toThrow(TypeError);
    expect(() => normalizeScheduleCivilDate('2026-99-99')).toThrow(TypeError);
    expect(() => normalizeScheduleCivilDate('0000-01-01')).toThrow(TypeError);
    expect(formatLocalScheduleDate(new Date(2026, 6, 22, 23, 59))).toBe('2026-07-22');
  });

  it('accepts only declared kinds, visible titles, and lowercase UUID v4 ids', () => {
    expect(normalizeScheduleKind('meeting')).toBe('meeting');
    expect(() => normalizeScheduleKind('reminder')).toThrow(TypeError);
    expect(normalizeScheduleTitle('  Wiki 评审  ')).toBe('Wiki 评审');
    expect(() => normalizeScheduleTitle('评审\n第二行')).toThrow(TypeError);
    expect(normalizeScheduleId('123e4567-e89b-42d3-a456-426614174000')).toBe(
      '123e4567-e89b-42d3-a456-426614174000',
    );
    expect(normalizeScheduleRevision(2)).toBe(2);
    expect(() => normalizeScheduleRevision(0)).toThrow(TypeError);
  });
});
