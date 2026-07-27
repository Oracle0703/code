import { describe, expect, it, vi } from 'vitest';
import {
  archivedNoteIsAbsent,
  clearResolvedNoteMutationSyncWarning,
  createNoteArchiveMutationIntent,
  createNoteUpdateMutationIntent,
  createNoteWorkspaceIdentity,
  isNoteMutationNavigationBlocked,
  noteMutationSyncWarningForActivation,
  NoteMutationResultUnavailableError,
  NoteMutationSnapshotCommitError,
  NoteMutationSupersededError,
  reconcileNoteArchiveResult,
  reconcileNoteUpdateResult,
  updatedNoteFromSnapshot,
  type NoteArchiveMutationIntent,
  type NoteArchiveReconciliationInput,
  type NoteMutationSnapshotRefresh,
  type NoteMutationSyncWarningState,
  type NoteUpdateMutationIntent,
  type NoteUpdateReconciliationInput,
} from '../src/renderer/note-state';
import type { Note, NoteSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const NOTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_NOTE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOURCE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_SOURCE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('note mutation intents and exact snapshot identity', () => {
  it('normalizes update text and predicts revision changes without drifting original identity', () => {
    const original = note();
    const intent = createNoteUpdateMutationIntent(
      WORKSPACE_A,
      original,
      '  更新标题  ',
      '第一行\r\n第二行\r第三行',
    );

    expect(intent).toEqual({
      kind: 'update',
      expectedWorkspaceId: WORKSPACE_A,
      originalNote: original,
      title: '更新标题',
      body: '第一行\n第二行\n第三行',
      contentChanged: true,
      expectedCommittedRevision: original.revision + 1,
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.originalNote)).toBe(true);
    expect(intent.originalNote).not.toBe(original);
  });

  it('treats normalization-only edits as a no-op with the same revision', () => {
    const original = note({ title: '原标题', body: '第一行\n第二行' });
    const intent = createNoteUpdateMutationIntent(
      WORKSPACE_A,
      original,
      '  原标题  ',
      '第一行\r\n第二行',
    );

    expect(intent.contentChanged).toBe(false);
    expect(intent.expectedCommittedRevision).toBe(original.revision);
    expect(
      updatedNoteFromSnapshot(
        intent,
        snapshot([
          {
            ...original,
            title: intent.title,
            body: intent.body,
          },
        ]),
      ),
    ).toEqual(original);
    expect(
      updatedNoteFromSnapshot(
        intent,
        snapshot([
          {
            ...original,
            title: intent.title,
            body: intent.body,
            revision: original.revision + 1,
            updatedAt: '2026-07-22T12:00:01.000Z',
          },
        ]),
      ),
    ).toBeNull();
  });

  it('rejects invalid text, unnormalized originals, and unsafe revision increments', () => {
    expect(() => createNoteUpdateMutationIntent(WORKSPACE_A, note(), ' \n ', '')).toThrow(
      TypeError,
    );
    expect(() =>
      createNoteUpdateMutationIntent(
        WORKSPACE_A,
        note({ body: 'already\r\nunnormalized' }),
        '标题',
        '',
      ),
    ).toThrow(TypeError);
    expect(() =>
      createNoteUpdateMutationIntent(
        WORKSPACE_A,
        note({ revision: Number.MAX_SAFE_INTEGER }),
        '变化',
        '正文',
      ),
    ).toThrow(TypeError);
    expect(() =>
      createNoteArchiveMutationIntent(WORKSPACE_A, note({ revision: Number.MAX_SAFE_INTEGER })),
    ).toThrow(TypeError);
  });

  it.each([
    {
      name: 'missing exact id',
      snapshot: (intent: NoteUpdateMutationIntent) =>
        snapshot([updatedNote(intent, { id: OTHER_NOTE_ID })]),
    },
    {
      name: 'duplicate exact id',
      snapshot: (intent: NoteUpdateMutationIntent) =>
        snapshot([updatedNote(intent), updatedNote(intent)]),
    },
    {
      name: 'wrong content',
      snapshot: (intent: NoteUpdateMutationIntent) =>
        snapshot([updatedNote(intent, { body: '错误正文' })]),
    },
    {
      name: 'wrong revision',
      snapshot: (intent: NoteUpdateMutationIntent) =>
        snapshot([updatedNote(intent, { revision: intent.expectedCommittedRevision + 1 })]),
    },
    {
      name: 'drifted source identity',
      snapshot: (intent: NoteUpdateMutationIntent) =>
        snapshot([updatedNote(intent, { sourceInboxEntryId: OTHER_SOURCE_ID })]),
    },
    {
      name: 'drifted creation identity',
      snapshot: (intent: NoteUpdateMutationIntent) =>
        snapshot([updatedNote(intent, { createdAt: '2026-07-21T12:00:00.000Z' })]),
    },
    {
      name: 'regressed update timestamp',
      snapshot: (intent: NoteUpdateMutationIntent) =>
        snapshot([updatedNote(intent, { updatedAt: '2026-07-22T11:59:59.000Z' })]),
    },
    {
      name: 'wrong workspace',
      snapshot: (intent: NoteUpdateMutationIntent) => snapshot([updatedNote(intent)], WORKSPACE_B),
    },
  ])('rejects an updated note with $name', ({ snapshot: candidateSnapshot }) => {
    const intent = updateIntent();
    expect(updatedNoteFromSnapshot(intent, candidateSnapshot(intent))).toBeNull();
  });

  it('accepts only one exact updated note while preserving source and creation identity', () => {
    const intent = updateIntent();
    const exact = updatedNote(intent);

    expect(updatedNoteFromSnapshot(intent, snapshot([note({ id: OTHER_NOTE_ID }), exact]))).toBe(
      exact,
    );
  });

  it('accepts a changed update whose logical timestamp remains equal to the original', () => {
    const intent = updateIntent();
    const exact = updatedNote(intent, { updatedAt: intent.originalNote.updatedAt });

    expect(updatedNoteFromSnapshot(intent, snapshot([exact]))).toBe(exact);
  });

  it('confirms archive only from the expected workspace with the exact id absent', () => {
    const intent = archiveIntent();

    expect(archivedNoteIsAbsent(intent, snapshot([note({ id: OTHER_NOTE_ID })]))).toBe(true);
    expect(archivedNoteIsAbsent(intent, snapshot([], WORKSPACE_B))).toBe(false);
    expect(archivedNoteIsAbsent(intent, snapshot([note()]))).toBe(false);
    expect(archivedNoteIsAbsent(intent, snapshot([note(), note()]))).toBe(false);
  });
});

describe('note update reconciliation', () => {
  it('commits an exact Main response before consulting committed state or refreshing', async () => {
    const intent = updateIntent();
    const exact = updatedNote(intent);
    const commitResultSnapshot = vi.fn(() => true);
    const getCommittedSnapshot = vi.fn();
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileNoteUpdateResult(
        updateInput({
          intent,
          resultSnapshot: snapshot([exact]),
          commitResultSnapshot,
          getCommittedSnapshot,
          prepareSnapshotRefresh,
        }),
      ),
    ).resolves.toEqual({
      authoritativeNote: exact,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
    expect(getCommittedSnapshot).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('uses the latest committed ref after rejecting a malformed response snapshot', async () => {
    const intent = updateIntent();
    const exact = updatedNote(intent);
    const commitResultSnapshot = vi.fn();
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileNoteUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([updatedNote(intent, { body: '错误正文' })]),
        commitResultSnapshot,
        getCommittedSnapshot: () => snapshot([exact]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeNote).toBe(exact);
    expect(result.committed).toBe(true);
    expect(result.error).toBeInstanceOf(NoteMutationResultUnavailableError);
    expect(commitResultSnapshot).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('survives committed-ref and first refresh read failures, then commits the second refresh', async () => {
    const intent = updateIntent();
    const exact = updatedNote(intent);
    const secondCommit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('first authoritative read failed'))
      .mockResolvedValueOnce(refresh(snapshot([exact]), secondCommit));

    const result = await reconcileNoteUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        getCommittedSnapshot: () => {
          throw new Error('committed ref read failed');
        },
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeNote).toBe(exact);
    expect(result.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(secondCommit).toHaveBeenCalledOnce();
  });

  it('fails closed when every exact candidate has a false commit', async () => {
    const intent = updateIntent();
    const exact = updatedNote(intent);
    const responseCommit = vi.fn(() => false);
    const refreshCommits = [vi.fn(() => false), vi.fn(() => false)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([exact]), refreshCommits[0]))
      .mockResolvedValueOnce(refresh(snapshot([exact]), refreshCommits[1]));

    const result = await reconcileNoteUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([exact]),
        commitResultSnapshot: responseCommit,
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      authoritativeNote: null,
      committed: false,
      error: expect.any(NoteMutationSnapshotCommitError),
    });
    expect(responseCommit).toHaveBeenCalledOnce();
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(refreshCommits[0]).toHaveBeenCalledOnce();
    expect(refreshCommits[1]).toHaveBeenCalledOnce();
  });

  it('fails closed when the intent is invalidated after an awaited refresh', async () => {
    const intent = updateIntent();
    const exact = updatedNote(intent);
    let current = true;
    const commit = vi.fn(() => true);

    const result = await reconcileNoteUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        prepareSnapshotRefresh: async () => {
          current = false;
          return refresh(snapshot([exact]), commit);
        },
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      authoritativeNote: null,
      committed: false,
      error: expect.any(NoteMutationSupersededError),
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed when a successful commit invalidates the intent', async () => {
    const intent = updateIntent();
    let current = true;
    const commitResultSnapshot = vi.fn(() => {
      current = false;
      return true;
    });

    const result = await reconcileNoteUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([updatedNote(intent)]),
        commitResultSnapshot,
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      authoritativeNote: null,
      committed: false,
      error: expect.any(NoteMutationSupersededError),
    });
  });

  it('checks currency again after reading the latest committed ref', async () => {
    const intent = updateIntent();
    let current = true;
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileNoteUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        getCommittedSnapshot: () => {
          current = false;
          return snapshot([updatedNote(intent)]);
        },
        prepareSnapshotRefresh,
        isCurrent: () => current,
      }),
    );

    expect(result).toEqual({
      authoritativeNote: null,
      committed: false,
      error: expect.any(NoteMutationSupersededError),
    });
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('performs a final ref check after exactly two unsuccessful prepared refreshes', async () => {
    const intent = updateIntent();
    const exact = updatedNote(intent);
    let committedChecks = 0;
    const prepareSnapshotRefresh = vi.fn(async () => refresh(snapshot([])));

    const result = await reconcileNoteUpdateResult(
      updateInput({
        intent,
        resultSnapshot: snapshot([]),
        getCommittedSnapshot: () => {
          committedChecks += 1;
          return committedChecks === 2 ? snapshot([exact]) : null;
        },
        prepareSnapshotRefresh,
      }),
    );

    expect(result.authoritativeNote).toBe(exact);
    expect(result.committed).toBe(true);
    expect(committedChecks).toBe(2);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('note archive reconciliation', () => {
  it('confirms an exact absent id only after the Main response snapshot commits', async () => {
    const intent = archiveIntent();
    const commitResultSnapshot = vi.fn(() => true);

    await expect(
      reconcileNoteArchiveResult(
        archiveInput({
          intent,
          resultSnapshot: snapshot([note({ id: OTHER_NOTE_ID })]),
          commitResultSnapshot,
        }),
      ),
    ).resolves.toEqual({
      confirmed: true,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
  });

  it('rejects wrong-workspace absence and a present exact id without committing either', async () => {
    const intent = archiveIntent();
    const commits = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([], WORKSPACE_B), commits[1]))
      .mockResolvedValueOnce(refresh(snapshot([note()]), commits[2]));

    const result = await reconcileNoteArchiveResult(
      archiveInput({
        intent,
        resultSnapshot: snapshot([], WORKSPACE_B),
        commitResultSnapshot: commits[0],
        getCommittedSnapshot: () => snapshot([note()]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result.confirmed).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.error).toBeInstanceOf(NoteMutationResultUnavailableError);
    expect(commits[0]).not.toHaveBeenCalled();
    expect(commits[1]).not.toHaveBeenCalled();
    expect(commits[2]).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('does not confirm an absent archive candidate when its commit returns false', async () => {
    const intent = archiveIntent();
    const commitResultSnapshot = vi.fn(() => false);
    const prepareSnapshotRefresh = vi.fn(async () =>
      refresh(snapshot([], WORKSPACE_A), () => false),
    );

    const result = await reconcileNoteArchiveResult(
      archiveInput({
        intent,
        resultSnapshot: snapshot([]),
        commitResultSnapshot,
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      confirmed: false,
      committed: false,
      error: expect.any(NoteMutationSnapshotCommitError),
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('confirms archive absence from the final committed ref after two unsuccessful reads', async () => {
    const intent = archiveIntent();
    let committedChecks = 0;
    const prepareSnapshotRefresh = vi.fn(async () => refresh(snapshot([note()])));

    const result = await reconcileNoteArchiveResult(
      archiveInput({
        intent,
        resultSnapshot: snapshot([note()]),
        getCommittedSnapshot: () => {
          committedChecks += 1;
          return committedChecks === 2 ? snapshot([]) : snapshot([note()]);
        },
        prepareSnapshotRefresh,
      }),
    );

    expect(result.confirmed).toBe(true);
    expect(result.committed).toBe(true);
    expect(committedChecks).toBe(2);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('note mutation warning activation state', () => {
  it('binds warnings to activation identity and clears only the exact resolved mutation', () => {
    const activation = createNoteWorkspaceIdentity(WORKSPACE_A);
    const remountedActivation = createNoteWorkspaceIdentity(WORKSPACE_A);
    const intent = updateIntent();
    const warning: NoteMutationSyncWarningState = {
      activation,
      kind: 'update',
      intent,
      resultSnapshot: snapshot([updatedNote(intent)]),
      title: intent.title,
      message: '已保存但未同步',
    };

    expect(noteMutationSyncWarningForActivation(activation, warning)).toBe(warning);
    expect(noteMutationSyncWarningForActivation(remountedActivation, warning)).toBeNull();
    expect(isNoteMutationNavigationBlocked(false, warning)).toBe(true);
    expect(isNoteMutationNavigationBlocked(true, null)).toBe(true);
    expect(isNoteMutationNavigationBlocked(false, null)).toBe(false);
    expect(
      clearResolvedNoteMutationSyncWarning(warning, activation, {
        ...warning,
        intent: updateIntent({ revision: intent.originalNote.revision + 1 }),
      }),
    ).toBe(warning);
    expect(clearResolvedNoteMutationSyncWarning(warning, remountedActivation, warning)).toBe(
      warning,
    );
    expect(clearResolvedNoteMutationSyncWarning(warning, activation, warning)).toBeNull();
  });
});

function updateIntent(overrides: Partial<Note> = {}): NoteUpdateMutationIntent {
  return createNoteUpdateMutationIntent(WORKSPACE_A, note(overrides), '更新标题', '更新正文');
}

function archiveIntent(overrides: Partial<Note> = {}): NoteArchiveMutationIntent {
  return createNoteArchiveMutationIntent(WORKSPACE_A, note(overrides));
}

function updatedNote(intent: NoteUpdateMutationIntent, overrides: Partial<Note> = {}): Note {
  return {
    ...intent.originalNote,
    title: intent.title,
    body: intent.body,
    revision: intent.expectedCommittedRevision,
    updatedAt: intent.contentChanged ? '2026-07-22T12:00:01.000Z' : intent.originalNote.updatedAt,
    ...overrides,
  };
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: NOTE_ID,
    title: '原标题',
    body: '原正文',
    revision: 3,
    sourceInboxEntryId: SOURCE_ID,
    createdAt: '2026-07-22T11:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
    ...overrides,
  };
}

function snapshot(notes: readonly Note[], workspaceId = WORKSPACE_A): NoteSnapshot {
  return { workspaceId, notes };
}

function refresh(
  candidate: NoteSnapshot,
  commit: () => boolean = () => true,
): NoteMutationSnapshotRefresh {
  return { snapshot: candidate, commit };
}

function updateInput(
  overrides: Partial<NoteUpdateReconciliationInput> = {},
): NoteUpdateReconciliationInput {
  const intent = updateIntent();
  return {
    intent,
    resultSnapshot: snapshot([updatedNote(intent)]),
    commitResultSnapshot: () => true,
    getCommittedSnapshot: () => null,
    prepareSnapshotRefresh: async () => refresh(snapshot([])),
    isCurrent: () => true,
    ...overrides,
  };
}

function archiveInput(
  overrides: Partial<NoteArchiveReconciliationInput> = {},
): NoteArchiveReconciliationInput {
  return {
    intent: archiveIntent(),
    resultSnapshot: snapshot([]),
    commitResultSnapshot: () => true,
    getCommittedSnapshot: () => null,
    prepareSnapshotRefresh: async () => refresh(snapshot([note()])),
    isCurrent: () => true,
    ...overrides,
  };
}
