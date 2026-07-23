import type { Note, NoteSnapshot } from '../../shared/contracts';
import { normalizeInboxId } from '../../shared/inbox-domain';
import {
  normalizeNoteBody,
  normalizeNoteId,
  normalizeNoteRevision,
  normalizeNoteTitle,
} from '../../shared/note-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';

interface NoteRow {
  id: unknown;
  workspace_id: unknown;
  title: unknown;
  body: unknown;
  revision: unknown;
  source_inbox_entry_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
}

interface CountRow {
  count: unknown;
}

export interface NewNoteRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly body: string;
  readonly sourceInboxEntryId: string | null;
  readonly timestamp: string;
}

export interface StoredNote extends Note {
  readonly workspaceId: string;
  readonly archivedAt: string | null;
}

export class NoteRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  readSnapshot(workspaceId: string): NoteSnapshot {
    return {
      workspaceId,
      notes: this.#database
        .all<NoteRow>(
          `SELECT id, workspace_id, title, body, revision, source_inbox_entry_id,
                  created_at, updated_at, archived_at
           FROM notes
           WHERE workspace_id = ? AND archived_at IS NULL
           ORDER BY updated_at DESC, id DESC`,
          [workspaceId],
        )
        .map((row) => toPublicNote(mapNoteRow(row, workspaceId, false))),
    };
  }

  findActive(workspaceId: string, noteId: string): StoredNote | undefined {
    const row = this.#database.get<NoteRow>(
      `SELECT id, workspace_id, title, body, revision, source_inbox_entry_id,
              created_at, updated_at, archived_at
       FROM notes
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      [workspaceId, noteId],
    );
    return row ? mapNoteRow(row, workspaceId, false) : undefined;
  }

  insert(record: NewNoteRecord): void {
    this.#database.run(
      `INSERT INTO notes (
         id, workspace_id, title, body, revision, source_inbox_entry_id,
         created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
      [
        record.id,
        record.workspaceId,
        record.title,
        record.body,
        record.sourceInboxEntryId,
        record.timestamp,
        record.timestamp,
      ],
    );
  }

  update(
    workspaceId: string,
    noteId: string,
    expectedRevision: number,
    title: string,
    body: string,
    timestamp: string,
  ): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE notes
         SET title = ?, body = ?, revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND archived_at IS NULL AND revision = ?`,
        [title, body, timestamp, workspaceId, noteId, expectedRevision],
      ).changes,
      'updated',
    );
  }

  archive(workspaceId: string, noteId: string, expectedRevision: number, timestamp: string): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE notes
         SET revision = revision + 1, archived_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND archived_at IS NULL AND revision = ?`,
        [timestamp, timestamp, workspaceId, noteId, expectedRevision],
      ).changes,
      'archived',
    );
  }

  validateIntegrity(): void {
    const rows = this.#database.all<NoteRow>(
      `SELECT id, workspace_id, title, body, revision, source_inbox_entry_id,
              created_at, updated_at, archived_at
       FROM notes
       ORDER BY workspace_id, created_at, id`,
    );
    for (const row of rows) mapNoteRow(row, undefined, true);

    const activeSourceCount = this.#database.get<CountRow>(
      `SELECT COUNT(*) AS count
       FROM notes AS note
       JOIN inbox_entries AS inbox
         ON inbox.id = note.source_inbox_entry_id
        AND inbox.workspace_id = note.workspace_id
       WHERE note.source_inbox_entry_id IS NOT NULL
         AND inbox.archived_at IS NULL`,
    )?.count;
    if (readCount(activeSourceCount) !== 0) {
      throw new DatabaseIntegrityError('Note inbox source integrity is invalid.');
    }

    const reusedSourceCount = this.#database.get<CountRow>(
      `SELECT COUNT(*) AS count
       FROM notes AS note
       JOIN tasks AS task
         ON task.source_inbox_entry_id = note.source_inbox_entry_id
        AND task.workspace_id = note.workspace_id
       WHERE note.source_inbox_entry_id IS NOT NULL`,
    )?.count;
    if (readCount(reusedSourceCount) !== 0) {
      throw new DatabaseIntegrityError('An inbox source is linked to both a note and a task.');
    }
  }

  #assertChanged(value: unknown, operation: string): void {
    if (typeof value !== 'number' || Number(value) !== 1) {
      throw new DatabaseIntegrityError(`The note could not be ${operation}.`);
    }
  }
}

function mapNoteRow(
  row: NoteRow,
  expectedWorkspaceId: string | undefined,
  allowArchived: boolean,
): StoredNote {
  let id: string;
  let workspaceId: string;
  let title: string;
  let body: string;
  let revision: number;
  let sourceInboxEntryId: string | null;
  try {
    id = normalizeNoteId(row.id);
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    title = normalizeNoteTitle(row.title);
    body = normalizeNoteBody(row.body);
    revision = normalizeNoteRevision(row.revision);
    sourceInboxEntryId =
      row.source_inbox_entry_id === null ? null : normalizeInboxId(row.source_inbox_entry_id);
  } catch (error) {
    throw new DatabaseIntegrityError('Note row contains invalid values.', { cause: error });
  }
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new DatabaseIntegrityError('Note row belongs to an unexpected workspace.');
  }
  if (row.title !== title || row.body !== body) {
    throw new DatabaseIntegrityError('Note text normalization is invalid.');
  }
  if (!isIsoTimestamp(row.created_at) || !isIsoTimestamp(row.updated_at)) {
    throw new DatabaseIntegrityError('Note timestamps are invalid.');
  }
  if (row.updated_at < row.created_at) {
    throw new DatabaseIntegrityError('Note update time precedes its creation time.');
  }
  if (row.archived_at !== null && !isIsoTimestamp(row.archived_at)) {
    throw new DatabaseIntegrityError('Note archive timestamp is invalid.');
  }
  if (
    row.archived_at !== null &&
    (row.archived_at < row.created_at || row.updated_at < row.archived_at)
  ) {
    throw new DatabaseIntegrityError('Note archive timestamp ordering is invalid.');
  }
  if (!allowArchived && row.archived_at !== null) {
    throw new DatabaseIntegrityError('An archived note appeared in the active list.');
  }
  return {
    id,
    workspaceId,
    title,
    body,
    revision,
    sourceInboxEntryId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toPublicNote(note: StoredNote): Note {
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    revision: note.revision,
    sourceInboxEntryId: note.sourceInboxEntryId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function readCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DatabaseIntegrityError('SQLite returned an invalid note integrity count.');
  }
  return value;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
