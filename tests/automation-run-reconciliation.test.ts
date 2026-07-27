import { describe, expect, it, vi } from 'vitest';
import {
  AutomationRunOutputUnavailableError,
  AutomationRunReconciliationCoordinator,
  AutomationRunReconciliationSupersededError,
  AutomationRunSnapshotCommitError,
  reconcileAutomationRunOutput,
  type AutomationRunOutputIdentity,
  type AutomationRunReconciliationInput,
  type AutomationRunSnapshotRefresh,
} from '../src/renderer/automation-run-reconciliation';
import { createAutomationWorkspaceIdentity } from '../src/renderer/automation-state';
import type { Note, NoteSnapshot, Task, TaskSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TASK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('automation run output reconciliation', () => {
  it('accepts an exact uniquely matching task from the caller committed snapshot', async () => {
    const expectedTask = task();
    const sameTitle = task({ id: OTHER_ID });
    const prepareTaskSnapshotRefresh = vi.fn();
    const getCommittedNoteSnapshot = vi.fn();

    await expect(
      reconcileAutomationRunOutput(
        input({
          feedback: feedback('task', TASK_ID),
          getCommittedTaskSnapshot: () => taskSnapshot([sameTitle, expectedTask]),
          getCommittedNoteSnapshot,
          prepareTaskSnapshotRefresh,
        }),
      ),
    ).resolves.toEqual({
      output: {
        kind: 'task',
        workspaceId: WORKSPACE_A,
        task: expectedTask,
      },
      committed: true,
      error: undefined,
    });
    expect(getCommittedNoteSnapshot).not.toHaveBeenCalled();
    expect(prepareTaskSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('recovers an exact task on the first authoritative task read', async () => {
    const expectedTask = task();
    const commit = vi.fn(() => true);
    const prepareTaskSnapshotRefresh = vi.fn(async () =>
      refresh(taskSnapshot([task({ id: OTHER_ID }), expectedTask]), commit),
    );
    const prepareNoteSnapshotRefresh = vi.fn();

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('task', TASK_ID),
        prepareTaskSnapshotRefresh,
        prepareNoteSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      output: {
        kind: 'task',
        workspaceId: WORKSPACE_A,
        task: expectedTask,
      },
      committed: true,
      error: undefined,
    });
    expect(prepareTaskSnapshotRefresh).toHaveBeenCalledOnce();
    expect(prepareNoteSnapshotRefresh).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('recovers an exact note on the second authoritative note read after a throw', async () => {
    const expectedNote = note();
    const readFailure = new Error('internal storage location must not become UI copy');
    const commit = vi.fn(() => true);
    const prepareNoteSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(readFailure)
      .mockResolvedValueOnce(refresh(noteSnapshot([expectedNote]), commit));
    const prepareTaskSnapshotRefresh = vi.fn();

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('note', NOTE_ID),
        prepareTaskSnapshotRefresh,
        prepareNoteSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      output: {
        kind: 'note',
        workspaceId: WORKSPACE_A,
        note: expectedNote,
      },
      committed: true,
      error: readFailure,
    });
    expect(prepareNoteSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(prepareTaskSnapshotRefresh).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'missing opaque task id',
      snapshot: () => taskSnapshot([task({ id: OTHER_ID })]),
    },
    {
      name: 'duplicate opaque task id',
      snapshot: () => taskSnapshot([task(), task()]),
    },
    {
      name: 'wrong task workspace',
      snapshot: () => taskSnapshot([task()], WORKSPACE_B),
    },
  ])('fails closed for $name without committing', async ({ snapshot }) => {
    const commit = vi.fn(() => true);
    const prepareTaskSnapshotRefresh = vi.fn(async () => refresh(snapshot(), commit));

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('task', TASK_ID),
        prepareTaskSnapshotRefresh,
      }),
    );

    expect(result.output).toBeNull();
    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(AutomationRunOutputUnavailableError);
    expect(prepareTaskSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'missing opaque note id',
      snapshot: () => noteSnapshot([note({ id: OTHER_ID })]),
    },
    {
      name: 'duplicate opaque note id',
      snapshot: () => noteSnapshot([note(), note()]),
    },
    {
      name: 'wrong note workspace',
      snapshot: () => noteSnapshot([note()], WORKSPACE_B),
    },
  ])('fails closed for $name without committing', async ({ snapshot }) => {
    const commit = vi.fn(() => true);
    const prepareNoteSnapshotRefresh = vi.fn(async () => refresh(snapshot(), commit));

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('note', NOTE_ID),
        prepareNoteSnapshotRefresh,
      }),
    );

    expect(result.output).toBeNull();
    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(AutomationRunOutputUnavailableError);
    expect(prepareNoteSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('bounds repeated authoritative read failures to two attempts', async () => {
    const secondFailure = new Error('second internal read failure');
    const prepareTaskSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('first internal read failure'))
      .mockRejectedValueOnce(secondFailure);

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('task', TASK_ID),
        prepareTaskSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      output: null,
      committed: false,
      error: secondFailure,
    });
    expect(prepareTaskSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('requires a true commit and retries a false commit only within the bound', async () => {
    const expectedNote = note();
    const commits = [vi.fn(() => false), vi.fn(() => false)] as const;
    const prepareNoteSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(noteSnapshot([expectedNote]), commits[0]))
      .mockResolvedValueOnce(refresh(noteSnapshot([expectedNote]), commits[1]));

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('note', NOTE_ID),
        prepareNoteSnapshotRefresh,
      }),
    );

    expect(result.output).toEqual({
      kind: 'note',
      workspaceId: WORKSPACE_A,
      note: expectedNote,
    });
    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(AutomationRunSnapshotCommitError);
    expect(prepareNoteSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(commits[0]).toHaveBeenCalledOnce();
    expect(commits[1]).toHaveBeenCalledOnce();
  });

  it('accepts the exact output when a newer request commits it after this refresh is superseded', async () => {
    const expectedTask = task();
    let committedSnapshot: TaskSnapshot | null = null;
    const commit = vi.fn(() => {
      committedSnapshot = taskSnapshot([expectedTask]);
      return false;
    });
    const prepareTaskSnapshotRefresh = vi.fn(async () =>
      refresh(taskSnapshot([expectedTask]), commit),
    );

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('task', TASK_ID),
        getCommittedTaskSnapshot: () => committedSnapshot,
        prepareTaskSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      output: {
        kind: 'task',
        workspaceId: WORKSPACE_A,
        task: expectedTask,
      },
      committed: true,
      error: expect.any(AutomationRunSnapshotCommitError),
    });
    expect(prepareTaskSnapshotRefresh).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('fails closed after an awaited refresh invalidates the originating activation', async () => {
    let current = true;
    const commit = vi.fn(() => true);
    const prepareTaskSnapshotRefresh = vi.fn(async () => {
      current = false;
      return refresh(taskSnapshot([task()]), commit);
    });

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('task', TASK_ID),
        prepareTaskSnapshotRefresh,
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      output: null,
      committed: false,
      error: expect.any(AutomationRunReconciliationSupersededError),
    });
    expect(prepareTaskSnapshotRefresh).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed when a successful commit invalidates the originating activation', async () => {
    let current = true;
    const commit = vi.fn(() => {
      current = false;
      return true;
    });

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('note', NOTE_ID),
        prepareNoteSnapshotRefresh: async () => refresh(noteSnapshot([note()]), commit),
        isCurrent: () => current,
      }),
    );

    expect(result.output).toEqual({
      kind: 'note',
      workspaceId: WORKSPACE_A,
      note: note(),
    });
    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(AutomationRunReconciliationSupersededError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('checks currency again after reading the caller committed snapshot', async () => {
    let current = true;
    const prepareTaskSnapshotRefresh = vi.fn();

    const result = await reconcileAutomationRunOutput(
      input({
        feedback: feedback('task', TASK_ID),
        getCommittedTaskSnapshot: () => {
          current = false;
          return taskSnapshot([task()]);
        },
        prepareTaskSnapshotRefresh,
        isCurrent: () => current,
      }),
    );

    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(AutomationRunReconciliationSupersededError);
    expect(prepareTaskSnapshotRefresh).not.toHaveBeenCalled();
  });
});

