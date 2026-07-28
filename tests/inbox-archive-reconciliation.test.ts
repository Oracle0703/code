import { describe, expect, it, vi } from 'vitest';
import {
  archivedInboxEntryIsAbsent,
  createInboxArchiveMutationIntent,
  createInboxUndoMutationIntent,
  InboxArchiveMutationResultUnavailableError,
  InboxArchiveMutationSnapshotCommitError,
  InboxArchiveMutationSupersededError,
  inboxUndoMonotonicDeadline,
  reconcileInboxArchiveResult,
  reconcileInboxUndoResult,
  restoredInboxEntryFromSnapshot,
  type InboxArchiveMutationIntent,
  type InboxArchiveSnapshotRefresh,
  type InboxUndoMutationIntent,
} from '../src/renderer/inbox-archive-reconciliation';
import type { InboxEntry, InboxSnapshot } from '../src/shared/contracts';
import { INBOX_UNDO_WINDOW_MS } from '../src/shared/inbox-domain';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const ENTRY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ENTRY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNDO_TOKEN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CREATED_AT = '2026-07-27T12:00:00.000Z';
const UPDATED_AT = '2026-07-27T12:00:01.000Z';
const RESTORED_AT = '2026-07-27T12:00:02.000Z';
const UNDO_EXPIRES_AT = '2026-07-27T12:00:15.000Z';

describe('inbox archive identities', () => {
  it('freezes a normalized workspace and original entry identity', () => {
    const original = entry();
    const archive = createInboxArchiveMutationIntent(WORKSPACE_A, original);
    const undo = createInboxUndoMutationIntent(WORKSPACE_A, original, UNDO_TOKEN, UNDO_EXPIRES_AT);

    expect(archive).toEqual({
      kind: 'archive',
      expectedWorkspaceId: WORKSPACE_A,
      originalEntry: original,
    });
    expect(undo).toEqual({
      kind: 'undo',
      expectedWorkspaceId: WORKSPACE_A,
      originalEntry: original,
      undoToken: UNDO_TOKEN,
      undoExpiresAt: UNDO_EXPIRES_AT,
    });
    expect(Object.isFrozen(archive)).toBe(true);
    expect(Object.isFrozen(archive.originalEntry)).toBe(true);
    expect(archive.originalEntry).not.toBe(original);
    expect(Object.isFrozen(undo)).toBe(true);
    expect(Object.isFrozen(undo.originalEntry)).toBe(true);
  });

  it.each([
    {
      name: 'invalid workspace',
      run: () => createInboxArchiveMutationIntent('not-a-workspace', entry()),
    },
    {
      name: 'invalid entry id',
      run: () => createInboxArchiveMutationIntent(WORKSPACE_A, entry({ id: 'not-an-id' })),
    },
    {
      name: 'unnormalized content',
      run: () => createInboxArchiveMutationIntent(WORKSPACE_A, entry({ content: ' 原记录 ' })),
    },
    {
      name: 'unsupported category',
      run: () =>
        createInboxArchiveMutationIntent(
          WORKSPACE_A,
          entry({ category: 'idea' as InboxEntry['category'] }),
        ),
    },
    {
      name: 'non-exact creation timestamp',
      run: () =>
        createInboxArchiveMutationIntent(WORKSPACE_A, entry({ createdAt: '2026-07-27T12:00:00Z' })),
    },
    {
      name: 'regressed update timestamp',
      run: () =>
        createInboxArchiveMutationIntent(
          WORKSPACE_A,
          entry({ updatedAt: '2026-07-27T11:59:59.999Z' }),
        ),
    },
    {
      name: 'invalid undo token',
      run: () =>
        createInboxUndoMutationIntent(
          WORKSPACE_A,
          entry(),
          UNDO_TOKEN.toUpperCase(),
          UNDO_EXPIRES_AT,
        ),
    },
    {
      name: 'non-exact undo expiration',
      run: () =>
        createInboxUndoMutationIntent(WORKSPACE_A, entry(), UNDO_TOKEN, '2026-07-27T12:00:15Z'),
    },
  ])('rejects an identity with $name', ({ run }) => {
    expect(run).toThrow(TypeError);
  });

  it('confirms archive absence only in the exact workspace', () => {
    const intent = archiveIntent();

    expect(archivedInboxEntryIsAbsent(intent, snapshot([]))).toBe(true);
    expect(archivedInboxEntryIsAbsent(intent, snapshot([entry({ id: OTHER_ENTRY_ID })]))).toBe(
      true,
    );
    expect(archivedInboxEntryIsAbsent(intent, snapshot([entry()]))).toBe(false);
    expect(archivedInboxEntryIsAbsent(intent, snapshot([], WORKSPACE_B))).toBe(false);
  });

  it('accepts one restored exact id with stable content, category, creation, and monotonic update', () => {
    const intent = undoIntent();
    const restored = entry({ updatedAt: RESTORED_AT });

    expect(
      restoredInboxEntryFromSnapshot(intent, snapshot([entry({ id: OTHER_ENTRY_ID }), restored])),
    ).toBe(restored);
    expect(
      restoredInboxEntryFromSnapshot(intent, snapshot([entry({ updatedAt: UPDATED_AT })])),
    ).not.toBeNull();
  });

  it.each([
    {
      name: 'wrong workspace',
      candidate: () => snapshot([entry({ updatedAt: RESTORED_AT })], WORKSPACE_B),
    },
    { name: 'missing id', candidate: () => snapshot([]) },
    {
      name: 'duplicate id',
      candidate: () =>
        snapshot([
          entry({ updatedAt: RESTORED_AT }),
          entry({ updatedAt: '2026-07-27T12:00:03.000Z' }),
        ]),
    },
    {
      name: 'changed content',
      candidate: () => snapshot([entry({ content: '其他记录', updatedAt: RESTORED_AT })]),
    },
    {
      name: 'changed category',
      candidate: () => snapshot([entry({ category: 'task', updatedAt: RESTORED_AT })]),
    },
    {
      name: 'changed creation identity',
      candidate: () =>
        snapshot([
          entry({
            createdAt: '2026-07-27T11:59:59.000Z',
            updatedAt: RESTORED_AT,
          }),
        ]),
    },
    {
      name: 'regressed update timestamp',
      candidate: () => snapshot([entry({ updatedAt: '2026-07-27T12:00:00.999Z' })]),
    },
    {
      name: 'non-exact update timestamp',
      candidate: () => snapshot([entry({ updatedAt: '2026-07-27T12:00:02Z' })]),
    },
  ])('rejects a restored entry with $name', ({ candidate }) => {
    expect(restoredInboxEntryFromSnapshot(undoIntent(), candidate())).toBeNull();
  });
});

