import { describe, expect, it, vi } from 'vitest';
import type { InboxEntry, InboxSnapshot } from '../src/shared/contracts';
import {
  createInboxCaptureWorkspaceIdentity,
  inboxCaptureFeedbackKey,
  inboxCaptureNavigationError,
  inboxCaptureOpenFailed,
  inboxCaptureOpenFinished,
  inboxCaptureOpenStarted,
  inboxCaptureSyncRefreshError,
  InboxCaptureCoordinator,
  InboxCaptureEntryUnavailableError,
  InboxCaptureInProgressError,
  InboxCaptureOpenGate,
  InboxCapturePublicationGate,
  InboxCaptureSupersededError,
  InboxCaptureSyncRefreshError,
  resolveInboxCaptureNavigationTarget,
  resolveInboxCaptureSyncRefreshEntry,
  sameInboxCaptureFeedback,
  type InboxCaptureFeedback,
  type InboxCaptureSnapshotRefresh,
  type InboxCaptureWorkspaceIdentity,
} from '../src/renderer/inbox-capture-navigation';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const ENTRY_A = '33333333-3333-4333-8333-333333333333';
const ENTRY_B = '44444444-4444-4444-8444-444444444444';

describe('inbox capture navigation', () => {
  it('creates a distinct frozen identity for every workspace activation', () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);

    expect(firstA).toEqual(secondA);
    expect(firstA).not.toBe(secondA);
    expect(Object.isFrozen(firstA)).toBe(true);
    expect(createInboxCaptureWorkspaceIdentity(null)).toEqual({ workspaceId: null });
  });

  it('publishes only the latest committed capture with a complete frozen feedback identity', () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    expect(() => coordinator.beginCapture(createInboxCaptureWorkspaceIdentity(null))).toThrow(
      InboxCaptureSupersededError,
    );

    const older = coordinator.beginCapture(workspace);
    expect(() => coordinator.beginCapture(workspace)).toThrow(InboxCaptureInProgressError);
    coordinator.endCapture(older);
    const newer = coordinator.beginCapture(workspace);
    expect(coordinator.isCaptureCurrent(older, workspace)).toBe(false);
    expect(() => coordinator.createFeedback(older, workspace, entry(), true)).toThrow(
      InboxCaptureSupersededError,
    );

    const feedback = coordinator.createFeedback(newer, workspace, entry(), true);
    expect(feedback).toEqual({
      requestGeneration: newer.generation,
      workspaceId: WORKSPACE_A,
      createdEntryId: ENTRY_A,
      content: '整理发布清单',
      category: 'uncategorized',
    });
    expect(Object.isFrozen(feedback)).toBe(true);
    expect(inboxCaptureFeedbackKey(feedback)).toBe(
      JSON.stringify([newer.generation, WORKSPACE_A, ENTRY_A, '整理发布清单', 'uncategorized']),
    );
    expect(() => coordinator.createFeedback(newer, workspace, entry(), false)).toThrow(
      InboxCaptureSupersededError,
    );
    coordinator.endCapture(newer);
  });

  it('keeps the first capture single-flight and ignores an old finally after replacement', () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const first = coordinator.beginCapture(firstA);

    expect(() => coordinator.beginCapture(firstA)).toThrow(InboxCaptureInProgressError);
    coordinator.invalidate();
    const replacement = coordinator.beginCapture(secondA);
    coordinator.endCapture(first);
    expect(() => coordinator.beginCapture(secondA)).toThrow(InboxCaptureInProgressError);
    coordinator.endCapture(replacement);
    expect(() => coordinator.beginCapture(secondA)).not.toThrow();
  });

  it('recovers feedback only for the exact current capture generation', () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const intent = coordinator.beginCapture(firstA);
    coordinator.endCapture(intent);

    expect(coordinator.isGenerationCurrent(intent.generation, firstA)).toBe(true);
    const recovered = coordinator.createRecoveredFeedback(
      intent.generation,
      firstA,
      entry({ content: '权威重读内容', category: 'task' }),
      true,
    );
    expect(recovered).toEqual({
      requestGeneration: intent.generation,
      workspaceId: WORKSPACE_A,
      createdEntryId: ENTRY_A,
      content: '权威重读内容',
      category: 'task',
    });
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(coordinator.isGenerationCurrent(intent.generation, secondA)).toBe(false);
    expect(() =>
      coordinator.createRecoveredFeedback(intent.generation, firstA, entry(), false),
    ).toThrow(InboxCaptureSupersededError);

    const replacement = coordinator.beginCapture(firstA);
    expect(replacement.generation).toBeGreaterThan(intent.generation);
    expect(() =>
      coordinator.createRecoveredFeedback(intent.generation, firstA, entry(), true),
    ).toThrow(InboxCaptureSupersededError);
  });

  it('invalidates a warning refresh on page, overlay, workspace, or newer capture changes', () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const capture = coordinator.beginCapture(firstA);
    coordinator.endCapture(capture);
    const firstRefresh = coordinator.beginSyncRefresh(firstA, capture.generation);

    expect(coordinator.isSyncRefreshCurrent(firstRefresh, firstA)).toBe(true);
    expect(coordinator.isSyncRefreshCurrent(firstRefresh, secondA)).toBe(false);
    coordinator.cancelOpen();
    expect(coordinator.isSyncRefreshCurrent(firstRefresh, firstA)).toBe(false);

    const secondRefresh = coordinator.beginSyncRefresh(firstA, capture.generation);
    coordinator.beginCapture(firstA);
    expect(() => coordinator.assertSyncRefreshCurrent(secondRefresh, firstA)).toThrow(
      InboxCaptureSupersededError,
    );
    expect(() => coordinator.beginSyncRefresh(secondA, capture.generation)).toThrow(
      InboxCaptureSupersededError,
    );
  });

  it('reconciles a warning refresh only by one exact id and commits the authoritative snapshot', async () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const capture = coordinator.beginCapture(workspace);
    coordinator.endCapture(capture);
    const intent = coordinator.beginSyncRefresh(workspace, capture.generation);
    const created = entry({ content: '权威重读后的内容', category: 'link' });
    const commit = vi.fn(() => true);

    await expect(
      resolveInboxCaptureSyncRefreshEntry(
        intent,
        ENTRY_A,
        async () => refresh(snapshot({ entries: [entry({ id: ENTRY_B }), created] }), commit),
        () => coordinator.assertSyncRefreshCurrent(intent, workspace),
      ),
    ).resolves.toEqual(created);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('fails a warning refresh closed for missing, duplicate, stale, or uncommitted exact ids', async () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const capture = coordinator.beginCapture(workspace);
    coordinator.endCapture(capture);
    const intent = coordinator.beginSyncRefresh(workspace, capture.generation);
    const assertCurrent = () => coordinator.assertSyncRefreshCurrent(intent, workspace);
    const missingCommit = vi.fn(() => true);
    const duplicateCommit = vi.fn(() => true);
    const wrongWorkspaceCommit = vi.fn(() => true);

    await expect(
      resolveInboxCaptureSyncRefreshEntry(
        intent,
        ENTRY_A,
        async () => refresh(snapshot({ workspaceId: WORKSPACE_B }), wrongWorkspaceCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSyncRefreshError);
    expect(wrongWorkspaceCommit).not.toHaveBeenCalled();

    await expect(
      resolveInboxCaptureSyncRefreshEntry(
        intent,
        ENTRY_A,
        async () => refresh(snapshot({ entries: [] }), missingCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSyncRefreshError);
    expect(missingCommit).not.toHaveBeenCalled();

    await expect(
      resolveInboxCaptureSyncRefreshEntry(
        intent,
        ENTRY_A,
        async () => refresh(snapshot({ entries: [entry(), entry()] }), duplicateCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSyncRefreshError);
    expect(duplicateCommit).not.toHaveBeenCalled();

    await expect(
      resolveInboxCaptureSyncRefreshEntry(
        intent,
        ENTRY_A,
        async () => refresh(snapshot(), () => false),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSyncRefreshError);

    const staleCommit = vi.fn(() => true);
    await expect(
      resolveInboxCaptureSyncRefreshEntry(
        intent,
        ENTRY_A,
        async () => {
          coordinator.cancelOpen();
          return refresh(snapshot(), staleCommit);
        },
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSupersededError);
    expect(staleCommit).not.toHaveBeenCalled();

    const postCommitIntent = coordinator.beginSyncRefresh(workspace, capture.generation);
    const invalidatingCommit = vi.fn(() => {
      coordinator.cancelOpen();
      return true;
    });
    await expect(
      resolveInboxCaptureSyncRefreshEntry(
        postCommitIntent,
        ENTRY_A,
        async () => refresh(snapshot(), invalidatingCommit),
        () => coordinator.assertSyncRefreshCurrent(postCommitIntent, workspace),
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSupersededError);
    expect(invalidatingCommit).toHaveBeenCalledOnce();
  });

  it('rejects a delayed capture after invalidation or an A to B to A activation cycle', () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const intent = coordinator.beginCapture(firstA);

    expect(coordinator.isCaptureCurrent(intent, secondA)).toBe(false);
    expect(() => coordinator.createFeedback(intent, secondA, entry(), true)).toThrow(
      InboxCaptureSupersededError,
    );
    expect(coordinator.isCaptureCurrent(intent, firstA)).toBe(true);

    coordinator.invalidate();
    expect(coordinator.isCaptureCurrent(intent, firstA)).toBe(false);
    expect(() => coordinator.createFeedback(intent, firstA, entry(), true)).toThrow(
      InboxCaptureSupersededError,
    );
  });

  it('binds opening to the exact activation and every feedback field', () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);

    expect(coordinator.isOpenCurrent(intent, firstA, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, secondA, current)).toBe(false);
    for (const replacement of [
      { ...current, requestGeneration: current.requestGeneration + 1 },
      { ...current, workspaceId: WORKSPACE_B },
      { ...current, createdEntryId: ENTRY_B },
      { ...current, content: '较新的内容' },
      { ...current, category: 'link' as const },
    ]) {
      expect(coordinator.isOpenCurrent(intent, firstA, replacement)).toBe(false);
    }
    expect(sameInboxCaptureFeedback(current, { ...current })).toBe(true);
    expect(sameInboxCaptureFeedback(current, null)).toBe(false);
    expect(() =>
      coordinator.beginOpen(createInboxCaptureWorkspaceIdentity(WORKSPACE_B), current),
    ).toThrow(InboxCaptureSupersededError);
  });

  it('makes a newer capture supersede old feedback and an open already in flight', () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const original = publishedFeedback(coordinator, workspace);
    const openIntent = coordinator.beginOpen(workspace, original);
    const newerCapture = coordinator.beginCapture(workspace);

    expect(coordinator.isFeedbackCurrent(workspace, original, original)).toBe(false);
    expect(coordinator.isOpenCurrent(openIntent, workspace, original)).toBe(false);
    expect(() => coordinator.assertOpenCurrent(openIntent, workspace, original)).toThrow(
      InboxCaptureSupersededError,
    );

    const newer = coordinator.createFeedback(newerCapture, workspace, entry({ id: ENTRY_B }), true);
    expect(newer.requestGeneration).toBeGreaterThan(original.requestGeneration);
    expect(coordinator.isFeedbackCurrent(workspace, newer, newer)).toBe(true);
    coordinator.endCapture(newerCapture);
  });

  it('cancels only an in-flight open when the page changes and keeps feedback reusable', () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const originalOpen = coordinator.beginOpen(workspace, current);

    coordinator.cancelOpen();
    expect(coordinator.isOpenCurrent(originalOpen, workspace, current)).toBe(false);
    expect(coordinator.isFeedbackCurrent(workspace, current, current)).toBe(true);
    expect(() => coordinator.beginOpen(workspace, current)).not.toThrow();
  });

  it('dismisses only the complete current feedback and invalidates its open intent', () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);

    expect(coordinator.dismiss({ ...current, content: '其他内容' }, workspace, current)).toBe(
      false,
    );
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(true);
    expect(coordinator.dismiss(current, workspace, current)).toBe(true);
    expect(coordinator.isOpenCurrent(intent, workspace, current)).toBe(false);
    expect(coordinator.dismiss(current, workspace, current)).toBe(false);
  });

  it('fresh-reads, commits, and returns only the exact created entry id', async () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);
    const readInbox = vi.fn(async () =>
      refresh(
        snapshot({
          entries: [
            entry({
              id: ENTRY_B,
              content: current.content,
              createdAt: '2026-07-25T12:00:00.000Z',
            }),
            entry({
              id: ENTRY_A,
              content: '创建后已重新分类',
              category: 'task',
              updatedAt: '2026-07-25T12:01:00.000Z',
            }),
          ],
        }),
        commit,
      ),
    );

    await expect(
      resolveInboxCaptureNavigationTarget(intent, readInbox, () =>
        coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      entry: {
        id: ENTRY_A,
        content: '创建后已重新分类',
        category: 'task',
      },
    });
    expect(readInbox).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('never falls back by content, category, timestamp, or list position when the id is missing', async () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const commit = vi.fn(() => true);

    await expect(
      resolveInboxCaptureNavigationTarget(
        intent,
        async () =>
          refresh(
            snapshot({
              entries: [
                entry({
                  id: ENTRY_B,
                  content: current.content,
                  category: current.category,
                  createdAt: '2026-07-25T12:00:00.000Z',
                  updatedAt: '2026-07-25T12:00:00.000Z',
                }),
              ],
            }),
            commit,
          ),
        () => coordinator.assertOpenCurrent(intent, workspace, current),
      ),
    ).rejects.toBeInstanceOf(InboxCaptureEntryUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('treats an archived target, a wrong workspace, and commit=false as unavailable or stale', async () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    const assertCurrent = () => coordinator.assertOpenCurrent(intent, workspace, current);
    const archivedCommit = vi.fn(() => true);
    const wrongWorkspaceCommit = vi.fn(() => true);

    await expect(
      resolveInboxCaptureNavigationTarget(
        intent,
        async () => refresh(snapshot({ entries: [] }), archivedCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureEntryUnavailableError);
    expect(archivedCommit).not.toHaveBeenCalled();

    await expect(
      resolveInboxCaptureNavigationTarget(
        intent,
        async () => refresh(snapshot({ workspaceId: WORKSPACE_B }), wrongWorkspaceCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureEntryUnavailableError);
    expect(wrongWorkspaceCommit).not.toHaveBeenCalled();

    await expect(
      resolveInboxCaptureNavigationTarget(
        intent,
        async () => refresh(snapshot(), () => false),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSupersededError);
  });

  it('rejects a delayed read after A to B to A, dismiss, or a newer capture', async () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, firstA);
    const intent = coordinator.beginOpen(firstA, current);
    let currentWorkspace: InboxCaptureWorkspaceIdentity = firstA;
    let currentFeedback: InboxCaptureFeedback | null = current;
    let release!: (value: InboxCaptureSnapshotRefresh) => void;
    const delayed = new Promise<InboxCaptureSnapshotRefresh>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(() => true);
    const resolution = resolveInboxCaptureNavigationTarget(
      intent,
      () => delayed,
      () => coordinator.assertOpenCurrent(intent, currentWorkspace, currentFeedback),
    );

    currentWorkspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_B);
    currentWorkspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    currentFeedback = null;
    coordinator.beginCapture(currentWorkspace);
    release(refresh(snapshot(), commit));

    await expect(resolution).rejects.toBeInstanceOf(InboxCaptureSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not return a target when state changes during the authoritative commit', async () => {
    const workspace = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new InboxCaptureCoordinator();
    const current = publishedFeedback(coordinator, workspace);
    const intent = coordinator.beginOpen(workspace, current);
    let currentFeedback: InboxCaptureFeedback | null = current;
    const commit = vi.fn(() => {
      currentFeedback = null;
      coordinator.invalidate();
      return true;
    });

    await expect(
      resolveInboxCaptureNavigationTarget(
        intent,
        async () => refresh(snapshot(), commit),
        () => coordinator.assertOpenCurrent(intent, workspace, currentFeedback),
      ),
    ).rejects.toBeInstanceOf(InboxCaptureSupersededError);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('gates duplicate opens without letting a late end release a replacement lease', () => {
    const original = feedback();
    const equalReplacement = { ...original };
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      createdEntryId: ENTRY_B,
    });
    const gate = new InboxCaptureOpenGate();

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

  it('publishes a staged dialog result once and only to the same activation', () => {
    const firstA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const secondA = createInboxCaptureWorkspaceIdentity(WORKSPACE_A);
    const workspaceB = createInboxCaptureWorkspaceIdentity(WORKSPACE_B);
    const gate = new InboxCapturePublicationGate<{ readonly kind: string }>();
    const success = Object.freeze({ kind: 'success' });

    gate.stage(firstA, success);
    expect(gate.take(true, firstA)).toBeNull();
    expect(gate.take(false, secondA)).toBeNull();
    expect(gate.take(false, firstA)).toBeNull();

    gate.stage(firstA, success);
    expect(gate.take(false, workspaceB)).toBeNull();
    gate.stage(firstA, success);
    gate.clear();
    expect(gate.take(false, firstA)).toBeNull();
    gate.stage(firstA, success);
    expect(gate.take(false, firstA)).toBe(success);
    expect(gate.take(false, firstA)).toBeNull();
  });

  it('ignores late failure and finally reducers after newer feedback replaces the state', () => {
    const original = feedback();
    const newer = feedback({
      requestGeneration: original.requestGeneration + 1,
      createdEntryId: ENTRY_B,
      content: '较新的记录',
      category: 'link',
    });
    const originalState = inboxCaptureOpenStarted(original);
    const newerState = inboxCaptureOpenStarted(newer);

    expect(inboxCaptureFeedbackKey(original)).not.toBe(inboxCaptureFeedbackKey(newer));
    expect(inboxCaptureOpenFailed(originalState, original, '打开失败', 'original-error')).toEqual({
      feedbackKey: inboxCaptureFeedbackKey(original),
      opening: false,
      error: '打开失败',
      errorFocusKey: 'original-error',
    });
    expect(inboxCaptureOpenFailed(newerState, original, '旧失败', 'stale-error')).toBe(newerState);
    expect(inboxCaptureOpenFinished(newerState, original)).toBe(newerState);
    expect(inboxCaptureOpenFinished(newerState, newer)).toEqual({
      feedbackKey: inboxCaptureFeedbackKey(newer),
      opening: false,
      error: null,
      errorFocusKey: null,
    });
  });

  it('preserves typed failures while bounding unknown remote errors', () => {
    const superseded = new InboxCaptureSupersededError();
    const unavailable = new InboxCaptureEntryUnavailableError();
    expect(inboxCaptureNavigationError(superseded)).toBe(superseded);
    expect(inboxCaptureNavigationError(unavailable)).toBe(unavailable);

    const known = inboxCaptureNavigationError(
      new Error("Error invoking remote method 'inbox:get-snapshot': 该记录已归档，当前不可用。"),
    );
    expect(known.message).toBe('该记录已归档，当前不可用。');

    const unknown = inboxCaptureNavigationError(new Error('secret provider details'));
    expect(unknown.message).toBe('无法打开刚创建的收件箱记录，请重试。');
    expect(unknown.message).not.toContain('secret');
  });

  it('bounds warning refresh failures without exposing provider details', () => {
    const superseded = new InboxCaptureSupersededError();
    const unavailable = new InboxCaptureSyncRefreshError('重新读取后仍无法确认。');
    const mappedSuperseded = inboxCaptureSyncRefreshError(superseded);
    expect(mappedSuperseded).toBeInstanceOf(InboxCaptureSyncRefreshError);
    expect(mappedSuperseded.message).toContain('请不要重复添加');
    expect(inboxCaptureSyncRefreshError(unavailable)).toBe(unavailable);

    const unknown = inboxCaptureSyncRefreshError(new Error('secret sqlite details'));
    expect(unknown).toBeInstanceOf(InboxCaptureSyncRefreshError);
    expect(unknown.message).toContain('请不要重复添加');
    expect(unknown.message).not.toContain('secret');
  });
});

function publishedFeedback(
  coordinator: InboxCaptureCoordinator,
  workspace: InboxCaptureWorkspaceIdentity,
): InboxCaptureFeedback {
  const intent = coordinator.beginCapture(workspace);
  const current = coordinator.createFeedback(intent, workspace, entry(), true);
  coordinator.endCapture(intent);
  return current;
}

function feedback(overrides: Partial<InboxCaptureFeedback> = {}): InboxCaptureFeedback {
  return Object.freeze({
    requestGeneration: 7,
    workspaceId: WORKSPACE_A,
    createdEntryId: ENTRY_A,
    content: '整理发布清单',
    category: 'uncategorized',
    ...overrides,
  });
}

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: ENTRY_A,
    content: '整理发布清单',
    category: 'uncategorized',
    createdAt: '2026-07-25T12:00:00.000Z',
    updatedAt: '2026-07-25T12:00:00.000Z',
    ...overrides,
  };
}

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    entries: [entry()],
    ...overrides,
  };
}

function refresh(
  inboxSnapshot: InboxSnapshot,
  commit: () => boolean = () => true,
): InboxCaptureSnapshotRefresh {
  return { snapshot: inboxSnapshot, commit };
}