describe('automation run reconciliation coordinator', () => {
  it('keeps one run or recovery intent single-flight per workspace while allowing parallel workspaces', () => {
    const workspaceA = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createAutomationWorkspaceIdentity(WORKSPACE_B);
    const coordinator = new AutomationRunReconciliationCoordinator();
    const runA = coordinator.begin(workspaceA, 'run:automation-a');
    const recoveryB = coordinator.begin(workspaceB, 'recover:output-b');

    expect(runA).not.toBeNull();
    expect(recoveryB).not.toBeNull();
    expect(coordinator.begin(workspaceA, 'recover:output-a')).toBeNull();
    expect(coordinator.isPending(WORKSPACE_A)).toBe(true);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(true);
    expect(coordinator.isActive(runA!)).toBe(true);
    expect(coordinator.isCurrent(runA!, workspaceA)).toBe(true);
    expect(coordinator.isCurrent(recoveryB!, workspaceB)).toBe(true);

    coordinator.end(runA!);
    expect(coordinator.isActive(runA!)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(true);
  });

  it('does not revive an intent after an A to B to A activation cycle', () => {
    const firstA = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createAutomationWorkspaceIdentity(WORKSPACE_B);
    const secondA = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationRunReconciliationCoordinator();
    const intent = coordinator.begin(firstA, 'run:automation-a')!;

    expect(coordinator.isCurrent(intent, firstA)).toBe(true);
    expect(coordinator.isCurrent(intent, workspaceB)).toBe(false);
    expect(coordinator.isCurrent(intent, secondA)).toBe(false);
    expect(coordinator.begin(secondA, 'run:automation-b')).toBeNull();
  });

  it('lets only the owning intent end a newer same-workspace intent', () => {
    const workspace = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AutomationRunReconciliationCoordinator();
    const first = coordinator.begin(workspace, 'run:first')!;

    coordinator.invalidate(WORKSPACE_A);
    const second = coordinator.begin(workspace, 'recover:second')!;
    coordinator.end(first);

    expect(coordinator.isCurrent(first, workspace)).toBe(false);
    expect(coordinator.isCurrent(second, workspace)).toBe(true);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(true);
    coordinator.end(second);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
  });

  it('invalidates one workspace or all workspaces without affecting stale end calls', () => {
    const workspaceA = createAutomationWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createAutomationWorkspaceIdentity(WORKSPACE_B);
    const coordinator = new AutomationRunReconciliationCoordinator();
    const intentA = coordinator.begin(workspaceA, 'run:a')!;
    const intentB = coordinator.begin(workspaceB, 'run:b')!;

    coordinator.invalidate(WORKSPACE_A);
    expect(coordinator.isCurrent(intentA, workspaceA)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_A)).toBe(false);
    expect(coordinator.isCurrent(intentB, workspaceB)).toBe(true);

    coordinator.invalidateAll();
    expect(coordinator.isCurrent(intentB, workspaceB)).toBe(false);
    expect(coordinator.isPending(WORKSPACE_B)).toBe(false);
    coordinator.end(intentA);
    coordinator.end(intentB);
  });

  it('rejects unavailable workspace and empty keys', () => {
    const coordinator = new AutomationRunReconciliationCoordinator();

    expect(coordinator.begin(createAutomationWorkspaceIdentity(null), 'run:a')).toBeNull();
    expect(coordinator.begin(createAutomationWorkspaceIdentity(WORKSPACE_A), '')).toBeNull();
    expect(coordinator.isPending(null)).toBe(false);
  });
});

