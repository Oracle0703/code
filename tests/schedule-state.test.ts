import { describe, expect, it } from 'vitest';
import {
  defaultScheduleRange,
  formatScheduleInputMinute,
  isScheduleRequestLatest,
  isScheduleSequenceCurrent,
  isScheduleSnapshotDateCurrent,
  isScheduleWorkspaceCurrent,
  parseScheduleInputMinute,
  sortScheduleItems,
} from '../src/renderer/schedule-state';
import type { ScheduleItem, ScheduleSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-07-22';

describe('schedule renderer state', () => {
  it('applies successful snapshots monotonically while failures must be latest', () => {
    expect(isScheduleSequenceCurrent(4, 5)).toBe(false);
    expect(isScheduleSequenceCurrent(5, 5)).toBe(true);
    expect(isScheduleSequenceCurrent(6, 5)).toBe(true);
    expect(isScheduleSequenceCurrent(4, 3)).toBe(true);

    expect(isScheduleRequestLatest(4, 5)).toBe(false);
    expect(isScheduleRequestLatest(5, 5)).toBe(true);
    expect(isScheduleRequestLatest(6, 5)).toBe(false);
  });

  it('rejects snapshots from another workspace or calendar date', () => {
    const snapshot: ScheduleSnapshot = {
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      items: [],
    };
    const localToday = new Date(2026, 6, 22, 9, 30);
    expect(isScheduleWorkspaceCurrent(WORKSPACE_A, snapshot)).toBe(true);
    expect(isScheduleWorkspaceCurrent(WORKSPACE_B, snapshot)).toBe(false);
    expect(isScheduleWorkspaceCurrent(null, snapshot)).toBe(false);
    expect(isScheduleSnapshotDateCurrent(snapshot, localToday)).toBe(true);
    expect(
      isScheduleSnapshotDateCurrent({ ...snapshot, todayDate: '2026-07-21' }, localToday),
    ).toBe(false);
  });

  it('sorts agenda rows by start, end, creation time, then id', () => {
    const items = [
      item('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 600, 660, '2026-07-22T12:00:00.000Z'),
      item('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 540, 600, '2026-07-22T13:00:00.000Z'),
      item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 540, 600, '2026-07-22T12:00:00.000Z'),
      item('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 540, 570, '2026-07-22T14:00:00.000Z'),
    ] as const;
    expect(sortScheduleItems(items).map(({ id }) => id)).toEqual([
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ]);
    expect(items[0].id).toBe('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  });

  it('parses strict 24-hour inputs and only permits 24:00 as an end', () => {
    expect(parseScheduleInputMinute('00:00')).toBe(0);
    expect(parseScheduleInputMinute('23:59')).toBe(1_439);
    expect(parseScheduleInputMinute('24:00')).toBeNull();
    expect(parseScheduleInputMinute('24:00', true)).toBe(1_440);
    expect(parseScheduleInputMinute('9:00')).toBeNull();
    expect(parseScheduleInputMinute('12:60')).toBeNull();
    expect(formatScheduleInputMinute(1_440)).toBe('24:00');
  });

  it('rounds a new agenda range to the next half hour without crossing the day', () => {
    expect(defaultScheduleRange(new Date(2026, 6, 22, 9, 7))).toEqual({
      expectedDate: TODAY,
      startMinute: 570,
      endMinute: 600,
    });
    expect(defaultScheduleRange(new Date(2026, 6, 22, 23, 50))).toEqual({
      expectedDate: TODAY,
      startMinute: 1_410,
      endMinute: 1_440,
    });
    expect(() => defaultScheduleRange(new Date(Number.NaN))).toThrow(TypeError);
  });
});

function item(id: string, startMinute: number, endMinute: number, createdAt: string): ScheduleItem {
  return {
    id,
    title: id,
    kind: 'focus',
    scheduledFor: TODAY,
    startMinute,
    endMinute,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  };
}
