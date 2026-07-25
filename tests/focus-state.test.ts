import { describe, expect, it } from 'vitest';
import type { FocusSession, FocusSnapshot, Task, TaskSnapshot } from '../src/shared/contracts';
import { createRollingPlanningDays } from '../src/shared/planning-domain';
import {
  FOCUS_DURATION_SECONDS,
  createFocusRequestIdentity,
  createFocusWorkspaceIdentity,
  describeFocusTimer,
  focusRemainingSeconds,
  focusStartUnavailableReason,
  focusStableClockNow,
  formatFocusTimer,
  isFocusDialogActivationCurrent,
  isTaskEligibleForFocus,
  resolveFocusTaskSelection,
  shouldApplyFocusSnapshot,
  taskFocusStartUnavailableReason,
} from '../src/renderer/focus-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TODAY = '2026-07-23';
const OBSERVED_AT = '2026-07-23T12:00:00.000Z';

describe('focus renderer state', () => {
  it('uses activation identities so an old A request cannot reappear after A to B to A', () => {
    const firstA = createFocusWorkspaceIdentity(WORKSPACE_A);
    const oldRequest = createFocusRequestIdentity(firstA, 1);
    expect(oldRequest).not.toBeNull();

    const identityB = createFocusWorkspaceIdentity(WORKSPACE_B);
    const currentA = createFocusWorkspaceIdentity(WORKSPACE_A);
    const currentRequest = createFocusRequestIdentity(currentA, 2);

    expect(identityB.workspaceId).toBe(WORKSPACE_B);
    expect(currentA).not.toBe(firstA);
    expect(isFocusDialogActivationCurrent(firstA, currentA, WORKSPACE_A)).toBe(false);
    expect(isFocusDialogActivationCurrent(currentA, currentA, WORKSPACE_A)).toBe(true);
    expect(
      shouldApplyFocusSnapshot(currentA, -1, oldRequest!, snapshot(), new Date(2026, 6, 23, 12)),
    ).toBe(false);
    expect(
      shouldApplyFocusSnapshot(
        currentA,
        -1,
        currentRequest!,
        snapshot(),
        new Date(2026, 6, 23, 12),
      ),
    ).toBe(true);
  });

  it('rejects stale sequences, another workspace, and a snapshot from a previous local day', () => {
    const identity = createFocusWorkspaceIdentity(WORKSPACE_A);
    const request = createFocusRequestIdentity(identity, 7)!;

    expect(
      shouldApplyFocusSnapshot(identity, 8, request, snapshot(), new Date(2026, 6, 23, 12)),
    ).toBe(false);
    expect(
      shouldApplyFocusSnapshot(
        identity,
        -1,
        request,
        snapshot({ workspaceId: WORKSPACE_B }),
        new Date(2026, 6, 23, 12),
      ),
    ).toBe(false);
    expect(
      shouldApplyFocusSnapshot(identity, -1, request, snapshot(), new Date(2026, 6, 24, 0, 1)),
    ).toBe(false);
  });

  it('derives a running countdown from Main observation and deadline without increasing it', () => {
    const running = snapshot({
      session: session({
        status: 'running',
        remainingSeconds: 1_200,
        deadlineAt: '2026-07-23T12:20:00.000Z',
      }),
    });

    expect(focusRemainingSeconds(running, Date.parse('2026-07-23T11:59:50.000Z'))).toBe(1_200);
    expect(focusRemainingSeconds(running, Date.parse('2026-07-23T12:00:00.100Z'))).toBe(1_200);
    expect(focusRemainingSeconds(running, Date.parse('2026-07-23T12:00:01.001Z'))).toBe(1_199);
    expect(focusRemainingSeconds(running, Date.parse('2026-07-23T12:20:01.000Z'))).toBe(0);
  });

  it('keeps the renderer clock monotonic across a wall-clock rollback and a fresh snapshot', () => {
    const stableNow = focusStableClockNow(
      Date.parse('2026-07-23T12:00:00.000Z'),
      5 * 60_000,
      Date.parse('2026-07-23T11:55:00.000Z'),
    );
    const beforeRollback = snapshot({
      session: session({
        remainingSeconds: 1_200,
        deadlineAt: '2026-07-23T12:20:00.000Z',
      }),
    });
    const afterRollback = snapshot({
      observedAt: '2026-07-23T11:55:00.000Z',
      session: session({
        remainingSeconds: 900,
        deadlineAt: '2026-07-23T12:20:00.000Z',
        revision: 2,
      }),
    });

    expect(focusRemainingSeconds(beforeRollback, stableNow)).toBe(900);
    expect(focusRemainingSeconds(afterRollback, stableNow + 1_001)).toBe(899);
    expect(focusStableClockNow(Number.NaN, 0, 42)).toBe(42);
  });

  it('keeps a paused value fixed and formats a bounded accessible duration', () => {
    const paused = snapshot({
      session: session({
        status: 'paused',
        remainingSeconds: 65,
        deadlineAt: null,
      }),
    });

    expect(focusRemainingSeconds(paused, Date.parse('2030-01-01T00:00:00.000Z'))).toBe(65);
    expect(focusRemainingSeconds(snapshot({ session: null }))).toBe(FOCUS_DURATION_SECONDS);
    expect(formatFocusTimer(65)).toBe('01:05');
    expect(formatFocusTimer(99_999)).toBe('25:00');
    expect(describeFocusTimer(65)).toBe('剩余 1 分 5 秒');
    expect(describeFocusTimer(60)).toBe('剩余 1 分钟');
  });

  it('opens task focus only for an aligned current-day unfinished task window', () => {
    const taskSnapshot = tasksSnapshot();
    const todayTask = taskSnapshot.tasks[0]!;
    const futureTask = taskSnapshot.tasks[1]!;
    const completedTask = taskSnapshot.tasks[2]!;

    expect(isTaskEligibleForFocus(todayTask, taskSnapshot)).toBe(true);
    expect(isTaskEligibleForFocus(futureTask, taskSnapshot)).toBe(false);
    expect(isTaskEligibleForFocus(completedTask, taskSnapshot)).toBe(false);
    expect(
      taskFocusStartUnavailableReason(
        WORKSPACE_A,
        taskSnapshot,
        snapshot(),
        'ready',
        'ready',
        null,
      ),
    ).toBeNull();
    expect(
      taskFocusStartUnavailableReason(
        WORKSPACE_A,
        { ...taskSnapshot, todayDate: '2026-07-24' },
        snapshot(),
        'ready',
        'ready',
        null,
      ),
    ).toMatch(/日期窗口/u);
    expect(
      taskFocusStartUnavailableReason(
        WORKSPACE_A,
        taskSnapshot,
        snapshot(),
        'loading',
        'ready',
        null,
      ),
    ).toMatch(/同步任务/u);
  });

  it('blocks another local or foreign focus session with an explicit reason', () => {
    expect(
      focusStartUnavailableReason(
        WORKSPACE_A,
        snapshot({ session: session({ status: 'paused', deadlineAt: null }) }),
        'ready',
        null,
      ),
    ).toMatch(/暂停/u);
    expect(
      focusStartUnavailableReason(
        WORKSPACE_A,
        snapshot({
          session: session({
            workspaceId: WORKSPACE_B,
            workspaceName: '研发',
          }),
        }),
        'ready',
        null,
      ),
    ).toContain('研发');
    expect(focusStartUnavailableReason(WORKSPACE_A, snapshot(), 'ready', 'start')).toMatch(
      /正在进行/u,
    );
  });

  it('keeps an invalid selected task distinct from an explicit free-focus choice', () => {
    const selectedTask = tasksSnapshot().tasks[0]!;

    expect(resolveFocusTaskSelection([selectedTask], selectedTask.id)).toEqual({
      task: selectedTask,
      taskId: selectedTask.id,
      invalid: false,
    });
    expect(resolveFocusTaskSelection([], selectedTask.id)).toEqual({
      task: null,
      taskId: undefined,
      invalid: true,
    });
    expect(resolveFocusTaskSelection([], '')).toEqual({
      task: null,
      taskId: undefined,
      invalid: false,
    });
  });
});

function snapshot(overrides: Partial<FocusSnapshot> = {}): FocusSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    observedAt: OBSERVED_AT,
    session: null,
    todayCompletedCount: 0,
    ...overrides,
  };
}

function session(overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_A,
    workspaceName: '产品',
    taskId: null,
    taskTitle: null,
    status: 'running',
    remainingSeconds: FOCUS_DURATION_SECONDS,
    deadlineAt: '2026-07-23T12:25:00.000Z',
    revision: 1,
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
    ...overrides,
  };
}

function tasksSnapshot(): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    planningDays: createRollingPlanningDays(TODAY),
    tasks: [
      task('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '今天待办', 'todo', TODAY),
      task('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '明天待办', 'todo', '2026-07-24'),
      task('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '今天完成', 'completed', TODAY),
    ],
  };
}

function task(id: string, title: string, status: Task['status'], plannedFor: string | null): Task {
  return {
    id,
    title,
    status,
    plannedFor,
    sourceInboxEntryId: null,
    createdAt: OBSERVED_AT,
    updatedAt: OBSERVED_AT,
    completedAt: status === 'completed' ? OBSERVED_AT : null,
  };
}