describe('inbox undo deadline conversion', () => {
  const issuedAtMs = Date.parse('2026-07-27T12:00:00.000Z');

  it('subtracts response latency instead of granting a fresh undo window', () => {
    expect(inboxUndoMonotonicDeadline(UNDO_EXPIRES_AT, issuedAtMs + 5_000, 250)).toBe(10_250);
    expect(inboxUndoMonotonicDeadline(UNDO_EXPIRES_AT, issuedAtMs, 250)).toBe(
      250 + INBOX_UNDO_WINDOW_MS,
    );
  });

  it.each([
    {
      name: 'malformed expiration',
      expiresAt: 'not-a-time',
      wallNowMs: issuedAtMs,
      monotonicNowMs: 250,
    },
    {
      name: 'non-canonical expiration',
      expiresAt: '2026-07-27T12:00:15Z',
      wallNowMs: issuedAtMs,
      monotonicNowMs: 250,
    },
    {
      name: 'expired deadline',
      expiresAt: UNDO_EXPIRES_AT,
      wallNowMs: Date.parse(UNDO_EXPIRES_AT),
      monotonicNowMs: 250,
    },
    {
      name: 'expiration beyond the Main window',
      expiresAt: '2026-07-27T12:00:15.001Z',
      wallNowMs: issuedAtMs,
      monotonicNowMs: 250,
    },
    {
      name: 'invalid wall time',
      expiresAt: UNDO_EXPIRES_AT,
      wallNowMs: Number.NaN,
      monotonicNowMs: 250,
    },
    {
      name: 'invalid monotonic time',
      expiresAt: UNDO_EXPIRES_AT,
      wallNowMs: issuedAtMs,
      monotonicNowMs: -1,
    },
    {
      name: 'overflowed monotonic deadline',
      expiresAt: UNDO_EXPIRES_AT,
      wallNowMs: issuedAtMs,
      monotonicNowMs: Number.MAX_VALUE,
    },
  ])('fails closed for $name', ({ expiresAt, wallNowMs, monotonicNowMs }) => {
    expect(inboxUndoMonotonicDeadline(expiresAt, wallNowMs, monotonicNowMs)).toBeNull();
  });
});

