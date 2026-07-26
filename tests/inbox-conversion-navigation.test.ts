import { describe, expect, it, vi } from 'vitest';
import type { NoteSnapshot, TaskSnapshot } from '../src/shared/contracts';
import {
  createInboxConversionWorkspaceIdentity,
  inboxConversionFeedbackKey,
  inboxConversionNavigationError,
  inboxConversionOpenFailed,
  inboxConversionOpenFinished,
  inboxConversionOpenStarted,
  InboxConversionNavigationCoordinator,
  InboxConversionOpenGate,
  InboxConversionOutputUnavailableError,
  InboxConversionRequestCoordinator,
  InboxConversionSupersededError,
  resolveInboxConversionNavigationTarget,
  sameInboxConversionFeedback,
  type InboxConversionFeedback,
  type InboxConversionSnapshotRefresh,
  type InboxConversionWorkspaceIdentity,
} from '../src/renderer/inbox-conversion-navigation';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const SOURCE_A = '33333333-3333-4333-8333-333333333333';
const SOURCE_B = '44444444-4444-4444-8444-444444444444';
const TASK_A = '55555555-5555-4555-8555-555555555555';
const TASK_B = '66666666-6666-4666-8666-666666666666';
const NOTE_A = '77777777-7777-4777-8777-777777777777';
const NOTE_B = '88888888-8888-4888-8888-888888888888';

