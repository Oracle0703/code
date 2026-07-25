import { describe, expect, it } from 'vitest';
import {
  countInboxEntries,
  createInboxRequestIdentity,
  createInboxWorkspaceIdentity,
  filterInboxEntries,
  inboxSnapshotForActivation,
  isInboxRequestCurrent,
  isInboxRequestLatest,
  isInboxSequenceCurrent,
  isInboxWorkspaceCurrent,
  shouldApplyInboxSnapshot,
} from '../src/renderer/inbox-state';
import type { InboxSnapshot } from '../src/shared/contracts';

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