describe('inbox archive reconciliation', () => {
  it('commits an exact Main response before consulting committed state or refreshing', async () => {
    const commitResultSnapshot = vi.fn(() => true);
    const getCommittedSnapshot = vi.fn();
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileInboxArchiveResult(
        archiveInput({
          resultSnapshot: snapshot([]),
          commitResultSnapshot,
          getCommittedSnapshot,
          prepareSnapshotRefresh,
        }),
      ),
    ).resolves.toEqual({
      confirmed: true,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
    expect(getCommittedSnapshot).not.toHaveBeenCalled();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('uses an exact committed ref after the response snapshot loses its sequence race', async () => {
    const prepareSnapshotRefresh = vi.fn();

    const result = await reconcileInboxArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([]),
        commitResultSnapshot: () => false,
        getCommittedSnapshot: () => snapshot([]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result.confirmed).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.error).toBeInstanceOf(InboxArchiveMutationSnapshotCommitError);
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('uses response, initial ref, two reads, and final ref in strict order', async () => {
    const events: string[] = [];
    let refReads = 0;

    const result = await reconcileInboxArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([]),
        commitResultSnapshot: () => {
          events.push('response-commit');
          return false;
        },
        getCommittedSnapshot: () => {
          refReads += 1;
          events.push(`ref-${refReads}`);
          return refReads === 2 ? snapshot([]) : null;
        },
        prepareSnapshotRefresh: async () => {
          events.push(
            `refresh-${events.filter((value) => value.startsWith('refresh')).length + 1}`,
          );
          return refresh(snapshot([entry()]));
        },
      }),
    );

    expect(result.confirmed).toBe(true);
    expect(result.committed).toBe(true);
    expect(events).toEqual(['response-commit', 'ref-1', 'refresh-1', 'refresh-2', 'ref-2']);
  });

  it('survives the first read failure and commits the second exact refresh', async () => {
    const secondCommit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('first read failed'))
      .mockResolvedValueOnce(refresh(snapshot([]), secondCommit));

    const result = await reconcileInboxArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([entry()]),
        getCommittedSnapshot: () => null,
        prepareSnapshotRefresh,
      }),
    );

    expect(result.confirmed).toBe(true);
    expect(result.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(secondCommit).toHaveBeenCalledOnce();
  });

  it('fails closed after exactly two authoritative snapshots cannot commit', async () => {
    const responseCommit = vi.fn(() => false);
    const refreshCommits = [vi.fn(() => false), vi.fn(() => false)] as const;
    const getCommittedSnapshot = vi.fn(() => null);
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([]), refreshCommits[0]))
      .mockResolvedValueOnce(refresh(snapshot([]), refreshCommits[1]));

    const result = await reconcileInboxArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([]),
        commitResultSnapshot: responseCommit,
        getCommittedSnapshot,
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      confirmed: false,
      committed: false,
      error: expect.any(InboxArchiveMutationSnapshotCommitError),
    });
    expect(responseCommit).toHaveBeenCalledOnce();
    expect(getCommittedSnapshot).toHaveBeenCalledTimes(2);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(refreshCommits[0]).toHaveBeenCalledOnce();
    expect(refreshCommits[1]).toHaveBeenCalledOnce();
  });

  it('never commits snapshots where the target remains present or the workspace differs', async () => {
    const commits = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)] as const;
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([entry()]), commits[1]))
      .mockResolvedValueOnce(refresh(snapshot([], WORKSPACE_B), commits[2]));

    const result = await reconcileInboxArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([entry()]),
        commitResultSnapshot: commits[0],
        getCommittedSnapshot: () => snapshot([entry()]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      confirmed: false,
      committed: false,
      error: expect.any(InboxArchiveMutationResultUnavailableError),
    });
    for (const commit of commits) expect(commit).not.toHaveBeenCalled();
  });

  it('fails closed at every supersession boundary', async () => {
    const untouchedCommit = vi.fn();
    const untouchedRefresh = vi.fn();
    await expect(
      reconcileInboxArchiveResult(
        archiveInput({
          commitResultSnapshot: untouchedCommit,
          prepareSnapshotRefresh: untouchedRefresh,
          isCurrent: () => false,
        }),
      ),
    ).resolves.toEqual({
      confirmed: false,
      committed: false,
      error: expect.any(InboxArchiveMutationSupersededError),
    });
    expect(untouchedCommit).not.toHaveBeenCalled();
    expect(untouchedRefresh).not.toHaveBeenCalled();

    let current = true;
    const lateCommit = vi.fn(() => true);
    const late = await reconcileInboxArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([entry()]),
        prepareSnapshotRefresh: async () => {
          current = false;
          return refresh(snapshot([]), lateCommit);
        },
        isCurrent: () => current,
      }),
    );
    expect(late.error).toBeInstanceOf(InboxArchiveMutationSupersededError);
    expect(lateCommit).not.toHaveBeenCalled();

    current = true;
    const commitSuperseded = await reconcileInboxArchiveResult(
      archiveInput({
        resultSnapshot: snapshot([]),
        commitResultSnapshot: () => {
          current = false;
          return true;
        },
        isCurrent: () => current,
      }),
    );
    expect(commitSuperseded.error).toBeInstanceOf(InboxArchiveMutationSupersededError);
    expect(commitSuperseded.committed).toBe(false);
  });
});

