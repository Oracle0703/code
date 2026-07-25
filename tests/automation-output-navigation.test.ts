import { describe, expect, it, vi } from 'vitest';
import type { NoteSnapshot, TaskSnapshot } from '../src/shared/contracts';
import {
  automationOutputOpenFailed,
  automationOutputOpenFinished,
  automationOutputOpenStarted,
  AutomationOutputNavigationCoordinator,
  AutomationOutputNavigationSupersededError,
  AutomationOutputOpenGate,
  AutomationOutputUnavailableError,
  resolveAutomationOutputNavigationTarget,
} from '../src/renderer/automation-output-navigation';
import {
  automationRunFeedbackKey,
  createAutomationWorkspaceIdentity,
  type AutomationRunFeedback,
  type AutomationWorkspaceIdentity,
} from '../src/renderer/automation-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const NOTE_ID = '33333333-3333-4333-8333-333333333333';

describe('automation output navigation', () => {
  it('resolves the exact task and note returned by Main', async () => {
    const workspace = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const taskFeedback = feedback('task', TASK_ID);
    const taskCoordinator = new AutomationOutputNavigationCoordinator();
    const taskIntent = taskCoordinator.begin(workspace, taskFeedback);
    const commitTask = vi.fn(() => true);
    const readTask = vi.fn(async () => refresh(taskSnapshot(), commitTask));
    const assertTaskCurrent = () =>
      taskCoordinator.assertCurrent(taskIntent, workspace, 'automations', taskFeedback);

    await expect(
      resolveAutomationOutputNavigationTarget(
        taskIntent,
        { task: readTask, note: vi.fn() },
        assertTaskCurrent,
      ),
    ).resolves.toMatchObject({
      kind: 'task',
      workspaceId: WORKSPACE_A,
      task: { id: TASK_ID, title: '检查备份' },
    });
    expect(readTask).toHaveBeenCalledOnce();
    expect(commitTask).toHaveBeenCalledOnce();

    const noteFeedback = feedback('note', NOTE_ID);
    const noteCoordinator = new AutomationOutputNavigationCoordinator();
    const noteIntent = noteCoordinator.begin(workspace, noteFeedback);
    const commitNote = vi.fn(() => true);
    const readNote = vi.fn(async () => refresh(noteSnapshot(), commitNote));
    const assertNoteCurrent = () =>
      noteCoordinator.assertCurrent(noteIntent, workspace, 'automations', noteFeedback);

    await expect(
      resolveAutomationOutputNavigationTarget(
        noteIntent,
        { task: vi.fn(), note: readNote },
        assertNoteCurrent,
      ),
    ).resolves.toMatchObject({
      kind: 'note',
      workspaceId: WORKSPACE_A,
      note: { id: NOTE_ID, title: '每周回顾' },
    });
    expect(readNote).toHaveBeenCalledOnce();
    expect(commitNote).toHaveBeenCalledOnce();
  });

  it('never falls back to another note when the exact output disappeared', async () => {
    const workspace = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const noteFeedback = feedback('note', NOTE_ID);
    const coordinator = new AutomationOutputNavigationCoordinator();
    const intent = coordinator.begin(workspace, noteFeedback);
    const assertCurrent = () =>
      coordinator.assertCurrent(intent, workspace, 'automations', noteFeedback);

    await expect(
      resolveAutomationOutputNavigationTarget(
        intent,
        {
          task: vi.fn(),
          note: async () =>
            refresh({
              workspaceId: WORKSPACE_A,
              notes: [
                {
                  id: '44444444-4444-4444-8444-444444444444',
                  title: '其他笔记',
                  body: '',
                  revision: 1,
                  sourceInboxEntryId: null,
                  createdAt: '2026-07-25T12:00:00.000Z',
                  updatedAt: '2026-07-25T12:00:00.000Z',
                },
              ],
            }),
        },
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(AutomationOutputUnavailableError);
  });

  it('never falls back to another task when the exact output disappeared', async () => {
    const workspace = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const taskFeedback = feedback('task', TASK_ID);
    const coordinator = new AutomationOutputNavigationCoordinator();
    const intent = coordinator.begin(workspace, taskFeedback);
    const assertCurrent = () =>
      coordinator.assertCurrent(intent, workspace, 'automations', taskFeedback);

    await expect(
      resolveAutomationOutputNavigationTarget(
        intent,
        {
          task: async () =>
            refresh({
              ...taskSnapshot(),
              tasks: [
                {
                  ...taskSnapshot().tasks[0],
                  id: '44444444-4444-4444-8444-444444444444',
                  title: '其他任务',
                },
              ],
            }),
          note: vi.fn(),
        },
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(AutomationOutputUnavailableError);
  });

  it('invalidates older intents after workspace, surface, or feedback changes', () => {
    const workspaceAFirst = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const currentFeedback = feedback('task', TASK_ID);
    const coordinator = new AutomationOutputNavigationCoordinator();
    const intent = coordinator.begin(workspaceAFirst, currentFeedback);

    expect(coordinator.isCurrent(intent, workspaceAFirst, 'automations', currentFeedback)).toBe(
      true,
    );
    expect(
      coordinator.isCurrent(
        intent,
        createAutomationWorkspaceIdentity(WORKSPACE_A),
        'automations',
        currentFeedback,
      ),
    ).toBe(false);
    expect(coordinator.isCurrent(intent, workspaceAFirst, 'tasks', currentFeedback)).toBe(false);
    expect(
      coordinator.isCurrent(
        intent,
        workspaceAFirst,
        'automations',
        feedback('task', '55555555-5555-4555-8555-555555555555'),
      ),
    ).toBe(false);

    coordinator.invalidate();
    expect(coordinator.isCurrent(intent, workspaceAFirst, 'automations', currentFeedback)).toBe(
      false,
    );
  });

  it('rejects a delayed snapshot after an A to B to A activation cycle', async () => {
    const workspaceAFirst = createAutomationWorkspaceIdentity(WORKSPACE_A);
    let currentWorkspace: AutomationWorkspaceIdentity = workspaceAFirst;
    const currentFeedback = feedback('task', TASK_ID);
    const coordinator = new AutomationOutputNavigationCoordinator();
    const intent = coordinator.begin(workspaceAFirst, currentFeedback);
    const commit = vi.fn(() => true);
    let releaseSnapshot!: (snapshot: ReturnType<typeof refresh<TaskSnapshot>>) => void;
    const delayedSnapshot = new Promise<ReturnType<typeof refresh<TaskSnapshot>>>((resolve) => {
      releaseSnapshot = resolve;
    });
    const navigation = resolveAutomationOutputNavigationTarget(
      intent,
      { task: () => delayedSnapshot, note: vi.fn() },
      () => coordinator.assertCurrent(intent, currentWorkspace, 'automations', currentFeedback),
    );

    currentWorkspace = createAutomationWorkspaceIdentity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    currentWorkspace = createAutomationWorkspaceIdentity(WORKSPACE_A);
    releaseSnapshot(refresh(taskSnapshot(), commit));

    await expect(navigation).rejects.toBeInstanceOf(AutomationOutputNavigationSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects a snapshot superseded by a newer controller request before committing it', async () => {
    const workspace = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const currentFeedback = feedback('task', TASK_ID);
    const coordinator = new AutomationOutputNavigationCoordinator();
    const intent = coordinator.begin(workspace, currentFeedback);
    const commit = vi.fn(() => false);

    await expect(
      resolveAutomationOutputNavigationTarget(
        intent,
        { task: async () => refresh(taskSnapshot(), commit), note: vi.fn() },
        () => coordinator.assertCurrent(intent, workspace, 'automations', currentFeedback),
      ),
    ).rejects.toBeInstanceOf(AutomationOutputNavigationSupersededError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('allows only one in-flight open for the same output while a newer output can replace it', () => {
    const gate = new AutomationOutputOpenGate();
    const taskKey = automationRunFeedbackKey(feedback('task', TASK_ID));
    const noteKey = automationRunFeedbackKey(feedback('note', NOTE_ID));
    expect(gate.begin(taskKey)).toBe(true);
    expect(gate.begin(taskKey)).toBe(false);
    expect(gate.begin(noteKey)).toBe(true);
    gate.end(taskKey);
    expect(gate.begin(noteKey)).toBe(false);
    gate.end(noteKey);
    expect(gate.begin(noteKey)).toBe(true);
  });

  it('keeps a newer output opening when an older identity with the same opaque id finishes late', () => {
    const taskKey = automationRunFeedbackKey(feedback('task', TASK_ID));
    const noteWithSameIdKey = automationRunFeedbackKey(feedback('note', TASK_ID));
    const first = automationOutputOpenStarted(taskKey);
    const second = automationOutputOpenStarted(noteWithSameIdKey);

    expect(automationOutputOpenFailed(first, taskKey, '旧输出失败')).toEqual({
      outputKey: taskKey,
      opening: false,
      error: '旧输出失败',
    });
    expect(automationOutputOpenFailed(second, taskKey, '旧输出失败')).toBe(second);
    expect(automationOutputOpenFinished(second, taskKey)).toBe(second);
    expect(automationOutputOpenFinished(second, noteWithSameIdKey)).toEqual({
      outputKey: noteWithSameIdKey,
      opening: false,
      error: null,
    });
  });
});

function feedback(
  outputKind: AutomationRunFeedback['outputKind'],
  outputId: string,
): AutomationRunFeedback {
  return {
    workspaceId: WORKSPACE_A,
    automationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    outputKind,
    outputId,
    outputTitle: outputKind === 'task' ? '检查备份' : '每周回顾',
    message: outputKind === 'task' ? '已立即创建今日任务：检查备份' : '已立即创建笔记：每周回顾',
  };
}

function taskSnapshot(): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: '2026-07-25',
    planningDays: [{ token: 'day-0', date: '2026-07-25' }],
    tasks: [
      {
        id: TASK_ID,
        title: '检查备份',
        status: 'todo',
        plannedFor: '2026-07-25',
        sourceInboxEntryId: null,
        createdAt: '2026-07-25T12:00:00.000Z',
        updatedAt: '2026-07-25T12:00:00.000Z',
        completedAt: null,
      },
    ],
  };
}

function noteSnapshot(): NoteSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    notes: [
      {
        id: NOTE_ID,
        title: '每周回顾',
        body: '# 本周',
        revision: 1,
        sourceInboxEntryId: null,
        createdAt: '2026-07-25T12:00:00.000Z',
        updatedAt: '2026-07-25T12:00:00.000Z',
      },
    ],
  };
}

function refresh<Snapshot>(
  snapshot: Snapshot,
  commit: () => boolean = () => true,
): { readonly snapshot: Snapshot; readonly commit: () => boolean } {
  return { snapshot, commit };
}