function feedback(
  outputKind: AutomationRunOutputIdentity['outputKind'],
  outputId: string,
): AutomationRunOutputIdentity {
  return {
    workspaceId: WORKSPACE_A,
    outputKind,
    outputId,
  };
}

function input(
  overrides: Partial<AutomationRunReconciliationInput> = {},
): AutomationRunReconciliationInput {
  return {
    feedback: feedback('task', TASK_ID),
    getCommittedTaskSnapshot: () => null,
    getCommittedNoteSnapshot: () => null,
    prepareTaskSnapshotRefresh: async () => refresh(taskSnapshot([task()])),
    prepareNoteSnapshotRefresh: async () => refresh(noteSnapshot([note()])),
    isCurrent: () => true,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: '相同可见标题',
    status: 'todo',
    plannedFor: '2026-07-27',
    sourceInboxEntryId: null,
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: NOTE_ID,
    title: '相同可见标题',
    body: '# 自动化输出',
    revision: 1,
    sourceInboxEntryId: null,
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
    ...overrides,
  };
}

function taskSnapshot(tasks: readonly Task[], workspaceId: string = WORKSPACE_A): TaskSnapshot {
  return {
    workspaceId,
    todayDate: '2026-07-27',
    planningDays: [{ token: 'day-0', date: '2026-07-27' }],
    tasks,
  };
}

function noteSnapshot(notes: readonly Note[], workspaceId: string = WORKSPACE_A): NoteSnapshot {
  return { workspaceId, notes };
}

function refresh<Snapshot>(
  snapshot: Snapshot,
  commit: () => boolean = () => true,
): AutomationRunSnapshotRefresh<Snapshot> {
  return { snapshot, commit };
}
