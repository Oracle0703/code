import type { Note, NoteSnapshot } from '../shared/contracts';

export function isNoteSequenceCurrent(sequence: number, lastAppliedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence >= lastAppliedSequence;
}

export function isNoteRequestLatest(sequence: number, latestRequestedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function isNoteWorkspaceCurrent(
  activeWorkspaceId: string | null,
  snapshot: NoteSnapshot,
): boolean {
  return activeWorkspaceId !== null && snapshot.workspaceId === activeWorkspaceId;
}

export function filterNotes(notes: readonly Note[], query: string): readonly Note[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return notes;
  return notes.filter((note) =>
    `${note.title}\n${note.body}`.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function noteExcerpt(body: string, maximumLength = 180): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    throw new TypeError('Note excerpt length must be a positive safe integer.');
  }
  const plainText = body
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]\s|\d+[.)]\s)/gmu, '')
    .replace(/[*_~`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!plainText) return '空白 Markdown 笔记';
  const characters = Array.from(plainText);
  return characters.length > maximumLength
    ? `${characters.slice(0, maximumLength).join('')}…`
    : plainText;
}

export function isNoteDraftDirty(
  note: Pick<Note, 'title' | 'body'> | null,
  title: string,
  body: string,
): boolean {
  return title !== (note?.title ?? '') || body !== (note?.body ?? '');
}
