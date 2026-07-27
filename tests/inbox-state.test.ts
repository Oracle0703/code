import { describe, expect, it, vi } from 'vitest';
import {
  countInboxEntries,
  createdInboxEntryFromResult,
  createInboxRequestIdentity,
  createInboxWorkspaceIdentity,
  filterInboxEntries,
  inboxSnapshotForActivation,
  isInboxRequestCurrent,
  isInboxRequestLatest,
  isInboxSequenceCurrent,
  isInboxConversionSourceArchived,
  isInboxWorkspaceCurrent,
  reconcileInboxCreateResult,
  shouldApplyInboxSnapshot,
} from '../src/renderer/inbox-state';
import type { InboxCreateResult, InboxEntry, InboxSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('inbox renderer state', () => {
  it('binds requests to one activation object even across A to B to A', () => {
    const firstWorkspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createInboxWorkspaceIdentity(WORKSPACE_B);
    const secondWorkspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const request = createInboxRequestIdentity(firstWorkspaceA, 4);

    expect(firstWorkspaceA).not.toBe(secondWorkspaceA);
    expect(request).not.toBeNull();
    expect(request && isInboxRequestCurrent(firstWorkspaceA, request)).toBe(true);
    expect(request && isInboxRequestCurrent(workspaceB, request)).toBe(false);
    expect(request && isInboxRequestCurrent(secondWorkspaceA, request)).toBe(false);
  });

  it('rejects invalid request identities', () => {
    expect(createInboxRequestIdentity(createInboxWorkspaceIdentity(null), 1)).toBeNull();
    expect(createInboxRequestIdentity(createInboxWorkspaceIdentity(WORKSPACE_A), -1)).toBeNull();
    expect(
      createInboxRequestIdentity(createInboxWorkspaceIdentity(WORKSPACE_A), Number.NaN),
    ).toBeNull();
  });

  it('rejects an older response even when it belongs to the current workspace', () => {
    expect(isInboxSequenceCurrent(4, 5)).toBe(false);
    expect(isInboxSequenceCurrent(5, 5)).toBe(true);
    expect(isInboxSequenceCurrent(6, 5)).toBe(true);
  });

  it('accepts an older successful operation when the newer operation has no snapshot', () => {
    expect(isInboxSequenceCurrent(4, 3)).toBe(true);
  });

  it('rejects a stale success or failure after a newer request starts', () => {
    expect(isInboxRequestLatest(4, 5)).toBe(false);
    expect(isInboxRequestLatest(5, 5)).toBe(true);
    expect(isInboxRequestLatest(6, 5)).toBe(false);
  });

  it('rejects a delayed response from the previously active workspace', () => {
    const snapshot: InboxSnapshot = { workspaceId: WORKSPACE_A, entries: [] };
    expect(isInboxWorkspaceCurrent(WORKSPACE_B, snapshot)).toBe(false);
    expect(isInboxWorkspaceCurrent(WORKSPACE_A, snapshot)).toBe(true);
    expect(isInboxWorkspaceCurrent(null, snapshot)).toBe(false);
  });

  it('commits only a newer snapshot for the exact request activation and workspace', () => {
    const firstWorkspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const secondWorkspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const request = createInboxRequestIdentity(firstWorkspaceA, 5);
    const snapshot: InboxSnapshot = { workspaceId: WORKSPACE_A, entries: [] };
    const foreignSnapshot: InboxSnapshot = { workspaceId: WORKSPACE_B, entries: [] };

    expect(request).not.toBeNull();
    expect(request && shouldApplyInboxSnapshot(firstWorkspaceA, 4, request, snapshot)).toBe(true);
    expect(request && shouldApplyInboxSnapshot(firstWorkspaceA, 5, request, snapshot)).toBe(false);
    expect(request && shouldApplyInboxSnapshot(secondWorkspaceA, -1, request, snapshot)).toBe(
      false,
    );
    expect(request && shouldApplyInboxSnapshot(firstWorkspaceA, -1, request, foreignSnapshot)).toBe(
      false,
    );
  });

  it('reveals a stored snapshot only for the activation that committed it', () => {
    const firstWorkspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const secondWorkspaceA = createInboxWorkspaceIdentity(WORKSPACE_A);
    const snapshot: InboxSnapshot = { workspaceId: WORKSPACE_A, entries: [] };
    const state = { activation: firstWorkspaceA, snapshot };

    expect(inboxSnapshotForActivation(firstWorkspaceA, state)).toBe(snapshot);
    expect(inboxSnapshotForActivation(secondWorkspaceA, state)).toBeNull();
    expect(inboxSnapshotForActivation(createInboxWorkspaceIdentity(WORKSPACE_B), state)).toBeNull();
    expect(inboxSnapshotForActivation(firstWorkspaceA, null)).toBeNull();
  });

  it('resolves a created entry only by the Main-returned exact id and workspace', () => {
    const sameContent = '重复内容';
    const other: InboxEntry = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      content: sameContent,
      category: 'uncategorized',
      createdAt: '2026-07-25T12:00:00.000Z',
      updatedAt: '2026-07-25T12:00:00.000Z',
    };
    const created: InboxEntry = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      content: sameContent,
      category: 'uncategorized',
      createdAt: '2026-07-25T12:00:00.000Z',
      updatedAt: '2026-07-25T12:00:00.000Z',
    };
    const result: InboxCreateResult = {
      inboxSnapshot: { workspaceId: WORKSPACE_A, entries: [other, created] },
      createdEntryId: created.id,
    };

    expect(createdInboxEntryFromResult(WORKSPACE_A, result)).toBe(created);
    expect(
      createdInboxEntryFromResult(WORKSPACE_A, {
        ...result,
        createdEntryId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      }),
    ).toBeNull();
    expect(createdInboxEntryFromResult(WORKSPACE_B, result)).toBeNull();
    expect(
      createdInboxEntryFromResult(WORKSPACE_A, {
        ...result,
        inboxSnapshot: {
          workspaceId: WORKSPACE_A,
          entries: [created, { ...created }],
        },
      }),
    ).toBeNull();
  });

  it('confirms a converted source is absent only in the expected workspace snapshot', () => {
    const source = entry('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const other = entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

    expect(isInboxConversionSourceArchived(WORKSPACE_A, source.id, snapshot([other]))).toBe(true);
    expect(isInboxConversionSourceArchived(WORKSPACE_A, source.id, snapshot([source, other]))).toBe(
      false,
    );
    expect(
      isInboxConversionSourceArchived(WORKSPACE_A, source.id, {
        workspaceId: WORKSPACE_B,
        entries: [],
      }),
    ).toBe(false);
  });

  it('commits the inbox:create transaction snapshot without an extra read', async () => {
    const created = entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const commitResultSnapshot = vi.fn(() => true);
    const prepareSnapshotRefresh = vi.fn();

    await expect(
      reconcileInboxCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: resultFor(created),
        commitResultSnapshot,
        getCommittedEntry: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdEntry: created,
      committed: true,
      error: undefined,
    });
    expect(commitResultSnapshot).toHaveBeenCalledOnce();
    expect(prepareSnapshotRefresh).not.toHaveBeenCalled();
  });

  it('recovers on the second authoritative read after the first read fails', async () => {
    const created = entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const sameContent = entry('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const prepareSnapshotRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('internal path must not become UI text'))
      .mockResolvedValueOnce({
        snapshot: snapshot([sameContent, created]),
        commit: () => true,
      });

    await expect(
      reconcileInboxCreateResult({
        expectedWorkspaceId: WORKSPACE_A,
        result: resultFor(created),
        commitResultSnapshot: () => false,
        getCommittedEntry: () => null,
        prepareSnapshotRefresh,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      createdEntry: created,
      committed: true,
      error: expect.any(Error),
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('recovers when the first authoritative snapshot omits the exact id', async () => {
    const created = entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const sameContent = entry('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
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

    const reconciled = await reconcileInboxCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedEntry: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled).toEqual({
      createdEntry: created,
      committed: true,
      error: expect.any(Error),
    });
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('fails closed after two reads but accepts a newer exact entry in the final check', async () => {
    const created = entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot([created]),
      commit: () => false,
    }));
    let committedSnapshotChecks = 0;

    const reconciled = await reconcileInboxCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedEntry: () => {
        committedSnapshotChecks += 1;
        return committedSnapshotChecks === 3 ? created : null;
      },
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdEntry).toBe(created);
    expect(reconciled.committed).toBe(true);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
    expect(committedSnapshotChecks).toBe(3);
  });

  it('returns a bounded post-commit failure without matching duplicate content', async () => {
    const created = entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const sameContent = entry('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const prepareSnapshotRefresh = vi.fn(async () => ({
      snapshot: snapshot([sameContent]),
      commit: () => true,
    }));

    const reconciled = await reconcileInboxCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedEntry: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => true,
    });

    expect(reconciled.createdEntry).toBe(created);
    expect(reconciled.committed).toBe(false);
    expect(reconciled.error).toBeInstanceOf(Error);
    expect(prepareSnapshotRefresh).toHaveBeenCalledTimes(2);
  });

  it('stops reconciliation when the originating activation is superseded', async () => {
    const created = entry('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    let current = true;
    const prepareSnapshotRefresh = vi.fn(async () => {
      current = false;
      return {
        snapshot: snapshot([created]),
        commit: () => true,
      };
    });

    const reconciled = await reconcileInboxCreateResult({
      expectedWorkspaceId: WORKSPACE_A,
      result: resultFor(created),
      commitResultSnapshot: () => false,
      getCommittedEntry: () => null,
      prepareSnapshotRefresh,
      isCurrent: () => current,
    });

    expect(reconciled.createdEntry).toBe(created);
    expect(reconciled.committed).toBe(false);
    expect(prepareSnapshotRefresh).toHaveBeenCalledOnce();
  });

  it('derives every badge from the real active-entry snapshot', () => {
    expect(
      countInboxEntries([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          content: '未分类',
          category: 'uncategorized',
          createdAt: '2026-07-22T12:00:00.000Z',
          updatedAt: '2026-07-22T12:00:00.000Z',
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          content: '任务',
          category: 'task',
          createdAt: '2026-07-22T12:00:00.000Z',
          updatedAt: '2026-07-22T12:00:00.000Z',
        },
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          content: '链接',
          category: 'link',
          createdAt: '2026-07-22T12:00:00.000Z',
          updatedAt: '2026-07-22T12:00:00.000Z',
        },
      ]),
    ).toEqual({ total: 3, uncategorized: 1, task: 1, note: 0, link: 1 });
  });

  it('reveals an exact search target even when the internal query and filter hide it', () => {
    const entries = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        content: '发布检查',
        category: 'task',
        createdAt: '2026-07-22T12:00:00.000Z',
        updatedAt: '2026-07-22T12:00:00.000Z',
      },
      {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        content: '目标链接',
        category: 'link',
        createdAt: '2026-07-22T12:00:00.000Z',
        updatedAt: '2026-07-22T12:00:00.000Z',
      },
    ] as const;

    expect(filterInboxEntries(entries, '发布', 'task', entries[1].id)).toEqual(entries);
    expect(filterInboxEntries(entries, '发布', 'task', null)).toEqual([entries[0]]);
  });
});

function entry(id: string): InboxEntry {
  return {
    id,
    content: '重复内容',
    category: 'uncategorized',
    createdAt: '2026-07-25T12:00:00.000Z',
    updatedAt: '2026-07-25T12:00:00.000Z',
  };
}

function snapshot(entries: readonly InboxEntry[]): InboxSnapshot {
  return { workspaceId: WORKSPACE_A, entries };
}

function resultFor(created: InboxEntry): InboxCreateResult {
  return {
    inboxSnapshot: snapshot([created]),
    createdEntryId: created.id,
  };
}
