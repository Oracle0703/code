import { describe, expect, it } from 'vitest';
import {
  filterNotes,
  isNoteDraftDirty,
  isNoteRequestLatest,
  isNoteSequenceCurrent,
  isNoteWorkspaceCurrent,
  noteExcerpt,
} from '../src/renderer/note-state';
import type { Note, NoteSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

const notes: readonly Note[] = [
  note('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '发布检查', '# Linux\n\n确认 Fuse 与 SQLite。'),
  note('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '会议记录', '讨论 Renderer 竞态。'),
];

describe('note renderer state', () => {
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
