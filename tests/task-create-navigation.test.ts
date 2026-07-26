import { describe, expect, it, vi } from 'vitest';
import type { Task, TaskSnapshot } from '../src/shared/contracts';
import {
  createTaskCreateWorkspaceIdentity,
  resolveTaskCreateNavigationTarget,
  sameTaskCreateFeedback,
  taskCreateFeedbackKey,
  taskCreateNavigationError,
  taskCreateOpenFailed,
  taskCreateOpenFinished,
  taskCreateOpenStarted,
  taskCreateTitleSummary,
  TaskCreateCoordinator,
  TaskCreateInProgressError,
  TaskCreateNoteDraftPreservedError,
  TaskCreateOpenGate,
  TaskCreateSupersededError,
  TaskCreateUnavailableError,
  type TaskCreateFeedback,
  type TaskCreateSnapshotRefresh,
  type TaskCreateWorkspaceIdentity,
} from '../src/renderer/task-create-navigation';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TASK_A = '33333333-3333-4333-8333-333333333333';
const TASK_B = '44444444-4444-4444-8444-444444444444';

describe('manual task create navigation', () => {
  it('normalizes and bounds task title summaries by Unicode code point', () => {
    expect(taskCreateTitleSummary('  整理\n\t发布   清单  ')).toBe('整理 发布 清单');
    expect(taskCreateTitleSummary(`${'任'.repeat(95)}😀`)).toBe(`${'任'.repeat(95)}😀`);
    expect(taskCreateTitleSummary(`${'任'.repeat(95)}😀尾`)).toBe(`${'任'.repeat(95)}…`);
  });

  it('creates a distinct frozen identity for every workspace activation', () => {
    const firstA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);

    expect(firstA).toEqual(secondA);
    expect(firstA).not.toBe(secondA);
    expect(Object.isFrozen(firstA)).toBe(true);
    expect(createTaskCreateWorkspaceIdentity(null)).toEqual({ workspaceId: null });
  });

  it('publishes only the latest committed create with a complete frozen feedback identity', () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    expect(() => coordinator.beginCreate(createTaskCreateWorkspaceIdentity(null))).toThrow(
      TaskCreateSupersededError,
    );

    const older = coordinator.beginCreate(workspace);
    expect(() => coordinator.beginCreate(workspace)).toThrow(TaskCreateInProgressError);
    coordinator.endCreate(older);
    const newer = coordinator.beginCreate(workspace);
    expect(coordinator.isCreateCurrent(older, workspace)).toBe(false);
    expect(() => coordinator.createFeedback(older, workspace, task(), true)).toThrow(
      TaskCreateSupersededError,
    );

    const current = coordinator.createFeedback(newer, workspace, task(), true);
    expect(current).toEqual({
      requestGeneration: newer.generation,
      workspaceId: WORKSPACE_A,
      createdTaskId: TASK_A,
      title: '整理发布清单',
      plannedFor: '2026-07-25',
    });
    expect(Object.isFrozen(current)).toBe(true);
    expect(taskCreateFeedbackKey(current)).toBe(
      JSON.stringify([newer.generation, WORKSPACE_A, TASK_A, '整理发布清单', '2026-07-25']),
    );
    expect(() => coordinator.createFeedback(newer, workspace, task(), false)).toThrow(
      TaskCreateSupersededError,
    );
    coordinator.endCreate(newer);
  });

  it('keeps creation single-flight and ignores an old finally after replacement', () => {
    const firstA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const first = coordinator.beginCreate(firstA);

    expect(() => coordinator.beginCreate(firstA)).toThrow(TaskCreateInProgressError);
    coordinator.invalidate();
    const replacement = coordinator.beginCreate(secondA);
    coordinator.endCreate(first);
    expect(() => coordinator.beginCreate(secondA)).toThrow(TaskCreateInProgressError);
    coordinator.endCreate(replacement);
    expect(() => coordinator.beginCreate(secondA)).not.toThrow();
  });

  it('rejects delayed creation after invalidation or an A to B to A activation cycle', () => {
    const firstA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const intent = coordinator.beginCreate(firstA);

    expect(
      coordinator.isCreateCurrent(intent, createTaskCreateWorkspaceIdentity(WORKSPACE_B)),
    ).toBe(false);
    expect(coordinator.isCreateCurrent(intent, secondA)).toBe(false);
    expect(() => coordinator.createFeedback(intent, secondA, task(), true)).toThrow(
      TaskCreateSupersededError,
    );
    expect(coordinator.isCreateCurrent(intent, firstA)).toBe(true);

    coordinator.invalidate();
    expect(coordinator.isCreateCurrent(intent, firstA)).toBe(false);
    expect(() => coordinator.assertCreateCurrent(intent, firstA)).toThrow(
      TaskCreateSupersededError,
    );
  });

  it('binds opening to the exact activation and every feedback field', () => {
    const firstA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const secondA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);

    expect(coordinator.isOpenCurrent(intent, firstA, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, secondA, current)).toBe(false);
    for (const replacement of [
      { ...current, requestGeneration: current.requestGeneration + 1 },
      { ...current, workspaceId: WORKSPACE_B },
      { ...current, createdTaskId: TASK_B },
      { ...current, title: '较新的标题' },
      { ...current, plannedFor: null },
    ]) {
      expect(coordinator.isOpenCurrent(intent, firstA, replacement)).toBe(false);
    }
    expect(sameTaskCreateFeedback(current, { ...current })).toBe(true);
    expect(sameTaskCreateFeedback(current, null)).toBe(false);
    expect(() =>
      coordinator.beginOpen(createTaskCreateWorkspaceIdentity(WORKSPACE_B), current),
    ).toThrow(TaskCreateSupersededError);
  });

  it('makes a newer create supersede old feedback and an open already in flight', () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const original = publishedFeedback(coordinator, workspace);
    const openIntent = coordinator.beginOpen(workspace, original);
    const newerCreate = coordinator.beginCreate(workspace);

    expect(coordinator.isFeedbackCurrent(workspace, original, original)).toBe(false);
    expect(coordinator.isOpenCurrent(openIntent, workspace, original)).toBe(false);
    expect(() => coordinator.assertOpenCurrent(openIntent, workspace, original)).toThrow(
      TaskCreateSupersededError,
    );

    const newer = coordinator.createFeedback(
      newerCreate,
      workspace,
      task({ id: TASK_B, title: '较新的任务', plannedFor: null }),
      true,
    );
    expect(newer.requestGeneration).toBeGreaterThan(original.requestGeneration);
    expect(coordinator.isFeedbackCurrent(workspace, newer, newer)).toBe(true);
    coordinator.endCreate(newerCreate);
  });

  it('cancels only an in-flight open and keeps current feedback reusable', () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const originalOpen = coordinator.beginOpen(workspace, current);

    coordinator.cancelOpen();
    expect(coordinator.isOpenCurrent(originalOpen, workspace, current)).toBe(false);
    expect(coordinator.isFeedbackCurrent(workspace, current, current)).toBe(true);
    expect(() => coordinator.beginOpen(workspace, current)).not.toThrow();
  });

  it('dismisses only the complete current feedback and invalidates its open intent', () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);

    expect(coordinator.dismiss({ ...current, title: '其他任务' }, workspace, current)).toBe(false);
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(true);
    expect(coordinator.dismiss(current, workspace, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(false);
    expect(coordinator.dismiss(current, workspace, current)).toBe(false);
  });

  it('fresh-reads, commits, and returns only the exact created task id', async () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);
    const readTask = vi.fn(async () =>
      refresh(
        snapshot({
          tasks: [
            task({
              id: TASK_B,
              title: current.title,
              plannedFor: current.plannedFor,
            }),
            task({
              id: TASK_A,
              title: '创建后已重命名',
              status: 'in_progress',
              plannedFor: null,
              updatedAt: '2026-07-25T12:01:00.000Z',
            }),
          ],
        }),
        commit,
      ),
    );

    await expect(
      resolveTaskCreateNavigationTarget(intent, readTask, () =>
        coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      task: {
        id: TASK_A,
        title: '创建后已重命名',
        status: 'in_progress',
        plannedFor: null,
      },
    });
    expect(readTask).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('never falls back by title, planning, timestamp, or list position when the id is missing', async () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);

    await expect(
      resolveTaskCreateNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              tasks: [
                task({
                  id: TASK_B,
                  title: current.title,
                  plannedFor: current.plannedFor,
                  createdAt: '2026-07-25T12:00:00.000Z',
                  updatedAt: '2026-07-25T12:00:00.000Z',
                }),
              ],
            }),
            commit,
          ),
        () => coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).rejects.toBeInstanceOf(TaskCreateUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('treats duplicate ids, a wrong workspace, and commit=false as unavailable', async () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const assertCurrent = () => coordinator.assertOpenCurrent(intent, workspace, current);
    const duplicateCommit = vi.fn(() => true);
    const wrongWorkspaceCommit = vi.fn(() => true);

    await expect(
      resolveTaskCreateNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              tasks: [task(), task({ title: '重复 ID 的损坏记录' })],
            }),
            duplicateCommit,
          ),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(TaskCreateUnavailableError);
    expect(duplicateCommit).not.toHaveBeenCalled();

    await expect(
      resolveTaskCreateNavigationTarget(
        intent,
        async () => refresh(snapshot({ workspaceId: WORKSPACE_B }), wrongWorkspaceCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(TaskCreateUnavailableError);
    expect(wrongWorkspaceCommit).not.toHaveBeenCalled();

    await expect(
      resolveTaskCreateNavigationTarget(
        intent,
        async () => refresh(snapshot(), () => false),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(TaskCreateUnavailableError);
  });

  it('reports a cross-midnight snapshot rejected at commit as unavailable', async () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => false);

    await expect(
      resolveTaskCreateNavigationTarget(
        intent,
        async () => refresh(snapshot(), commit),
        () => coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).rejects.toBeInstanceOf(TaskCreateUnavailableError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('rejects a delayed read after A to B to A, dismiss, or a newer create', async () => {
    const firstA = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);
    let currentWorkspace: TaskCreateWorkspaceIdentity = firstA;
    let currentFeedback: TaskCreateFeedback | null = current;
    let release!: (value: TaskCreateSnapshotRefresh) => void;
    const delayed = new Promise<TaskCreateSnapshotRefresh>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(() => true);
    const resolution = resolveTaskCreateNavigationTarget(
      intent,
      () => delayed,
      () => coordinator.assertOpenCurrent(intent, currentWorkspace, currentFeedback),
    );

    currentWorkspace = createTaskCreateWorkspaceIdentity(WORKSPACE_B);
    currentWorkspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    currentFeedback = null;
    coordinator.beginCreate(currentWorkspace);
    release(refresh(snapshot(), commit));

    await expect(resolution).rejects.toBeInstanceOf(TaskCreateSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not return a target when state changes during the authoritative commit', async () => {
    const workspace = createTaskCreateWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new TaskCreateCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    let currentFeedback: TaskCreateFeedback | null = current;
    const commit = vi.fn(() => {
      currentFeedback = null;
      coordinator.invalidate();
      return true;
    });

    await expect(
      resolveTaskCreateNavigationTarget(
        intent,
        async () => refresh(snapshot(), commit),
        () => coordinator.assertOpenCurrent(intent, workspace, currentFeedback),
      ),
    ).rejects.toBeInstanceOf(TaskCreateSupersededError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('gates duplicate opens without letting a late end release a replacement lease', () => {
    const original = feedback();
    const equalReplacement = { ...original };
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      createdTaskId: TASK_B,
    });
    const gate = new TaskCreateOpenGate();

    expect(gate.begin(original)).toBe(true);
    expect(gate.begin(equalReplacement)).toBe(false);
    expect(gate.begin(newer)).toBe(true);
    gate.end(original);
    expect(gate.begin(equalReplacement)).toBe(true);
    gate.end(original);
    expect(gate.begin({ ...equalReplacement })).toBe(false);
    gate.end(equalReplacement);
    expect(gate.begin({ ...equalReplacement })).toBe(true);
  });

  it('ignores late failure and finally reducers after newer feedback replaces the state', () => {
    const original = feedback();
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      createdTaskId: TASK_B,
      title: '较新的任务',
      plannedFor: null,
    });
    const originalState = taskCreateOpenStarted(original);
    const newerState = taskCreateOpenStarted(newer);

    expect(taskCreateFeedbackKey(original)).not.toBe(taskCreateFeedbackKey(newer));
    expect(taskCreateOpenFailed(originalState, original, '打开失败', 'original-error')).toEqual({
      feedbackKey: taskCreateFeedbackKey(original),
      opening: false,
      error: '打开失败',
      errorFocusKey: 'original-error',
    });
    expect(taskCreateOpenFailed(newerState, original, '旧失败', 'stale-error')).toBe(newerState);
    expect(taskCreateOpenFinished(newerState, original)).toBe(newerState);
    expect(taskCreateOpenFinished(newerState, newer)).toEqual({
      feedbackKey: taskCreateFeedbackKey(newer),
      opening: false,
      error: null,
      errorFocusKey: null,
    });
  });

  it('preserves typed failures, uses Chinese messages, and bounds unknown remote errors', () => {
    const superseded = new TaskCreateSupersededError();
    const inProgress = new TaskCreateInProgressError();
    const unavailable = new TaskCreateUnavailableError();
    const noteDraftPreserved = new TaskCreateNoteDraftPreservedError();
    expect(superseded.message).toMatch(/新建任务/u);
    expect(inProgress.message).toMatch(/创建/u);
    expect(unavailable.message).toMatch(/任务/u);
    expect(noteDraftPreserved.message).toMatch(/笔记/u);
    expect(taskCreateNavigationError(superseded)).toBe(superseded);
    expect(taskCreateNavigationError(unavailable)).toBe(unavailable);
    expect(taskCreateNavigationError(noteDraftPreserved)).toBe(noteDraftPreserved);

    for (const remote of [
      new Error(
        "Error invoking remote method 'task:get-snapshot': 数据不可用；token=secret-provider-key",
      ),
      new Error('任务不存在；数据库路径=/secret/workspace.db'),
      new Error('工作区数据变化；internal=secret-provider-details'),
      new Error('secret provider details'),
    ]) {
      const bounded = taskCreateNavigationError(remote);
      expect(bounded.message).toBe('无法打开刚创建的任务，请重试。');
      expect(bounded.message).not.toContain('secret');
      expect(bounded.cause).toBe(remote);
    }
  });
});

function publishedFeedback(
  coordinator: TaskCreateCoordinator,
  workspace: TaskCreateWorkspaceIdentity,
): TaskCreateFeedback {
  const intent = coordinator.beginCreate(workspace);
  const current = coordinator.createFeedback(intent, workspace, task(), true);
  coordinator.endCreate(intent);
  return current;
}

function feedback(overrides: Partial<TaskCreateFeedback> = {}): TaskCreateFeedback {
  return Object.freeze({
    requestGeneration: 7,
    workspaceId: WORKSPACE_A,
    createdTaskId: TASK_A,
    title: '整理发布清单',
    plannedFor: '2026-07-25',
    ...overrides,
  });
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_A,
    title: '整理发布清单',
    status: 'todo',
    plannedFor: '2026-07-25',
    sourceInboxEntryId: null,
    createdAt: '2026-07-25T12:00:00.000Z',
    updatedAt: '2026-07-25T12:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: '2026-07-25',
    planningDays: [{ token: 'day-0', date: '2026-07-25' }],
    tasks: [task()],
    ...overrides,
  };
}

function refresh(
  taskSnapshot: TaskSnapshot,
  commit: () => boolean = () => true,
): TaskCreateSnapshotRefresh {
  return { snapshot: taskSnapshot, commit };
}