describe('inbox conversion navigation', () => {
  it('creates a distinct frozen identity for every workspace activation', () => {
    const firstA = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxConversionWorkspaceIdentity(WORKSPACE_A);

    expect(firstA).toEqual(secondA);
    expect(firstA).not.toBe(secondA);
    expect(Object.isFrozen(firstA)).toBe(true);
    expect(createInboxConversionWorkspaceIdentity(null)).toEqual({ workspaceId: null });
  });

  it('keeps equal source/kind mutations single-flight and only the latest different intent current', () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxConversionRequestCoordinator();
    expect(() =>
      coordinator.begin(createInboxConversionWorkspaceIdentity(null), SOURCE_A, 'task'),
    ).toThrow(InboxConversionSupersededError);
    const first = coordinator.begin(workspace, SOURCE_A, 'task');

    expect(first).not.toBeNull();
    expect(coordinator.begin(workspace, SOURCE_A, 'task')).toBeNull();

    const newer = coordinator.begin(workspace, SOURCE_B, 'note');
    expect(newer).not.toBeNull();
    expect(coordinator.isCurrent(first!, workspace)).toBe(false);
    expect(() =>
      coordinator.createFeedback(first!, workspace, {
        outputId: TASK_A,
        outputTitle: '旧任务',
      }),
    ).toThrow(InboxConversionSupersededError);

    const feedback = coordinator.createFeedback(newer!, workspace, {
      outputId: NOTE_A,
      outputTitle: '精确笔记',
    });
    expect(feedback).toEqual({
      requestGeneration: newer!.generation,
      workspaceId: WORKSPACE_A,
      sourceEntryId: SOURCE_B,
      outputKind: 'note',
      outputId: NOTE_A,
      outputTitle: '精确笔记',
    });
    expect(Object.isFrozen(feedback)).toBe(true);
  });

  it('treats different output kinds as different leases and ignores an old duplicate end', () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxConversionRequestCoordinator();
    const task = coordinator.begin(workspace, SOURCE_A, 'task')!;
    const note = coordinator.begin(workspace, SOURCE_A, 'note')!;

    expect(task.generation).toBeLessThan(note.generation);
    expect(coordinator.begin(workspace, SOURCE_A, 'task')).toBeNull();
    expect(coordinator.begin(workspace, SOURCE_A, 'note')).toBeNull();

    coordinator.end(task);
    const replacementTask = coordinator.begin(workspace, SOURCE_A, 'task')!;
    coordinator.end(task);
    expect(coordinator.begin(workspace, SOURCE_A, 'task')).toBeNull();

    coordinator.end(replacementTask);
    expect(coordinator.begin(workspace, SOURCE_A, 'task')).not.toBeNull();
  });

  it('suppresses an older same-kind failure after a newer conversion succeeds', () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxConversionRequestCoordinator();
    const older = coordinator.begin(workspace, SOURCE_A, 'note')!;
    const newer = coordinator.begin(workspace, SOURCE_B, 'note')!;

    expect(
      coordinator.createFeedback(newer, workspace, {
        outputId: NOTE_B,
        outputTitle: '较新的笔记',
      }),
    ).toMatchObject({ sourceEntryId: SOURCE_B, outputId: NOTE_B });
    expect(coordinator.isCurrent(older, workspace)).toBe(false);
    expect(coordinator.isCurrent(newer, workspace)).toBe(true);
  });

  it('suppresses an older cross-kind failure after a newer conversion succeeds', () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxConversionRequestCoordinator();
    const olderTask = coordinator.begin(workspace, SOURCE_A, 'task')!;
    const newerNote = coordinator.begin(workspace, SOURCE_B, 'note')!;

    expect(
      coordinator.createFeedback(newerNote, workspace, {
        outputId: NOTE_B,
        outputTitle: '较新的笔记',
      }),
    ).toMatchObject({ outputKind: 'note', outputId: NOTE_B });
    expect(coordinator.isCurrent(olderTask, workspace)).toBe(false);
    expect(coordinator.isCurrent(newerNote, workspace)).toBe(true);
  });

  it('rejects conversion feedback after invalidation or an A to B to A activation cycle', () => {
    const firstA = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxConversionRequestCoordinator();
    const intent = coordinator.begin(firstA, SOURCE_A, 'task')!;

    expect(coordinator.isCurrent(intent, createInboxConversionWorkspaceIdentity(WORKSPACE_B))).toBe(
      false,
    );
    expect(coordinator.isCurrent(intent, createInboxConversionWorkspaceIdentity(WORKSPACE_A))).toBe(
      false,
    );
    expect(() =>
      coordinator.createFeedback(intent, createInboxConversionWorkspaceIdentity(WORKSPACE_A), {
        outputId: TASK_A,
        outputTitle: '不应发布',
      }),
    ).toThrow(InboxConversionSupersededError);

    expect(coordinator.isCurrent(intent, firstA)).toBe(true);
    coordinator.invalidate();
    expect(coordinator.isCurrent(intent, firstA)).toBe(false);
  });

  it('binds an open intent to Inbox, the exact activation, and the complete current feedback', () => {
    const firstA = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const current = feedback();
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(firstA, current);

    expect(coordinator.isCurrent(intent, firstA, 'inbox', current)).toBe(true);
    expect(coordinator.isCurrent(intent, secondA, 'inbox', current)).toBe(false);
    expect(coordinator.isCurrent(intent, firstA, 'tasks', current)).toBe(false);
    expect(
      coordinator.isCurrent(intent, firstA, 'inbox', {
        ...current,
        outputTitle: '较新的反馈',
      }),
    ).toBe(false);
    expect(
      coordinator.isCurrent(intent, firstA, 'inbox', {
        ...current,
        requestGeneration: current.requestGeneration + 1,
      }),
    ).toBe(false);

    coordinator.invalidate();
    expect(coordinator.isCurrent(intent, firstA, 'inbox', current)).toBe(false);
    expect(() =>
      coordinator.begin(createInboxConversionWorkspaceIdentity(WORKSPACE_B), current),
    ).toThrow(InboxConversionSupersededError);
  });

  it('fresh-reads, commits, and returns only the exact task with the exact inbox source', async () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const current = feedback();
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(workspace, current);
    const commit = vi.fn(() => true);
    const readTask = vi.fn(async () => refresh(taskSnapshot(), commit));
    const readNote = vi.fn();
    const assertCurrent = () => coordinator.assertCurrent(intent, workspace, 'inbox', current);

    await expect(
      resolveInboxConversionNavigationTarget(
        intent,
        { task: readTask, note: readNote },
        assertCurrent,
      ),
    ).resolves.toMatchObject({
      kind: 'task',
      workspaceId: WORKSPACE_A,
      task: {
        id: TASK_A,
        sourceInboxEntryId: SOURCE_A,
        title: '发布检查',
      },
    });
    expect(readTask).toHaveBeenCalledOnce();
    expect(readNote).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('keeps the exact task target across midnight without substituting the new day-0 task', async () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const current = feedback();
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(workspace, current);
    const original = taskSnapshot().tasks[0]!;
    const snapshot = taskSnapshot({
      todayDate: '2026-07-26',
      planningDays: [{ token: 'day-0', date: '2026-07-26' }],
      tasks: [
        {
          ...original,
          title: '发布检查（已重命名）',
          plannedFor: '2026-07-25',
        },
        {
          ...original,
          id: TASK_B,
          title: current.outputTitle,
          plannedFor: '2026-07-26',
          sourceInboxEntryId: SOURCE_B,
        },
      ],
    });

    await expect(
      resolveInboxConversionNavigationTarget(
        intent,
        { task: async () => refresh(snapshot), note: vi.fn() },
        () => coordinator.assertCurrent(intent, workspace, 'inbox', current),
      ),
    ).resolves.toMatchObject({
      kind: 'task',
      task: {
        id: TASK_A,
        title: '发布检查（已重命名）',
        plannedFor: '2026-07-25',
      },
    });
  });

  it('fresh-reads, commits, and returns only the exact note with the exact inbox source', async () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const current = feedback({
      outputKind: 'note',
      outputId: NOTE_A,
      outputTitle: '发布记录',
    });
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(workspace, current);
    const commit = vi.fn(() => true);
    const readTask = vi.fn();
    const readNote = vi.fn(async () => refresh(noteSnapshot(), commit));

    await expect(
      resolveInboxConversionNavigationTarget(intent, { task: readTask, note: readNote }, () =>
        coordinator.assertCurrent(intent, workspace, 'inbox', current),
      ),
    ).resolves.toMatchObject({
      kind: 'note',
      workspaceId: WORKSPACE_A,
      note: {
        id: NOTE_A,
        sourceInboxEntryId: SOURCE_A,
        title: '发布记录',
      },
    });
    expect(readTask).not.toHaveBeenCalled();
    expect(readNote).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('never falls back by source, title, or list position when the task id is missing', async () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const current = feedback();
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(workspace, current);
    const commit = vi.fn(() => true);
    const snapshot = taskSnapshot({
      tasks: [
        {
          ...taskSnapshot().tasks[0]!,
          id: TASK_B,
          title: current.outputTitle,
          sourceInboxEntryId: current.sourceEntryId,
        },
        {
          ...taskSnapshot().tasks[0]!,
          id: current.outputId,
          sourceInboxEntryId: SOURCE_B,
        },
      ],
    });

    await expect(
      resolveInboxConversionNavigationTarget(
        intent,
        { task: async () => refresh(snapshot, commit), note: vi.fn() },
        () => coordinator.assertCurrent(intent, workspace, 'inbox', current),
      ),
    ).rejects.toBeInstanceOf(InboxConversionOutputUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('treats an archived or source-mismatched note as unavailable without fallback', async () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const current = feedback({
      outputKind: 'note',
      outputId: NOTE_A,
      outputTitle: '发布记录',
    });
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(workspace, current);
    const commit = vi.fn(() => true);

    await expect(
      resolveInboxConversionNavigationTarget(
        intent,
        {
          task: vi.fn(),
          note: async () =>
            refresh(
              noteSnapshot({
                notes: [
                  {
                    ...noteSnapshot().notes[0]!,
                    id: NOTE_B,
                    title: current.outputTitle,
                    sourceInboxEntryId: current.sourceEntryId,
                  },
                ],
              }),
              commit,
            ),
        },
        () => coordinator.assertCurrent(intent, workspace, 'inbox', current),
      ),
    ).rejects.toBeInstanceOf(InboxConversionOutputUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects a wrong-workspace snapshot and a refresh superseded before commit', async () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const current = feedback();
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(workspace, current);
    const assertCurrent = () => coordinator.assertCurrent(intent, workspace, 'inbox', current);
    const wrongWorkspaceCommit = vi.fn(() => true);

    await expect(
      resolveInboxConversionNavigationTarget(
        intent,
        {
          task: async () =>
            refresh(taskSnapshot({ workspaceId: WORKSPACE_B }), wrongWorkspaceCommit),
          note: vi.fn(),
        },
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxConversionOutputUnavailableError);
    expect(wrongWorkspaceCommit).not.toHaveBeenCalled();

    await expect(
      resolveInboxConversionNavigationTarget(
        intent,
        { task: async () => refresh(taskSnapshot(), () => false), note: vi.fn() },
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxConversionSupersededError);
  });

  it('rejects a delayed read after a page change, newer feedback, or A to B to A', async () => {
    const firstA = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const original = feedback();
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      sourceEntryId: SOURCE_B,
      outputId: TASK_B,
      outputTitle: '较新任务',
    });
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(firstA, original);
    let currentWorkspace: InboxConversionWorkspaceIdentity = firstA;
    let currentSurface = 'inbox';
    let currentFeedback: InboxConversionFeedback | null = original;
    let release!: (value: InboxConversionSnapshotRefresh<TaskSnapshot>) => void;
    const delayed = new Promise<InboxConversionSnapshotRefresh<TaskSnapshot>>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(() => true);
    const resolution = resolveInboxConversionNavigationTarget(
      intent,
      { task: () => delayed, note: vi.fn() },
      () => coordinator.assertCurrent(intent, currentWorkspace, currentSurface, currentFeedback),
    );

    currentSurface = 'tasks';
    currentWorkspace = createInboxConversionWorkspaceIdentity(WORKSPACE_B);
    currentWorkspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    currentSurface = 'inbox';
    currentFeedback = newer;
    release(refresh(taskSnapshot(), commit));

    await expect(resolution).rejects.toBeInstanceOf(InboxConversionSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not return a target when feedback changes during the authoritative commit', async () => {
    const workspace = createInboxConversionWorkspaceIdentity(WORKSPACE_A);
    const original = feedback();
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      sourceEntryId: SOURCE_B,
      outputId: TASK_B,
    });
    let currentFeedback = original;
    const coordinator = new InboxConversionNavigationCoordinator();
    const intent = coordinator.begin(workspace, original);
    const commit = vi.fn(() => {
      currentFeedback = newer;
      return true;
    });

    await expect(
      resolveInboxConversionNavigationTarget(
        intent,
        { task: async () => refresh(taskSnapshot(), commit), note: vi.fn() },
        () => coordinator.assertCurrent(intent, workspace, 'inbox', currentFeedback),
      ),
    ).rejects.toBeInstanceOf(InboxConversionSupersededError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('gates equal feedback opens and prevents an old end from releasing a replacement lease', () => {
    const original = feedback();
    const equalReplacement = { ...original };
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      outputId: TASK_B,
    });
    const gate = new InboxConversionOpenGate();

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

  it('keys complete feedback and ignores late failure or finally reducers', () => {
    const original = feedback();
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      outputKind: 'note',
      outputId: NOTE_A,
      outputTitle: '较新笔记',
    });
    const originalState = inboxConversionOpenStarted(original);
    const newerState = inboxConversionOpenStarted(newer);

    expect(inboxConversionFeedbackKey(original)).not.toBe(inboxConversionFeedbackKey(newer));
    expect(sameInboxConversionFeedback(original, { ...original })).toBe(true);
    expect(sameInboxConversionFeedback(original, newer)).toBe(false);
    expect(sameInboxConversionFeedback(original, null)).toBe(false);
    expect(
      inboxConversionOpenFailed(originalState, original, '打开失败', 'original-error'),
    ).toEqual({
      feedbackKey: inboxConversionFeedbackKey(original),
      opening: false,
      error: '打开失败',
      errorFocusKey: 'original-error',
    });
    expect(inboxConversionOpenFailed(newerState, original, '旧失败', 'stale-error')).toBe(
      newerState,
    );
    expect(inboxConversionOpenFinished(newerState, original)).toBe(newerState);
    expect(inboxConversionOpenFinished(newerState, newer)).toEqual({
      feedbackKey: inboxConversionFeedbackKey(newer),
      opening: false,
      error: null,
      errorFocusKey: null,
    });
  });

  it('preserves typed navigation failures and bounds unknown provider errors', () => {
    const superseded = new InboxConversionSupersededError();
    const unavailable = new InboxConversionOutputUnavailableError('note');
    expect(inboxConversionNavigationError(superseded, 'task')).toBe(superseded);
    expect(inboxConversionNavigationError(unavailable, 'note')).toBe(unavailable);

    const known = inboxConversionNavigationError(
      new Error("Error invoking remote method 'note:get-snapshot': 已保存笔记已归档，当前不可用。"),
      'note',
    );
    expect(known.message).toBe('已保存笔记已归档，当前不可用。');

    const unknown = inboxConversionNavigationError(new Error('secret provider details'), 'task');
    expect(unknown.message).toBe('无法打开刚转换的任务，请重试。');
    expect(unknown.message).not.toContain('secret');
  });
});

function feedback(overrides: Partial<InboxConversionFeedback> = {}): InboxConversionFeedback {
  return Object.freeze({
    requestGeneration: 7,
    workspaceId: WORKSPACE_A,
    sourceEntryId: SOURCE_A,
    outputKind: 'task',
    outputId: TASK_A,
    outputTitle: '发布检查',
    ...overrides,
  });
}

function taskSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    todayDate: '2026-07-25',
    planningDays: [{ token: 'day-0', date: '2026-07-25' }],
    tasks: [
      {
        id: TASK_A,
        title: '发布检查',
        status: 'todo',
        plannedFor: '2026-07-25',
        sourceInboxEntryId: SOURCE_A,
        createdAt: '2026-07-25T12:00:00.000Z',
        updatedAt: '2026-07-25T12:00:00.000Z',
        completedAt: null,
      },
    ],
    ...overrides,
  };
}

function noteSnapshot(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    notes: [
      {
        id: NOTE_A,
        title: '发布记录',
        body: '# 发布',
        revision: 1,
        sourceInboxEntryId: SOURCE_A,
        createdAt: '2026-07-25T12:00:00.000Z',
        updatedAt: '2026-07-25T12:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function refresh<Snapshot>(
  snapshot: Snapshot,
  commit: () => boolean = () => true,
): InboxConversionSnapshotRefresh<Snapshot> {
  return { snapshot, commit };
}
