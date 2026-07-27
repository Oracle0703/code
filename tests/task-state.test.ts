import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import {
  countTasks,
  createdTaskFromResult,
  convertedTaskFromResult,
  convertedTaskFromSnapshot,
  createTaskRequestIdentity,
  createTaskWorkspaceIdentity,
  filterTasks,
  isTaskRequestLatest,
  isTaskRequestCurrent,
  isTaskSequenceCurrent,
  isTaskSnapshotDateCurrent,
  isTaskWorkspaceCurrent,
  millisecondsUntilNextLocalDay,
  reconcileTaskCreateResult,
  shouldApplyTaskSnapshot,
  taskSnapshotForActivation,
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
  it('resolves only the exact task identity returned by manual creation', () => {
    const created = task('ffffffff-ffff-4fff-8fff-ffffffffffff', '重复标题', 'todo', TODAY);
    const duplicate = task('99999999-9999-4999-8999-999999999999', '重复标题', 'todo', TODAY);
    const result = {
      taskSnapshot: snapshot({ tasks: [duplicate, created] }),
      createdTaskId: created.id,
    };

    expect(createdTaskFromResult(WORKSPACE_A, result)).toBe(created);
    expect(
      createdTaskFromResult(WORKSPACE_A, {
        ...result,
        createdTaskId: '88888888-8888-4888-8888-888888888888',
      }),
    ).toBeNull();
    expect(createdTaskFromResult(WORKSPACE_B, result)).toBeNull();
  });

  it('commits the task:create transaction snapshot without an extra read', async () => {
    const created = task('ffffffff-ffff-4fff-8fff-ffffffffffff', '已创建任务', 'todo', TODAY);
    const commitResultSnapshot = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileTaskCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: {
          taskSnapshot: snapshot({ tasks: [created] }),
          createdTaskId: created.id,
        },
        commitResultSnapshot,
        getCommittedTask: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdTask: created,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('recovers on the second authoritative read after the first read fails', async () => {
    const created = task('ffffffff-ffff-4fff-8fff-ffffffffffff', '已创建任务', 'todo', TODAY);
    const firstFailure = new Error('internal database path must not become UI text');
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce({
        snapshot: snapshot({ tasks: [created] }),
        commit: () => true,
      });

    const reconciled = await reconcileTaskCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: {
        taskSnapshot: snapshot({ tasks: [created] }),
        createdTaskId: created.id,
      },
      commitResultSnapshot: () => false,
      getCommittedTask: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdTask).toBe(created);
    expect(reconciled.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('recovers on the second authoritative read after the first omits the exact id', async () => {
    const created = task('ffffffff-ffff-4fff-8fff-ffffffffffff', '重复标题', 'todo', TODAY);
    const wrong = task('99999999-9999-4999-8999-999999999999', '重复标题', 'todo', TODAY);
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: snapshot({ tasks: [wrong] }),
        commit: () => true,
      })
      .mockResolvedValueOnce({
        snapshot: snapshot({ tasks: [wrong, created] }),
        commit: () => true,
      });

    const reconciled = await reconcileTaskCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: {
        taskSnapshot: snapshot({ tasks: [created] }),
        createdTaskId: created.id,
      },
      commitResultSnapshot: () => false,
      getCommittedTask: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdTask).toBe(created);
    expect(reconciled.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('fails closed after two reads and accepts a newer committed snapshot in the final check', async () => {
    const created = task('ffffffff-ffff-4fff-8fff-ffffffffffff', '已创建任务', 'todo', TODAY);
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot({ tasks: [created] }),
      commit: () => false,
    }));
    let committedSnapshotChecks = 0;

    const reconciled = await reconcileTaskCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: {
        taskSnapshot: snapshot({ tasks: [created] }),
        createdTaskId: created.id,
      },
      commitResultSnapshot: () => false,
      getCommittedTask: () => {
        committedSnapshotChecks += 1;
        return committedSnapshotChecks === 3 ? created : null;
      },
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdTask).toBe(created);
    expect(reconciled.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(committedSnapshotChecks).toBe(3);
  });

  it('returns a bounded post-commit failure after both authoritative reads miss the exact id', async () => {
    const created = task('ffffffff-ffff-4fff-8fff-ffffffffffff', '重复标题', 'todo', TODAY);
    const wrong = task('99999999-9999-4999-8999-999999999999', '重复标题', 'todo', TODAY);
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot({ tasks: [wrong] }),
      commit: () => true,
    }));

    const reconciled = await reconcileTaskCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: {
        taskSnapshot: snapshot({ tasks: [created] }),
        createdTaskId: created.id,
      },
      commitResultSnapshot: () => false,
      getCommittedTask: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdTask).toBe(created);
    expect(reconciled.committed).toBe(false);
    expect(reconciled.error).toBeInstanceOf(Error);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('resolves only the exact task identity returned by an inbox conversion', () => {
    const sourceEntryId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const converted = {
      ...task('ffffffff-ffff-4fff-8fff-ffffffffffff', '转换任务', 'todo', TODAY),
      sourceInboxEntryId: sourceEntryId,
    };
    const other = task('99999999-9999-4999-8999-999999999999', '其他任务', 'todo', TODAY);
    const taskSnapshot = snapshot({ tasks: [other, converted] });
    const result = {
      taskSnapshot,
      inboxSnapshot: { workspaceId: WORKSPACE_A, entries: [] },
      createdTaskId: converted.id,
    };

    expect(convertedTaskFromResult(WORKSPACE_A, sourceEntryId, result)).toBe(converted);
    expect(
      convertedTaskFromSnapshot(WORKSPACE_A, sourceEntryId, converted.id, result.taskSnapshot),
    ).toBe(converted);
    expect(
      convertedTaskFromResult(WORKSPACE_A, sourceEntryId, {
        ...result,
        createdTaskId: other.id,
      }),
    ).toBeNull();
    expect(convertedTaskFromResult(WORKSPACE_B, sourceEntryId, result)).toBeNull();
    expect(
      convertedTaskFromSnapshot(
        WORKSPACE_A,
        sourceEntryId,
        converted.id,
        snapshot({ tasks: [converted, { ...converted }] }),
      ),
    ).toBeNull();
    expect(
      convertedTaskFromSnapshot(
        WORKSPACE_A,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        converted.id,
        taskSnapshot,
      ),
    ).toBeNull();
    expect(
      convertedTaskFromResult(WORKSPACE_A, sourceEntryId, {
        ...result,
        taskSnapshot: snapshot({ tasks: [converted, { ...converted }] }),
      }),
    ).toBeNull();
  });

  it('uses activation identity to reject an old A request after A to B to A', () => {
    const firstA = createTaskWorkspaceIdentity(WORKSPACE_A);
    const oldRequest = createTaskRequestIdentity(firstA, 1);
    expect(oldRequest).not.toBeNull();
    if (!oldRequest) return;

    const identityB = createTaskWorkspaceIdentity(WORKSPACE_B);
    const currentA = createTaskWorkspaceIdentity(WORKSPACE_A);
    const currentRequest = createTaskRequestIdentity(currentA, 2);
    expect(currentRequest).not.toBeNull();
    if (!currentRequest) return;

    expect(identityB.workspaceId).toBe(WORKSPACE_B);
    expect(currentA).not.toBe(firstA);
    expect(isTaskRequestCurrent(currentA, oldRequest)).toBe(false);
    expect(isTaskRequestCurrent(currentA, currentRequest)).toBe(true);
    expect(
      shouldApplyTaskSnapshot(currentA, -1, oldRequest, snapshot(), new Date(2026, 6, 22, 12)),
    ).toBe(false);
    expect(
      shouldApplyTaskSnapshot(currentA, -1, currentRequest, snapshot(), new Date(2026, 6, 22, 12)),
    ).toBe(true);
  });

  it('binds a stored snapshot to one activation and keeps request validation exact', () => {
    const firstA = createTaskWorkspaceIdentity(WORKSPACE_A);
    const currentA = createTaskWorkspaceIdentity(WORKSPACE_A);
    const request = createTaskRequestIdentity(currentA, 7)!;
    const stored = { activation: firstA, snapshot: snapshot() };
    const now = new Date(2026, 6, 22, 12);

    expect(taskSnapshotForActivation(firstA, stored, now)).toBe(stored.snapshot);
    expect(taskSnapshotForActivation(currentA, stored, now)).toBeNull();
    expect(shouldApplyTaskSnapshot(currentA, 7, request, snapshot(), now)).toBe(false);
    expect(
      shouldApplyTaskSnapshot(currentA, -1, request, snapshot({ workspaceId: WORKSPACE_B }), now),
    ).toBe(false);
    expect(
      shouldApplyTaskSnapshot(
        currentA,
        -1,
        request,
        snapshot({
          todayDate: '2026-07-21',
          planningDays: createRollingPlanningDays('2026-07-21'),
        }),
        now,
      ),
    ).toBe(false);
    expect(createTaskRequestIdentity(createTaskWorkspaceIdentity(null), 8)).toBeNull();
    expect(createTaskRequestIdentity(currentA, -1)).toBeNull();
  });

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

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    planningDays: PLANNING_DAYS,
    tasks: [],
    ...overrides,
  };
}
