import { describe, expect, it, vi } from 'vitest';
import type { AssistantSnapshot, NoteSnapshot } from '../src/shared/contracts';
import {
  assistantResponseKey,
  assistantSavedNoteMatchesResponse,
  assistantSavedNoteOpenFailed,
  assistantSavedNoteOpenFinished,
  assistantSavedNoteOpenStarted,
  AssistantSavedNoteNavigationCoordinator,
  AssistantSavedNoteOpenGate,
  AssistantSavedNoteSaveGate,
  AssistantSavedNoteSupersededError,
  AssistantSavedNoteUnavailableError,
  createAssistantWorkspaceIdentity,
  resolveAssistantSavedNoteNavigationTarget,
  type AssistantSavedNoteSnapshotRefresh,
  type AssistantSavedNoteTarget,
  type AssistantWorkspaceIdentity,
} from '../src/renderer/assistant-saved-note-navigation';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const RUN_A = '33333333-3333-4333-8333-333333333333';
const RUN_B = '44444444-4444-4444-8444-444444444444';
const NOTE_A = '55555555-5555-4555-8555-555555555555';
const NOTE_B = '66666666-6666-4666-8666-666666666666';

describe('assistant saved note navigation', () => {
  it('keys a response by workspace and run id, with a typed sequence fallback', () => {
    const running = assistantSnapshot({ sequence: 4, runId: RUN_A, phase: 'running' });
    const completed = assistantSnapshot({ sequence: 9, runId: RUN_A, phase: 'completed' });
    expect(assistantResponseKey(null)).toBeNull();
    expect(assistantResponseKey(running)).toBe(assistantResponseKey(completed));
    expect(assistantResponseKey(completed)).not.toBe(
      assistantResponseKey(assistantSnapshot({ runId: RUN_B })),
    );
    expect(assistantResponseKey(completed)).not.toBe(
      assistantResponseKey(assistantSnapshot({ workspaceId: WORKSPACE_B, runId: RUN_A })),
    );

    const sequenceFour = assistantResponseKey(assistantSnapshot({ sequence: 4, runId: null }));
    expect(sequenceFour).toBe(
      assistantResponseKey(assistantSnapshot({ sequence: 4, runId: null, phase: 'completed' })),
    );
    expect(sequenceFour).not.toBe(
      assistantResponseKey(assistantSnapshot({ sequence: 5, runId: null })),
    );
    expect(sequenceFour).not.toBe(
      assistantResponseKey(assistantSnapshot({ sequence: 4, runId: '4' })),
    );
  });

  it('matches only the complete response key and creates a new activation identity each time', () => {
    const responseKey = assistantResponseKey(assistantSnapshot());
    const target = savedTarget({ responseKey });
    expect(assistantSavedNoteMatchesResponse(target, responseKey)).toBe(true);
    expect(
      assistantSavedNoteMatchesResponse(
        target,
        assistantResponseKey(assistantSnapshot({ runId: RUN_B })),
      ),
    ).toBe(false);
    expect(assistantSavedNoteMatchesResponse(target, null)).toBe(false);
    expect(assistantSavedNoteMatchesResponse(null, responseKey)).toBe(false);

    const first = createAssistantWorkspaceIdentity(WORKSPACE_A);
    const second = createAssistantWorkspaceIdentity(WORKSPACE_A);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('keeps every in-flight save and open key gated until its own operation ends', () => {
    const firstResponse = assistantResponseKey(assistantSnapshot({ runId: RUN_A }));
    const secondResponse = assistantResponseKey(assistantSnapshot({ runId: RUN_B }));
    const saveGate = new AssistantSavedNoteSaveGate();
    expect(saveGate.begin(firstResponse)).toBe(true);
    expect(saveGate.begin(firstResponse)).toBe(false);
    expect(saveGate.begin(secondResponse)).toBe(true);
    expect(saveGate.begin(firstResponse)).toBe(false);
    saveGate.end(firstResponse);
    expect(saveGate.begin(firstResponse)).toBe(true);
    expect(saveGate.begin(secondResponse)).toBe(false);

    const firstTarget = savedTarget({ responseKey: firstResponse, noteId: NOTE_A });
    const secondTarget = savedTarget({ responseKey: secondResponse, noteId: NOTE_B });
    const openGate = new AssistantSavedNoteOpenGate();
    expect(openGate.begin(firstTarget)).toBe(true);
    expect(openGate.begin({ ...firstTarget })).toBe(false);
    expect(openGate.begin(secondTarget)).toBe(true);
    openGate.end(firstTarget);
    expect(openGate.begin(firstTarget)).toBe(true);
    expect(openGate.begin(secondTarget)).toBe(false);
  });

  it('binds an intent to the exact activation, assistant surface, response, and saved target', () => {
    const responseKey = assistantResponseKey(assistantSnapshot());
    const target = savedTarget({ responseKey });
    const firstA = createAssistantWorkspaceIdentity(WORKSPACE_A);
    const secondA = createAssistantWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AssistantSavedNoteNavigationCoordinator();
    const intent = coordinator.begin(firstA, target);

    expect(coordinator.isCurrent(intent, firstA, 'assistant', responseKey, target)).toBe(true);
    expect(coordinator.isCurrent(intent, secondA, 'assistant', responseKey, target)).toBe(false);
    expect(coordinator.isCurrent(intent, firstA, 'notes', responseKey, target)).toBe(false);
    expect(
      coordinator.isCurrent(
        intent,
        firstA,
        'assistant',
        assistantResponseKey(assistantSnapshot({ runId: RUN_B })),
        target,
      ),
    ).toBe(false);
    expect(
      coordinator.isCurrent(intent, firstA, 'assistant', responseKey, {
        ...target,
        noteId: NOTE_B,
      }),
    ).toBe(false);
    expect(() =>
      coordinator.assertCurrent(intent, firstA, 'assistant', responseKey, {
        ...target,
        noteTitle: '较新的保存结果',
      }),
    ).toThrow(AssistantSavedNoteSupersededError);

    coordinator.invalidate();
    expect(coordinator.isCurrent(intent, firstA, 'assistant', responseKey, target)).toBe(false);
    expect(() =>
      coordinator.begin(
        createAssistantWorkspaceIdentity(WORKSPACE_B),
        savedTarget({ workspaceId: WORKSPACE_A }),
      ),
    ).toThrow(AssistantSavedNoteSupersededError);
  });

  it('fresh-reads, commits, and returns only the exact opaque note id', async () => {
    const responseKey = assistantResponseKey(assistantSnapshot());
    const target = savedTarget({ responseKey });
    const workspace = createAssistantWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AssistantSavedNoteNavigationCoordinator();
    const intent = coordinator.begin(workspace, target);
    const commit = vi.fn(() => true);
    const readNotes = vi.fn(async () => refresh(noteSnapshot(), commit));
    const assertCurrent = () =>
      coordinator.assertCurrent(intent, workspace, 'assistant', responseKey, target);

    await expect(
      resolveAssistantSavedNoteNavigationTarget(intent, readNotes, assertCurrent),
    ).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      note: { id: NOTE_A, title: 'AI 助手回复' },
    });
    expect(readNotes).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('does not fall back by title or list position when the exact note is missing', async () => {
    const responseKey = assistantResponseKey(assistantSnapshot());
    const target = savedTarget({ responseKey });
    const workspace = createAssistantWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AssistantSavedNoteNavigationCoordinator();
    const intent = coordinator.begin(workspace, target);
    const commit = vi.fn(() => true);

    await expect(
      resolveAssistantSavedNoteNavigationTarget(
        intent,
        async () =>
          refresh(
            noteSnapshot({
              notes: [
                {
                  ...noteSnapshot().notes[0]!,
                  id: NOTE_B,
                  title: target.noteTitle,
                },
              ],
            }),
            commit,
          ),
        () => coordinator.assertCurrent(intent, workspace, 'assistant', responseKey, target),
      ),
    ).rejects.toBeInstanceOf(AssistantSavedNoteUnavailableError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects a mismatched workspace and a snapshot superseded before commit', async () => {
    const responseKey = assistantResponseKey(assistantSnapshot());
    const target = savedTarget({ responseKey });
    const workspace = createAssistantWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AssistantSavedNoteNavigationCoordinator();
    const intent = coordinator.begin(workspace, target);
    const assertCurrent = () =>
      coordinator.assertCurrent(intent, workspace, 'assistant', responseKey, target);
    const mismatchedCommit = vi.fn(() => true);

    await expect(
      resolveAssistantSavedNoteNavigationTarget(
        intent,
        async () => refresh(noteSnapshot({ workspaceId: WORKSPACE_B }), mismatchedCommit),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(AssistantSavedNoteUnavailableError);
    expect(mismatchedCommit).not.toHaveBeenCalled();

    await expect(
      resolveAssistantSavedNoteNavigationTarget(
        intent,
        async () => refresh(noteSnapshot(), () => false),
        assertCurrent,
      ),
    ).rejects.toBeInstanceOf(AssistantSavedNoteSupersededError);
  });

  it('rejects a delayed read after an A to B to A activation cycle', async () => {
    const responseKey = assistantResponseKey(assistantSnapshot());
    const target = savedTarget({ responseKey });
    const firstA = createAssistantWorkspaceIdentity(WORKSPACE_A);
    const coordinator = new AssistantSavedNoteNavigationCoordinator();
    const intent = coordinator.begin(firstA, target);
    let currentWorkspace: AssistantWorkspaceIdentity = firstA;
    let release!: (refresh: AssistantSavedNoteSnapshotRefresh) => void;
    const delayed = new Promise<AssistantSavedNoteSnapshotRefresh>((resolve) => {
      release = resolve;
    });
    const commit = vi.fn(() => true);
    const resolution = resolveAssistantSavedNoteNavigationTarget(
      intent,
      () => delayed,
      () => coordinator.assertCurrent(intent, currentWorkspace, 'assistant', responseKey, target),
    );

    currentWorkspace = createAssistantWorkspaceIdentity(WORKSPACE_B);
    currentWorkspace = createAssistantWorkspaceIdentity(WORKSPACE_A);
    release(refresh(noteSnapshot(), commit));

    await expect(resolution).rejects.toBeInstanceOf(AssistantSavedNoteSupersededError);
    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores late opening state writes for a newer saved target', () => {
    const first = savedTarget({
      responseKey: assistantResponseKey(assistantSnapshot({ runId: RUN_A })),
      noteId: NOTE_A,
    });
    const second = savedTarget({
      responseKey: assistantResponseKey(assistantSnapshot({ runId: RUN_B })),
      noteId: NOTE_B,
    });
    const firstState = assistantSavedNoteOpenStarted(first);
    const secondState = assistantSavedNoteOpenStarted(second);

    expect(assistantSavedNoteOpenFailed(firstState, first, '打开失败')).toMatchObject({
      opening: false,
      error: '打开失败',
    });
    expect(assistantSavedNoteOpenFailed(secondState, first, '旧失败')).toBe(secondState);
    expect(assistantSavedNoteOpenFinished(secondState, first)).toBe(secondState);
    expect(assistantSavedNoteOpenFinished(secondState, second)).toMatchObject({
      opening: false,
      error: null,
    });
  });
});

function assistantSnapshot(overrides: Partial<AssistantSnapshot> = {}): AssistantSnapshot {
  return {
    sequence: 7,
    workspaceId: WORKSPACE_A,
    phase: 'completed',
    runId: RUN_A,
    prompt: '整理发布计划',
    context: { kind: 'none' },
    contextSummary: {
      kind: 'none',
      label: '仅发送问题',
      includedCount: 0,
      totalCount: 0,
      truncated: false,
    },
    response: '# 发布计划',
    startedAt: '2026-07-25T12:00:00.000Z',
    completedAt: '2026-07-25T12:01:00.000Z',
    error: null,
    ...overrides,
  };
}

function savedTarget(overrides: Partial<AssistantSavedNoteTarget> = {}): AssistantSavedNoteTarget {
  return {
    responseKey: assistantResponseKey(assistantSnapshot()),
    workspaceId: WORKSPACE_A,
    noteId: NOTE_A,
    noteTitle: 'AI 助手回复',
    ...overrides,
  };
}

function noteSnapshot(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    notes: [
      {
        id: NOTE_A,
        title: 'AI 助手回复',
        body: '# 发布计划',
        revision: 1,
        sourceInboxEntryId: null,
        createdAt: '2026-07-25T12:01:00.000Z',
        updatedAt: '2026-07-25T12:01:00.000Z',
      },
    ],
    ...overrides,
  };
}

function refresh(
  snapshot: NoteSnapshot,
  commit: () => boolean = () => true,
): AssistantSavedNoteSnapshotRefresh {
  return { snapshot, commit };
}
