import { describe, expect, it } from 'vitest';
import type { ScheduleSnapshot, Task, TaskSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import {
  planningDayLabel,
  planningSnapshotsMatch,
  planningTokenAt,
  planningValueForTask,
} from '../src/renderer/planning-state';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-07-23';
const DAYS = createRollingPlanningDays(TODAY);

function taskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_ID,
    todayDate: TODAY,
    planningDays: DAYS,
    tasks: [],
    ...overrides,
  };
}

function scheduleSnapshot(overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot {
  return {
    workspaceId: WORKSPACE_ID,
    todayDate: TODAY,
    planningDays: DAYS,
    items: [],
    ...overrides,
  };
}

function task(plannedFor: string | null): Task {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    title: '验证计划',
    status: 'todo',
    plannedFor,
    sourceInboxEntryId: null,
    createdAt: '2026-07-23T12:00:00.000Z',
    updatedAt: '2026-07-23T12:00:00.000Z',
    completedAt: null,
  };
}

describe('rolling planning renderer state', () => {
  it('only combines canonical snapshots for the same workspace and window', () => {
    expect(planningSnapshotsMatch(taskSnapshot(), scheduleSnapshot())).toBe(true);
    expect(
      planningSnapshotsMatch(
        taskSnapshot(),
        scheduleSnapshot({ workspaceId: '33333333-3333-4333-8333-333333333333' }),
      ),
    ).toBe(false);
    expect(
      planningSnapshotsMatch(taskSnapshot(), scheduleSnapshot({ planningDays: DAYS.slice(0, 6) })),
    ).toBe(false);
    expect(
      planningSnapshotsMatch(
        taskSnapshot({ planningDays: DAYS.map((day, index) => (index === 2 ? DAYS[3] : day)) }),
        scheduleSnapshot(),
      ),
    ).toBe(false);
  });

  it('maps tasks to fixed tokens without inventing a token for outside dates', () => {
    expect(planningValueForTask(task(null), DAYS)).toBe('none');
    expect(planningValueForTask(task('2026-07-23'), DAYS)).toBe('day-0');
    expect(planningValueForTask(task('2026-07-29'), DAYS)).toBe('day-6');
    expect(planningValueForTask(task('2026-07-30'), DAYS)).toBe('outside-window');
  });

  it('provides stable tab navigation bounds and civil-date labels', () => {
    expect(planningTokenAt(DAYS, -1)).toBe('day-0');
    expect(planningTokenAt(DAYS, 3)).toBe('day-3');
    expect(planningTokenAt(DAYS, 99)).toBe('day-6');
    expect(planningDayLabel(DAYS[0])).toMatchObject({ short: '今天', date: '7月23日' });
    expect(planningDayLabel(DAYS[6]).date).toBe('7月29日');
  });
});