describe('inbox undo reconciliation', () => {
  it('commits only the exact restored entry from Main', async () => {
    const restored = entry({ updatedAt: RESTORED_AT });

    await expect(
      reconcileInboxUndoResult(
        undoInput({
          resultSnapshot: snapshot([restored]),
          commitResultSnapshot: () => true,
        }),
      ),
    ).resolves.toEqual({
      restoredEntry: restored,
      committed: true,
      error: undefined,
    });
  });

  it('recovers a consumed undo through bounded reads without replaying the token', async () => {
    const restored = entry({ updatedAt: RESTORED_AT });
    const firstCommit = vi.fn(() => false);
    const secondCommit = vi.fn(() => true);
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([restored]), firstCommit))
      .mockResolvedValueOnce(refresh(snapshot([restored]), secondCommit));

    const result = await reconcileInboxUndoResult(
      undoInput({
        resultSnapshot: snapshot([]),
        getCommittedSnapshot: () => null,
        prepareSnapshotRefresh,
      }),
    );

    expect(result.restoredEntry).toBe(restored);
    expect(result.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(firstCommit).toHaveBeenCalledOnce();
    expect(secondCommit).toHaveBeenCalledOnce();
  });

  it('fails closed for a changed restored identity and never commits it', async () => {
    const commits = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)] as const;
    const changed = entry({ content: '其他记录', updatedAt: RESTORED_AT });
    const prepareSnapshotRefresh = vi
      .fn()
      .mockResolvedValueOnce(refresh(snapshot([changed]), commits[1]))
      .mockResolvedValueOnce(refresh(snapshot([changed]), commits[2]));

    const result = await reconcileInboxUndoResult(
      undoInput({
        resultSnapshot: snapshot([changed]),
        commitResultSnapshot: commits[0],
        getCommittedSnapshot: () => snapshot([changed]),
        prepareSnapshotRefresh,
      }),
    );

    expect(result).toEqual({
      restoredEntry: null,
      committed: false,
      error: expect.any(InboxArchiveMutationResultUnavailableError),
    });
    for (const commit of commits) expect(commit).not.toHaveBeenCalled();
  });
});

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: ENTRY_ID,
    content: '原记录',
    category: 'note',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function snapshot(
  entries: readonly InboxEntry[],
  workspaceId: string = WORKSPACE_A,
): InboxSnapshot {
  return { workspaceId, entries };
}

function archiveIntent(): InboxArchiveMutationIntent {
  return createInboxArchiveMutationIntent(WORKSPACE_A, entry());
}

function undoIntent(): InboxUndoMutationIntent {
  return createInboxUndoMutationIntent(WORKSPACE_A, entry(), UNDO_TOKEN, UNDO_EXPIRES_AT);
}

function refresh(
  value: InboxSnapshot,
  commit: () => boolean = () => true,
): InboxArchiveSnapshotRefresh {
  return { snapshot: value, commit };
}

function archiveInput(
  overrides: Partial<Parameters<typeof reconcileInboxArchiveResult>[0]> = {},
): Parameters<typeof reconcileInboxArchiveResult>[0] {
  return {
    intent: archiveIntent(),
    resultSnapshot: snapshot([entry()]),
    commitResultSnapshot: () => false,
    getCommittedSnapshot: () => null,
    prepareSnapshotRefresh: async () => refresh(snapshot([entry()])),
    isCurrent: () => true,
    ...overrides,
  };
}

function undoInput(
  overrides: Partial<Parameters<typeof reconcileInboxUndoResult>[0]> = {},
): Parameters<typeof reconcileInboxUndoResult>[0] {
  return {
    intent: undoIntent(),
    resultSnapshot: snapshot([]),
    commitResultSnapshot: () => false,
    getCommittedSnapshot: () => null,
    prepareSnapshotRefresh: async () => refresh(snapshot([])),
    isCurrent: () => true,
    ...overrides,
  };
}
