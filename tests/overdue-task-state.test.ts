import { describe, expect, it } from 'vitest';
import type { Task, TaskSnapshot } from '../src/shared/contracts';
import {
  nextOverdueTaskId,
  overdueTaskReviewIdentity,
  OverdueTaskActionGate,
  selectOverdueTasks,
} from '../src/renderer/overdue-task-state';
import { createRollingPlanningDays } from '../src/shared/planning-domain';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TODAY = '2026-07-25';

describe('overdue task review state', () => {
  it('selects only unfinished tasks with an earlier signed planning date', () => {
    const snapshot = taskSnapshot([
      task('overdue todo', '2026-07-23', 'todo'),
      task('overdue active', '2026-07-24', 'in_progress'),
      task('overdue complete', '2026-07-22', 'completed'),
      task('unplanned', null, 'todo'),
      task('today', TODAY, 'todo'),
      task('future', '2026-07-26', 'todo'),
    ]);

    expect(selectOverdueTasks(snapshot).map(({ title }) => title)).toEqual([
      'overdue todo',
      'overdue active',
    ]);
  });

  it('orders oldest planning date first with stable creation and ID tie-breakers', () => {
    const tasks = [
      task('newer date', '2026-07-24', 'todo', '2026-07-20T08:00:00.000Z', 'id-d'),
      task('later created', '2026-07-23', 'todo', '2026-07-22T08:00:00.000Z', 'id-c'),
      task('higher ID', '2026-07-23', 'todo', '2026-07-21T08:00:00.000Z', 'id-b'),
      task('lower ID', '2026-07-23', 'todo', '2026-07-21T08:00:00.000Z', 'id-a'),
    ];

    expect(selectOverdueTasks(taskSnapshot(tasks)).map(({ title }) => title)).toEqual([
      'lower ID',
      'higher ID',
      'later created',
      'newer date',
    ]);
    expect(tasks.map(({ title }) => title)).toEqual([
      'newer date',
      'later created',
      'higher ID',
      'lower ID',
    ]);
  });

  it('binds review state to the workspace and signed local day', () => {
    const snapshot = taskSnapshot([]);

    expect(overdueTaskReviewIdentity(snapshot)).toBe(JSON.stringify([WORKSPACE_ID, TODAY]));
    expect(
      overdueTaskReviewIdentity({
        ...snapshot,
        todayDate: '2026-07-26',
      }),
    ).not.toBe(overdueTaskReviewIdentity(snapshot));
    expect(overdueTaskReviewIdentity(null)).toBeNull();
  });

  it('moves focus to the next row, then the previous row, without list fallback', () => {
    const tasks = [
      task('first', '2026-07-22', 'todo', undefined, 'id-a'),
      task('second', '2026-07-23', 'todo', undefined, 'id-b'),
      task('third', '2026-07-24', 'todo', undefined, 'id-c'),
    ];

    expect(nextOverdueTaskId(tasks, 'id-a')).toBe('id-b');
    expect(nextOverdueTaskId(tasks, 'id-b')).toBe('id-c');
    expect(nextOverdueTaskId(tasks, 'id-c')).toBe('id-b');
    expect(nextOverdueTaskId(tasks, 'missing')).toBeNull();
  });

  it('allows only one in-flight action for an exact task ID', () => {
    const gate = new OverdueTaskActionGate();

    expect(gate.begin('id-a')).toBe(true);
    expect(gate.begin('id-a')).toBe(false);
    expect(gate.begin('id-b')).toBe(true);
    gate.end('id-a');
    expect(gate.begin('id-a')).toBe(true);
  });
});

function taskSnapshot(tasks: readonly Task[]): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_ID,
    todayDate: TODAY,
    planningDays: createRollingPlanningDays(TODAY),
    tasks,
  };
}

function task(
  title: string,
  plannedFor: string | null,
  status: Task['status'],
  createdAt = '2026-07-21T08:00:00.000Z',
  id = `${title.replaceAll(' ', '-')}-id`,
): Task {
  return {
    id,
    title,
    status,
    plannedFor,
    sourceInboxEntryId: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: status === 'completed' ? createdAt : null,
  };
}
