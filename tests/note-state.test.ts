import { describe, expect, it } from 'vitest';
import {
  convertedNoteFromResult,
  convertedNoteFromSnapshot,
  createdNoteFromResult,
  createNoteRequestIdentity,
  createNoteWorkspaceIdentity,
  filterNotes,
  isNoteDraftDirty,
  isNoteRequestCurrent,
  isNoteRequestLatest,
  isNoteSequenceCurrent,
  isNoteWorkspaceCurrent,
  noteSnapshotForActivation,
  noteExcerpt,
  shouldApplyNoteSnapshot,
} from '../src/renderer/note-state';
import type { Note, NoteCreateResult, NoteSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

const notes: readonly Note[] = [
  note('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '发布检查', '# Linux\n\n确认 Fuse 与 SQLite。'),
  note('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '会议记录', '讨论 Renderer 竞态。'),
];

describe('note renderer state', () => {
  it('resolves only the exact note identity returned by an inbox conversion', () => {
    const converted = {
      ...note('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '转换笔记', '正文'),
      sourceInboxEntryId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    const other = note('ffffffff-ffff-4fff-8fff-ffffffffffff', '其他笔记', '正文');
    const result = {
      noteSnapshot: { workspaceId: WORKSPACE_A, notes: [other, converted] },
      inboxSnapshot: { workspaceId: WORKSPACE_A, entries: [] },
      createdNoteId: converted.id,
    };

    expect(convertedNoteFromResult(WORKSPACE_A, converted.sourceInboxEntryId!, result)).toBe(
      converted,
    );
    expect(
      convertedNoteFromSnapshot(
        WORKSPACE_A,
        converted.sourceInboxEntryId!,
        converted.id,
        result.noteSnapshot,
      ),
    ).toBe(converted);
    expect(
      convertedNoteFromResult(WORKSPACE_A, converted.sourceInboxEntryId!, {
        ...result,
        createdNoteId: other.id,
      }),
    ).toBeNull();
    expect(convertedNoteFromResult(WORKSPACE_B, converted.sourceInboxEntryId!, result)).toBeNull();
    expect(
      convertedNoteFromSnapshot(WORKSPACE_A, converted.sourceInboxEntryId!, converted.id, {
        workspaceId: WORKSPACE_A,
        notes: [converted, { ...converted }],
      }),
    ).toBeNull();
    expect(
      convertedNoteFromSnapshot(
        WORKSPACE_A,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        converted.id,
        result.noteSnapshot,
      ),
    ).toBeNull();
    expect(
      convertedNoteFromResult(WORKSPACE_A, converted.sourceInboxEntryId!, {
        ...result,
        noteSnapshot: {
          workspaceId: WORKSPACE_A,
          notes: [converted, { ...converted }],
        },
      }),
    ).toBeNull();
  });

  it('uses activation identity to reject an old A request after A to B to A', () => {
    const firstA = createNoteWorkspaceIdentity(WORKSPACE_A);
    const oldRequest = createNoteRequestIdentity(firstA, 1);
    expect(oldRequest).not.toBeNull();
    if (!oldRequest) return;

    const identityB = createNoteWorkspaceIdentity(WORKSPACE_B);
    const currentA = createNoteWorkspaceIdentity(WORKSPACE_A);
    const currentRequest = createNoteRequestIdentity(currentA, 2);
    expect(currentRequest).not.toBeNull();
    if (!currentRequest) return;

    expect(identityB.workspaceId).toBe(WORKSPACE_B);
    expect(currentA).not.toBe(firstA);
    expect(isNoteRequestCurrent(currentA, oldRequest)).toBe(false);
    expect(isNoteRequestCurrent(currentA, currentRequest)).toBe(true);
    expect(shouldApplyNoteSnapshot(currentA, -1, oldRequest, snapshot())).toBe(false);
    expect(shouldApplyNoteSnapshot(currentA, -1, currentRequest, snapshot())).toBe(true);
  });

  it('binds stored snapshots and request validation to one activation', () => {
    const firstA = createNoteWorkspaceIdentity(WORKSPACE_A);
    const currentA = createNoteWorkspaceIdentity(WORKSPACE_A);
    const request = createNoteRequestIdentity(currentA, 7)!;
    const stored = { activation: firstA, snapshot: snapshot() };

    expect(noteSnapshotForActivation(firstA, stored)).toBe(stored.snapshot);
    expect(noteSnapshotForActivation(currentA, stored)).toBeNull();
    expect(shouldApplyNoteSnapshot(currentA, 7, request, snapshot())).toBe(false);
    expect(
      shouldApplyNoteSnapshot(currentA, -1, request, snapshot({ workspaceId: WORKSPACE_B })),
    ).toBe(false);
    expect(createNoteRequestIdentity(createNoteWorkspaceIdentity(null), 8)).toBeNull();
    expect(createNoteRequestIdentity(currentA, -1)).toBeNull();
  });

  it('selects only the exact Main-created note when multiple unfamiliar ids are returned', () => {
    const automationNote = note(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '并发自动化笔记',
      '不应被误认',
    );
    const assistantNote = note(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'AI 助手回复',
      '应按精确 ID 返回',
    );
    const result: NoteCreateResult = {
      noteSnapshot: snapshot({ notes: [automationNote, assistantNote] }),
      createdNoteId: assistantNote.id,
    };

    expect(createdNoteFromResult(WORKSPACE_A, result)).toBe(assistantNote);
    expect(
      createdNoteFromResult(WORKSPACE_A, {
        ...result,
        createdNoteId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }),
    ).toBeNull();
    expect(createdNoteFromResult(WORKSPACE_B, result)).toBeNull();
  });

  it('applies successful snapshots monotonically while failures must be latest', () => {
    expect(isNoteSequenceCurrent(4, 5)).toBe(false);
    expect(isNoteSequenceCurrent(5, 5)).toBe(true);
    expect(isNoteSequenceCurrent(6, 5)).toBe(true);
    expect(isNoteSequenceCurrent(4, 3)).toBe(true);

    expect(isNoteRequestLatest(4, 5)).toBe(false);
    expect(isNoteRequestLatest(5, 5)).toBe(true);
    expect(isNoteRequestLatest(6, 5)).toBe(false);
  });

  it('rejects a delayed snapshot from another workspace', () => {
    const snapshot: NoteSnapshot = { workspaceId: WORKSPACE_A, notes: [] };
    expect(isNoteWorkspaceCurrent(WORKSPACE_A, snapshot)).toBe(true);
    expect(isNoteWorkspaceCurrent(WORKSPACE_B, snapshot)).toBe(false);
    expect(isNoteWorkspaceCurrent(null, snapshot)).toBe(false);
  });

  it('searches title and Markdown body without changing source order', () => {
    expect(filterNotes(notes, ' sqlite ').map(({ title }) => title)).toEqual(['发布检查']);
    expect(filterNotes(notes, 'RENDERER').map(({ title }) => title)).toEqual(['会议记录']);
    expect(filterNotes(notes, '')).toBe(notes);
  });

  it('builds a plain Unicode-safe excerpt from Markdown', () => {
    expect(noteExcerpt('# 标题\n- **完成** [检查](https://example.com)', 7)).toBe('标题 完成 检…');
    expect(noteExcerpt('🙂🙂🙂', 2)).toBe('🙂🙂…');
    expect(noteExcerpt('```ts\nconst value = 1;\n```')).toBe('空白 Markdown 笔记');
    expect(() => noteExcerpt('正文', 0)).toThrow(TypeError);
  });

  it('marks only content that differs from the saved revision as dirty', () => {
    expect(isNoteDraftDirty(notes[0], notes[0]?.title ?? '', notes[0]?.body ?? '')).toBe(false);
    expect(isNoteDraftDirty(notes[0], '新标题', notes[0]?.body ?? '')).toBe(true);
    expect(isNoteDraftDirty(null, '', '')).toBe(false);
    expect(isNoteDraftDirty(null, '草稿', '')).toBe(true);
  });
});

function note(id: string, title: string, body: string): Note {
  return {
    id,
    title,
    body,
    revision: 1,
    sourceInboxEntryId: null,
    createdAt: '2026-07-22T12:00:00.000Z',
    updatedAt: '2026-07-22T12:00:00.000Z',
  };
}

function snapshot(overrides: Partial<NoteSnapshot> = {}): NoteSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    notes,
    ...overrides,
  };
}
