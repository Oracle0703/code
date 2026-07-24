import { describe, expect, it } from 'vitest';
import type { Task, TaskSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import {
  countTasks,
  filterTasks,
  isTaskRequestLatest,
  isTaskSequenceCurrent,
  isTaskSnapshotDateCurrent,
  isTaskWorkspaceCurrent,
  millisecondsUntilNextLocalDay,
  toLocalDateKey,
} from '../src/renderer/task-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-07-22';
const PLANNING_DAYS = createRollingPlanningDays(TODAY);

const tasks: readonly Task[] = [
  task('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '今天待办', 'todo', TODAY),
  task('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '今天完成', 'completed', TODAY),
  task('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '无日期进行中', 'in_progress', null),
  task('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '昨天遗留', 'todo', '2026-07-21'),
];

describe('task renderer state', () => {
  it('applies successful snapshots monotonically while failures must be latest', () => {
    expect(isTaskSequenceCurrent(4, 5)).toBe(false);
    expect(isTaskSequenceCurrent(5, 5)).toBe(true);
    expect(isTaskSequenceCurrent(6, 5)).toBe(true);
    expect(isTaskSequenceCurrent(4, 3)).toBe(true);

    expect(isTaskRequestLatest(4, 5)).toBe(false);
    expect(isTaskRequestLatest(5, 5)).toBe(true);
    expect(isTaskRequestLatest(6, 5)).toBe(false);
  });

  it('rejects snapshots from a previously active workspace', () => {
    const snapshot: TaskSnapshot = {
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      planningDays: PLANNING_DAYS,
      tasks: [],
    };
    expect(isTaskWorkspaceCurrent(WORKSPACE_A, snapshot)).toBe(true);
    expect(isTaskWorkspaceCurrent(WORKSPACE_B, snapshot)).toBe(false);
    expect(isTaskWorkspaceCurrent(null, snapshot)).toBe(false);
  });

  it('derives navigation and Today counts from one authoritative snapshot', () => {
    expect(countTasks(tasks, TODAY)).toEqual({
      active: 3,
      today: 1,
      todayTotal: 2,
      todayCompleted: 1,
      completed: 1,
    });
  });

  it('keeps an unfinished prior-day task visible in open tasks but not Today', () => {
    expect(filterTasks(tasks, 'today', '', TODAY).map(({ title }) => title)).toEqual([
      '今天待办',
      '今天完成',
    ]);
    expect(filterTasks(tasks, 'open', '', TODAY).map(({ title }) => title)).toEqual([
      '今天待办',
      '无日期进行中',
      '昨天遗留',
    ]);
    expect(filterTasks(tasks, 'completed', '完成', TODAY).map(({ title }) => title)).toEqual([
      '今天完成',
    ]);
  });

  it('uses the local calendar date instead of slicing a UTC timestamp', () => {
    const lateLocalTime = new Date(2026, 6, 22, 23, 59, 59, 500);
    expect(toLocalDateKey(lateLocalTime)).toBe(TODAY);
    expect(millisecondsUntilNextLocalDay(lateLocalTime)).toBe(550);
    expect(
      isTaskSnapshotDateCurrent(
        {
          workspaceId: WORKSPACE_A,
          todayDate: TODAY,
          planningDays: PLANNING_DAYS,
          tasks: [],
        },
        lateLocalTime,
      ),
    ).toBe(true);
    expect(
      isTaskSnapshotDateCurrent(
        {
          workspaceId: WORKSPACE_A,
          todayDate: '2026-07-21',
          planningDays: createRollingPlanningDays('2026-07-21'),
          tasks: [],
        },
        lateLocalTime,
      ),
    ).toBe(false);
  });
});

function task(id: string, title: string, status: Task['status'], plannedFor: string | null): Task {
  return {
    id,
    title,
    status,
    plannedFor,
    sourceInboxEntryId: null,
    createdAt: '2026-07-22T12:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
    completedAt: status === 'completed' ? '2026-07-22T12:00:00.000Z' : null,
  };
}
