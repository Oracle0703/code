import { describe, expect, it, vi } from 'vitest';
import {
  createdScheduleFromResult,
  createScheduleRequestIdentity,
  createScheduleWorkspaceIdentity,
  defaultScheduleRange,
  defaultScheduleRangeForPlanningDate,
  formatScheduleInputMinute,
  isScheduleRequestCurrent,
  isScheduleRequestLatest,
  isScheduleSequenceCurrent,
  isScheduleSnapshotDateCurrent,
  isScheduleWorkspaceCurrent,
  parseScheduleInputMinute,
  reconcileScheduleCreateResult,
  scheduleSnapshotForActivation,
  shouldApplyScheduleSnapshot,
  sortScheduleItems,
} from '../src/renderer/schedule-state';
import type { ScheduleItem, ScheduleSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-07-22';
const TOMORROW = '2026-07-23';

describe('schedule renderer state', () => {
  it('binds snapshots to one activation identity and rejects an old A after A to B to A', () => {
    const firstA = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const secondA = createScheduleWorkspaceIdentity(WORKSPACE_A);
    const request = createScheduleRequestIdentity(firstA, 7);
    expect(request).not.toBeNull();
    if (!request) return;
    const currentSnapshot = snapshot();
    const localToday = new Date(2026, 6, 22, 9, 30);

    expect(firstA).toEqual(secondA);
    expect(firstA).not.toBe(secondA);
    expect(isScheduleRequestCurrent(firstA, request)).toBe(true);
    expect(isScheduleRequestCurrent(secondA, request)).toBe(false);
    expect(isScheduleRequestCurrent(createScheduleWorkspaceIdentity(WORKSPACE_B), request)).toBe(
      false,
    );
    expect(shouldApplyScheduleSnapshot(firstA, 6, request, currentSnapshot, localToday)).toBe(true);
    expect(shouldApplyScheduleSnapshot(firstA, 7, request, currentSnapshot, localToday)).toBe(
      false,
    );
    expect(shouldApplyScheduleSnapshot(secondA, 6, request, currentSnapshot, localToday)).toBe(
      false,
    );
    expect(
      shouldApplyScheduleSnapshot(
        firstA,
        6,
        request,
        snapshot({ workspaceId: WORKSPACE_B }),
        localToday,
      ),
    ).toBe(false);
    expect(
      shouldApplyScheduleSnapshot(
        firstA,
        6,
        request,
        snapshot({ todayDate: TOMORROW }),
        localToday,
      ),
    ).toBe(false);
    expect(
      scheduleSnapshotForActivation(
        firstA,
        { activation: firstA, snapshot: currentSnapshot },
        localToday,
      ),
    ).toBe(currentSnapshot);
    expect(
      scheduleSnapshotForActivation(
        secondA,
        { activation: firstA, snapshot: currentSnapshot },
        localToday,
      ),
    ).toBeNull();
    expect(createScheduleRequestIdentity(createScheduleWorkspaceIdentity(null), 8)).toBeNull();
    expect(createScheduleRequestIdentity(firstA, -1)).toBeNull();
  });

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
    const currentSnapshot = snapshot();
    const localToday = new Date(2026, 6, 22, 9, 30);
    expect(isScheduleWorkspaceCurrent(WORKSPACE_A, currentSnapshot)).toBe(true);
    expect(isScheduleWorkspaceCurrent(WORKSPACE_B, currentSnapshot)).toBe(false);
    expect(isScheduleWorkspaceCurrent(null, currentSnapshot)).toBe(false);
    expect(isScheduleSnapshotDateCurrent(currentSnapshot, localToday)).toBe(true);
    expect(
      isScheduleSnapshotDateCurrent({ ...currentSnapshot, todayDate: '2026-07-21' }, localToday),
    ).toBe(false);
  });

  it('resolves only the Main-returned opaque id on its expected date', () => {
    const created = item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      540,
      600,
      '2026-07-22T08:00:00.000Z',
    );
    const duplicate = item(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      540,
      600,
      '2026-07-22T08:01:00.000Z',
    );
    const sameVisibleFields = {
      ...duplicate,
      title: created.title,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
    const result = {
      scheduleSnapshot: snapshot({ items: [sameVisibleFields, created] }),
      createdScheduleId: created.id,
    };

    expect(createdScheduleFromResult(WORKSPACE_A, TODAY, result)).toBe(created);
    expect(createdScheduleFromResult(WORKSPACE_B, TODAY, result)).toBeNull();
    expect(createdScheduleFromResult(WORKSPACE_A, TOMORROW, result)).toBeNull();
    expect(
      createdScheduleFromResult(WORKSPACE_A, TODAY, {
        ...result,
        createdScheduleId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ).toBeNull();
    expect(
      createdScheduleFromResult(WORKSPACE_A, TODAY, {
        ...result,
        scheduleSnapshot: snapshot({ items: [created, { ...created }] }),
      }),
    ).toBeNull();
  });

  it('commits the schedule:create transaction snapshot without an extra read', async () => {
    const created = item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      540,
      600,
      '2026-07-22T08:00:00.000Z',
    );
    const commitResultSnapshot = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileScheduleCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        expectedScheduledFor: TODAY,
        result: {
          scheduleSnapshot: snapshot({ items: [created] }),
          createdScheduleId: created.id,
        },
        commitResultSnapshot,
        getCommittedSchedule: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdSchedule: created,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('recovers on the second authoritative read after the first read fails', async () => {
    const created = item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      540,
      600,
      '2026-07-22T08:00:00.000Z',
    );
    const firstFailure = new Error('internal database path must not become UI text');
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce({
        snapshot: snapshot({ items: [created] }),
        commit: () => true,
      });

    await expect(
      reconcileScheduleCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        expectedScheduledFor: TODAY,
        result: {
          scheduleSnapshot: snapshot({ items: [created] }),
          createdScheduleId: created.id,
        },
        commitResultSnapshot: () => false,
        getCommittedSchedule: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdSchedule: created,
      committed: true,
      error: firstFailure,
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('recovers on the second authoritative read after the first omits the exact id', async () => {
    const created = item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      540,
      600,
      '2026-07-22T08:00:00.000Z',
    );
    const sameVisibleFields = {
      ...item('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 540, 600, '2026-07-22T08:00:00.000Z'),
      title: created.title,
    };
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: snapshot({ items: [sameVisibleFields] }),
        commit: () => true,
      })
      .mockResolvedValueOnce({
        snapshot: snapshot({ items: [sameVisibleFields, created] }),
        commit: () => true,
      });

    const reconciled = await reconcileScheduleCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      expectedScheduledFor: TODAY,
      result: {
        scheduleSnapshot: snapshot({ items: [created] }),
        createdScheduleId: created.id,
      },
      commitResultSnapshot: () => false,
      getCommittedSchedule: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdSchedule).toBe(created);
    expect(reconciled.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('recovers a cross-midnight result when the exact item remains in the new window', async () => {
    const created = {
      ...item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 540, 600, '2026-07-22T23:59:59.000Z'),
      scheduledFor: TOMORROW,
    };
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot({
        todayDate: TOMORROW,
        items: [created],
      }),
      commit: () => true,
    }));

    const reconciled = await reconcileScheduleCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      expectedScheduledFor: TOMORROW,
      result: {
        scheduleSnapshot: snapshot({ items: [created] }),
        createdScheduleId: created.id,
      },
      commitResultSnapshot: () => false,
      getCommittedSchedule: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled).toEqual({
      createdSchedule: created,
      committed: true,
      error: undefined,
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledOnce();
  });

  it('stops reconciliation when its workspace activation is no longer current', async () => {
    const created = item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      540,
      600,
      '2026-07-22T08:00:00.000Z',
    );
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileScheduleCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        expectedScheduledFor: TODAY,
        result: {
          scheduleSnapshot: snapshot({ items: [created] }),
          createdScheduleId: created.id,
        },
        commitResultSnapshot: () => false,
        getCommittedSchedule: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => false,
      }),
    ).resolves.toEqual({
      createdSchedule: created,
      committed: false,
      error: undefined,
    });
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('fails closed after two authoritative reads miss the exact id', async () => {
    const created = item(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      540,
      600,
      '2026-07-22T08:00:00.000Z',
    );
    const sameVisibleFields = {
      ...item('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 540, 600, '2026-07-22T08:00:00.000Z'),
      title: created.title,
    };
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot({ items: [sameVisibleFields] }),
      commit: () => true,
    }));

    const reconciled = await reconcileScheduleCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      expectedScheduledFor: TODAY,
      result: {
        scheduleSnapshot: snapshot({ items: [created] }),
        createdScheduleId: created.id,
      },
      commitResultSnapshot: () => false,
      getCommittedSchedule: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdSchedule).toBe(created);
    expect(reconciled.committed).toBe(false);
    expect(reconciled.error).toBeInstanceOf(Error);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
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

  it('uses current time for today and a stable morning default for future days', () => {
    const now = new Date(2026, 6, 22, 9, 7);
    expect(defaultScheduleRangeForPlanningDate(TODAY, TODAY, now)).toEqual({
      expectedDate: TODAY,
      startMinute: 570,
      endMinute: 600,
    });
    expect(defaultScheduleRangeForPlanningDate('2026-07-25', TODAY, now)).toEqual({
      expectedDate: '2026-07-25',
      startMinute: 540,
      endMinute: 570,
    });
  });
});

function snapshot({
  workspaceId = WORKSPACE_A,
  todayDate = TODAY,
  items = [],
}: {
  workspaceId?: string;
  todayDate?: string;
  items?: readonly ScheduleItem[];
} = {}): ScheduleSnapshot {
  return {
    workspaceId,
    todayDate,
    planningDays: createRollingPlanningDays(todayDate),
    items,
  };
}

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
