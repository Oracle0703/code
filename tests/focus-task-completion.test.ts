import { describe, expect, it, vi } from 'vitest';
import type { FocusSnapshot, TaskSnapshot } from '../src/shared/contracts';
import {
  FocusTaskCompletionCoordinator,
  FocusTaskCompletionGate,
  FocusTaskCompletionSupersededError,
  FocusTaskCompletionUnavailableError,
  focusTaskCompletionFailed,
  focusTaskCompletionFinished,
  focusTaskCompletionStarted,
  resolveFocusTaskCompletionTarget,
  selectFocusTaskCompletionNotice,
  type FocusTaskCompletionNotice,
  type FocusTaskSnapshotRefresh,
} from '../src/renderer/focus-task-completion';
import {
  createFocusWorkspaceIdentity,
  type FocusWorkspaceIdentity,
} from '../src/renderer/focus-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const TODAY = '2026-07-25';
const ENDED_AT = '2026-07-25T13:00:00.000Z';

describe('focus task completion', () => {
  it('selects only an idle, completed, linked latest terminal from the active workspace', () => {
    const workspace = createFocusWorkspaceIdentity(WORKSPACE_A);
    const selected = selectFocusTaskCompletionNotice(workspace, focusSnapshot(), new Set());

    expect(selected).toMatchObject({
      workspace,
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      taskTitle: '核对发布说明',
      endedAt: ENDED_AT,
    });
    expect(
      selectFocusTaskCompletionNotice(
        workspace,
        focusSnapshot({
          session: {
            id: '55555555-5555-4555-8555-555555555555',
            workspaceId: WORKSPACE_A,
            workspaceName: '产品',
            taskId: null,
            taskTitle: null,
            status: 'running',
            remainingSeconds: 900,
            deadlineAt: '2026-07-25T13:15:00.000Z',
            revision: 1,
            createdAt: '2026-07-25T12:50:00.000Z',
            updatedAt: '2026-07-25T12:50:00.000Z',
          },
        }),
        new Set(),
      ),
    ).toBeNull();
    expect(
      selectFocusTaskCompletionNotice(
        workspace,
        focusSnapshot({
          latestTerminal: {
            ...focusSnapshot().latestTerminal!,
            status: 'cancelled',
          },
        }),
        new Set(),
      ),
    ).toBeNull();
    expect(
      selectFocusTaskCompletionNotice(
        workspace,
        focusSnapshot({
          latestTerminal: {
            ...focusSnapshot().latestTerminal!,
            taskId: null,
            taskTitle: null,
          },
        }),
        new Set(),
      ),
    ).toBeNull();
    expect(
      selectFocusTaskCompletionNotice(
        createFocusWorkspaceIdentity(WORKSPACE_B),
        focusSnapshot(),
        new Set(),
      ),
    ).toBeNull();
  });

  it('keeps a dismissed terminal hidden without hiding a newer completion', () => {
    const workspace = createFocusWorkspaceIdentity(WORKSPACE_A);
    const first = selectFocusTaskCompletionNotice(workspace, focusSnapshot(), new Set())!;
    expect(selectFocusTaskCompletionNotice(workspace, focusSnapshot(), new Set([first.key]))).toBe(
      null,
    );

    const newer = selectFocusTaskCompletionNotice(
      workspace,
      focusSnapshot({
        latestTerminal: {
          ...focusSnapshot().latestTerminal!,
          sessionId: '66666666-6666-4666-8666-666666666666',
          endedAt: '2026-07-25T14:00:00.000Z',
        },
      }),
      new Set([first.key]),
    );
    expect(newer?.sessionId).toBe('66666666-6666-4666-8666-666666666666');
  });

  it('resolves and commits only the exact task before reporting its current status', async () => {
    const workspace = createFocusWorkspaceIdentity(WORKSPACE_A);
    const notice = selectFocusTaskCompletionNotice(workspace, focusSnapshot(), new Set())!;
    const coordinator = new FocusTaskCompletionCoordinator();
    const intent = coordinator.begin(workspace, notice);
    const commit = vi.fn(() => true);
    const assertCurrent = () => coordinator.assertCurrent(intent, workspace, 'today', notice);

    await expect(
      resolveFocusTaskCompletionTarget(
        intent,
        async () => refresh(taskSnapshot(), commit),
        assertCurrent,
      ),
    ).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      todayDate: TODAY,
      task: { id: TASK_ID, title: '核对发布说明' },
      alreadyCompleted: false,
    });
    expect(commit).toHaveBeenCalledOnce();

    await expect(
      resolveFocusTaskCompletionTarget(
        intent,
        async () =>
          refresh({
            ...taskSnapshot(),
            tasks: [{ ...taskSnapshot().tasks[0]!, status: 'completed', completedAt: ENDED_AT }],
          }),
        assertCurrent,
      ),
    ).resolves.toMatchObject({ alreadyCompleted: true });
  });

  it('never falls back to another task when the linked task is unavailable', async () => {
    const workspace = createFocusWorkspaceIdentity(WORKSPACE_A);
    const notice = selectFocusTaskCompletionNotice(workspace, focusSnapshot(), new Set())!;
    const coordinator = new FocusTaskCompletionCoordinator();
    const intent = coordinator.begin(workspace, notice);
    const commit = vi.fn(() => true);

    await expect(
      resolveFocusTaskCompletionTarget(
        intent,
        async () =>
          refresh(
            {
              ...taskSnapshot(),
              tasks: [
                {
                  ...taskSnapshot().tasks[0]!,
                  id: '77777777-7777-4777-8777-777777777777',
                  title: '其他任务',
                },
              ],
            },
            commit,
          ),
        () => coordinator.assertCurrent(intent, workspace, 'today', notice),
      ),
    ).rejects.toBeInstanceOf(FocusTaskCompletionUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects stale dates, an A to B to A cycle, and superseded snapshot commits', async () => {
    const firstA = createFocusWorkspaceIdentity(WORKSPACE_A);
    const notice = selectFocusTaskCompletionNotice(firstA, focusSnapshot(), new Set())!;
    const coordinator = new FocusTaskCompletionCoordinator();
    const intent = coordinator.begin(firstA, notice);
    let currentWorkspace: FocusWorkspaceIdentity = firstA;
    let currentNotice: FocusTaskCompletionNotice | null = notice;
    let release!: (value: FocusTaskSnapshotRefresh) => void;
    const delayed = new Promise<FocusTaskSnapshotRefresh>((resolve) => {
      release = resolve;
    });
    const resolution = resolveFocusTaskCompletionTarget(
      intent,
      () => delayed,
      () => coordinator.assertCurrent(intent, currentWorkspace, 'today', currentNotice),
    );

    currentWorkspace = createFocusWorkspaceIdentity(WORKSPACE_B);
    currentWorkspace = createFocusWorkspaceIdentity(WORKSPACE_A);
    release(
      refresh(
        taskSnapshot(),
        vi.fn(() => true),
      ),
    );
    await expect(resolution).rejects.toBeInstanceOf(FocusTaskCompletionSupersededError);

    const freshCoordinator = new FocusTaskCompletionCoordinator();
    const freshIntent = freshCoordinator.begin(firstA, notice);
    await expect(
      resolveFocusTaskCompletionTarget(
        freshIntent,
        async () => refresh({ ...taskSnapshot(), todayDate: '2026-07-26' }),
        () => freshCoordinator.assertCurrent(freshIntent, firstA, 'today', notice),
      ),
    ).rejects.toBeInstanceOf(FocusTaskCompletionUnavailableError);

    await expect(
      resolveFocusTaskCompletionTarget(
        freshIntent,
        async () => refresh(taskSnapshot(), () => false),
        () => freshCoordinator.assertCurrent(freshIntent, firstA, 'today', notice),
      ),
    ).rejects.toBeInstanceOf(FocusTaskCompletionSupersededError);

    currentNotice = null;
  });

  it('invalidates an older intent when a newer terminal replaces it', () => {
    const workspace = createFocusWorkspaceIdentity(WORKSPACE_A);
    const first = selectFocusTaskCompletionNotice(workspace, focusSnapshot(), new Set())!;
    const second = selectFocusTaskCompletionNotice(
      workspace,
      focusSnapshot({
        latestTerminal: {
          ...focusSnapshot().latestTerminal!,
          sessionId: '88888888-8888-4888-8888-888888888888',
          endedAt: '2026-07-25T15:00:00.000Z',
        },
      }),
      new Set(),
    )!;
    const coordinator = new FocusTaskCompletionCoordinator();
    const firstIntent = coordinator.begin(workspace, first);
    expect(coordinator.isCurrent(firstIntent, workspace, 'today', first)).toBe(true);
    coordinator.begin(workspace, second);
    expect(coordinator.isCurrent(firstIntent, workspace, 'today', second)).toBe(false);
  });

  it('allows one in-flight action per completion and ignores late state writes', () => {
    const gate = new FocusTaskCompletionGate();
    expect(gate.begin('first')).toBe(true);
    expect(gate.begin('first')).toBe(false);
    expect(gate.begin('second')).toBe(true);
    expect(gate.begin('first')).toBe(false);
    gate.end('first');
    expect(gate.begin('second')).toBe(false);
    expect(gate.begin('first')).toBe(true);
    gate.end('first');
    gate.end('second');
    expect(gate.begin('second')).toBe(true);

    const first = focusTaskCompletionStarted('first');
    const second = focusTaskCompletionStarted('second');
    expect(focusTaskCompletionFailed(first, 'first', '更新失败')).toEqual({
      completionKey: 'first',
      pending: false,
      error: '更新失败',
    });
    expect(focusTaskCompletionFailed(second, 'first', '旧失败')).toBe(second);
    expect(focusTaskCompletionFinished(second, 'first')).toBe(second);
    expect(focusTaskCompletionFinished(second, 'second')).toEqual({
      completionKey: 'second',
      pending: false,
      error: null,
    });
  });
});

function focusSnapshot(overrides: Partial<FocusSnapshot> = {}): FocusSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    observedAt: ENDED_AT,
    session: null,
    latestTerminal: {
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_A,
      taskId: TASK_ID,
      taskTitle: '核对发布说明',
      status: 'completed',
      endedAt: ENDED_AT,
    },
    todayCompletedCount: 1,
    ...overrides,
  };
}

function taskSnapshot(): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: TODAY,
    planningDays: [{ token: 'day-0', date: TODAY }],
    tasks: [
      {
        id: TASK_ID,
        title: '核对发布说明',
        status: 'todo',
        plannedFor: TODAY,
        sourceInboxEntryId: null,
        createdAt: '2026-07-25T12:00:00.000Z',
        updatedAt: '2026-07-25T12:00:00.000Z',
        completedAt: null,
      },
    ],
  };
}

function refresh(
  snapshot: TaskSnapshot,
  commit: () => boolean = () => true,
): FocusTaskSnapshotRefresh {
  return { snapshot, commit };
}
