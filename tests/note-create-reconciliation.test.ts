import { describe, expect, it, vi } from 'vitest';
import {
  beginPendingNoteCreate,
  clearResolvedNoteCreateSyncWarning,
  createdNoteFromResult,
  createNoteWorkspaceIdentity,
  endPendingNoteCreate,
  isNoteCreateNavigationBlocked,
  noteCreateSyncWarningForActivation,
  reconcileNoteCreateResult,
} from '../src/renderer/note-state';
import type { Note, NoteCreateResult, NoteSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const CREATED_NOTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_NOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('note create reconciliation', () => {
  it('resolves one exact created id without falling back to visible fields', () => {
    const created = note({ id: CREATED_NOTE_ID });
    const sameContent = note({ id: OTHER_NOTE_ID });
    const result = resultFor(created, sameContent);

    expect(createdNoteFromResult(WORKSPACE_A, result)).toBe(created);
    expect(
      createdNoteFromResult(WORKSPACE_A, {
        ...result,
        createdNoteId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ).toBeNull();
    expect(createdNoteFromResult(WORKSPACE_B, result)).toBeNull();
    expect(
      createdNoteFromResult(WORKSPACE_A, {
        ...result,
        noteSnapshot: snapshot([created, { ...created }]),
      }),
    ).toBeNull();
  });

  it('commits the note:create response snapshot without an authoritative read', async () => {
    const created = note();
    const commitResultSnapshot = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileNoteCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: resultFor(created),
        commitResultSnapshot,
        getCommittedNote: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdNote: created,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('accepts the exact note from a newer already-committed snapshot before reading', async () => {
    const created = note();
    const committed = note({
      title: '已由较新快照更新',
      revision: 2,
      updatedAt: '2026-07-27T12:01:00.000Z',
    });
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileNoteCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: resultFor(created),
        commitResultSnapshot: () => false,
        getCommittedNote: () => committed,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdNote: committed,
      committed: true,
      error: undefined,
    });
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('recovers the exact note on the first authoritative read', async () => {
    const created = note();
    const sameContent = note({ id: OTHER_NOTE_ID });
    const commit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot([sameContent, created]),
      commit,
    }));

    const reconciled = await reconcileNoteCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedNote: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled).toEqual({
      createdNote: created,
      committed: true,
      error: undefined,
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('recovers on the second authoritative read after the first read throws', async () => {
    const created = note();
    const firstFailure = new Error('internal database path must not become UI text');
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce({
        snapshot: snapshot([created]),
        commit: () => true,
      });

    await expect(
      reconcileNoteCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: resultFor(created),
        commitResultSnapshot: () => false,
        getCommittedNote: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdNote: created,
      committed: true,
      error: firstFailure,
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('uses the second read when the first omits the exact id', async () => {
    const created = note();
    const sameContent = note({ id: OTHER_NOTE_ID });
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: snapshot([sameContent]),
        commit: () => true,
      })
      .mockResolvedValueOnce({
        snapshot: snapshot([sameContent, created]),
        commit: () => true,
      });

    const reconciled = await reconcileNoteCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedNote: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdNote).toBe(created);
    expect(reconciled.committed).toBe(true);
    expect(reconciled.error).toBeInstanceOf(Error);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('fails closed after two exact snapshots cannot be committed', async () => {
    const created = note();
    const commits = [vi.fn(() => false), vi.fn(() => false)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce({
        snapshot: snapshot([created]),
        commit: commits[0],
      })
      .mockResolvedValueOnce({
        snapshot: snapshot([created]),
        commit: commits[1],
      });

    const reconciled = await reconcileNoteCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedNote: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdNote).toBe(created);
    expect(reconciled.committed).toBe(false);
    expect(reconciled.error).toBeInstanceOf(Error);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(commits[0]).toHaveBeenCalledOnce();
    expect(commits[1]).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'missing exact id',
      snapshot: snapshot([note({ id: OTHER_NOTE_ID })]),
    },
    {
      name: 'duplicate exact ids',
      snapshot: snapshot([note(), note()]),
    },
    {
      name: 'wrong workspace',
      snapshot: snapshot([note()], WORKSPACE_B),
    },
  ])('fails closed for $name without committing the refresh', async ({ snapshot: refreshed }) => {
    const created = note();
    const commit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: refreshed,
      commit,
    }));

    const reconciled = await reconcileNoteCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedNote: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdNote).toBe(created);
    expect(reconciled.committed).toBe(false);
    expect(reconciled.error).toBeInstanceOf(Error);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('accepts a newer committed exact note in the bounded final check', async () => {
    const created = note();
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot([created]),
      commit: () => false,
    }));
    let committedSnapshotChecks = 0;

    const reconciled = await reconcileNoteCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedNote: () => {
        committedSnapshotChecks += 1;
        return committedSnapshotChecks === 3 ? created : null;
      },
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdNote).toBe(created);
    expect(reconciled.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(committedSnapshotChecks).toBe(3);
  });

  it('stops after an awaited read when the originating activation is invalidated', async () => {
    const created = note();
    let current = true;
    const commit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn(async () => {
      current = false;
      return {
        snapshot: snapshot([created]),
        commit,
      };
    });

    const reconciled = await reconcileNoteCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedNote: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => current,
    });

    expect(reconciled).toEqual({
      createdNote: created,
      committed: false,
      error: undefined,
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it('keeps a committed warning across surface remounts but not A→B→A activation changes', () => {
    const activationA = createNoteWorkspaceIdentity(WORKSPACE_A);
    const warning = {
      activation: activationA,
      result: resultFor(note()),
      title: '已落库的笔记',
      body: '等待当前工作区重新读取。',
      message: '请不要重复创建。',
    };

    expect(noteCreateSyncWarningForActivation(activationA, warning)).toBe(warning);
    expect(
      noteCreateSyncWarningForActivation(createNoteWorkspaceIdentity(WORKSPACE_B), warning),
    ).toBeNull();
    expect(
      noteCreateSyncWarningForActivation(createNoteWorkspaceIdentity(WORKSPACE_A), warning),
    ).toBeNull();
  });

  it('clears only the exact resolved warning from its originating activation', () => {
    const activationA = createNoteWorkspaceIdentity(WORKSPACE_A);
    const warning = {
      activation: activationA,
      result: resultFor(note()),
      title: '已落库的笔记',
      body: '等待当前工作区重新读取。',
      message: '请不要重复创建。',
    };

    expect(clearResolvedNoteCreateSyncWarning(warning, activationA, warning)).toBeNull();
    expect(
      clearResolvedNoteCreateSyncWarning(
        warning,
        createNoteWorkspaceIdentity(WORKSPACE_A),
        warning,
      ),
    ).toBe(warning);
    expect(
      clearResolvedNoteCreateSyncWarning(warning, activationA, {
        ...warning,
        result: {
          ...warning.result,
          createdNoteId: OTHER_NOTE_ID,
        },
      }),
    ).toBe(warning);
  });

  it('keeps note creation single-flight by workspace through A→B→A activations', () => {
    const empty = new Set<string>();
    const pendingA = beginPendingNoteCreate(empty, WORKSPACE_A);
    expect(pendingA).not.toBeNull();
    expect(beginPendingNoteCreate(pendingA!, WORKSPACE_A)).toBeNull();

    const pendingAB = beginPendingNoteCreate(pendingA!, WORKSPACE_B);
    expect(pendingAB).toEqual(new Set([WORKSPACE_A, WORKSPACE_B]));
    expect(beginPendingNoteCreate(pendingAB!, WORKSPACE_A)).toBeNull();

    const pendingB = endPendingNoteCreate(pendingAB!, WORKSPACE_A);
    expect(pendingB).toEqual(new Set([WORKSPACE_B]));
    expect(beginPendingNoteCreate(pendingB, WORKSPACE_A)).toEqual(
      new Set([WORKSPACE_B, WORKSPACE_A]),
    );
  });

  it('blocks async search navigation throughout pending and committed-warning states', () => {
    const activationA = createNoteWorkspaceIdentity(WORKSPACE_A);
    const warning = {
      activation: activationA,
      result: resultFor(note()),
      title: '已落库的笔记',
      body: '等待当前工作区重新读取。',
      message: '请不要重复创建。',
    };

    expect(isNoteCreateNavigationBlocked(true, null)).toBe(true);
    expect(isNoteCreateNavigationBlocked(false, warning)).toBe(true);
    expect(isNoteCreateNavigationBlocked(false, null)).toBe(false);
  });
});

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: CREATED_NOTE_ID,
    title: '重复标题',
    body: '相同正文',
    revision: 1,
    sourceInboxEntryId: null,
    createdAt: '2026-07-27T12:00:00.000Z',
    updatedAt: '2026-07-27T12:00:00.000Z',
    ...overrides,
  };
}

function snapshot(notes: readonly Note[], workspaceId: string = WORKSPACE_A): NoteSnapshot {
  return { workspaceId, notes };
}

function resultFor(created: Note, ...otherNotes: readonly Note[]): NoteCreateResult {
  return {
    noteSnapshot: snapshot([...otherNotes, created]),
    createdNoteId: created.id,
  };
}
