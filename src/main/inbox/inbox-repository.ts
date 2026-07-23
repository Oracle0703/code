import { type InboxCategory, type InboxEntry, type InboxSnapshot } from '../../shared/contracts';
import {
  normalizeInboxCategory,
  normalizeInboxContent,
  normalizeInboxId,
} from '../../shared/inbox-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';

interface InboxRow {
  id: unknown;
  workspace_id: unknown;
  content: unknown;
  category: unknown;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
}

export interface NewInboxEntryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly content: string;
  readonly category: InboxCategory;
  readonly timestamp: string;
}

export interface StoredInboxEntry extends InboxEntry {
  readonly workspaceId: string;
  readonly archivedAt: string | null;
}

export class InboxRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  readSnapshot(workspaceId: string): InboxSnapshot {
    return {
      workspaceId,
      entries: this.#database
        .all<InboxRow>(
          `SELECT id, workspace_id, content, category, created_at, updated_at, archived_at
           FROM inbox_entries
           WHERE workspace_id = ? AND archived_at IS NULL
           ORDER BY created_at DESC, id DESC`,
          [workspaceId],
        )
        .map((row) => toPublicEntry(mapInboxRow(row, workspaceId, false))),
    };
  }

  findActive(workspaceId: string, entryId: string): StoredInboxEntry | undefined {
    const row = this.#database.get<InboxRow>(
      `SELECT id, workspace_id, content, category, created_at, updated_at, archived_at
       FROM inbox_entries
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      [workspaceId, entryId],
    );
    return row ? mapInboxRow(row, workspaceId, false) : undefined;
  }

  insert(record: NewInboxEntryRecord): void {
    this.#database.run(
      `INSERT INTO inbox_entries (
         id, workspace_id, content, category, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [
        record.id,
        record.workspaceId,
        record.content,
        record.category,
        record.timestamp,
        record.timestamp,
      ],
    );
  }

  categorize(
    workspaceId: string,
    entryId: string,
    category: InboxCategory,
    timestamp: string,
  ): void {
    const result = this.#database.run(
      `UPDATE inbox_entries
       SET category = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      [category, timestamp, workspaceId, entryId],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseIntegrityError('The active inbox entry could not be categorized.');
    }
  }

  archive(workspaceId: string, entryId: string, timestamp: string): void {
    const result = this.#database.run(
      `UPDATE inbox_entries
       SET archived_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      [timestamp, timestamp, workspaceId, entryId],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseIntegrityError('The active inbox entry could not be archived.');
    }
  }

  restore(workspaceId: string, entryId: string, archivedAt: string, timestamp: string): boolean {
    const result = this.#database.run(
      `UPDATE inbox_entries
       SET archived_at = NULL, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND archived_at = ?`,
      [timestamp, workspaceId, entryId, archivedAt],
    );
    return Number(result.changes) === 1;
  }

  validateIntegrity(): void {
    const rows = this.#database.all<InboxRow>(
      `SELECT id, workspace_id, content, category, created_at, updated_at, archived_at
       FROM inbox_entries
       ORDER BY workspace_id, created_at, id`,
    );
    for (const row of rows) {
      mapInboxRow(row, undefined, true);
    }
  }
}

function mapInboxRow(
  row: InboxRow,
  expectedWorkspaceId: string | undefined,
  allowArchived: boolean,
): StoredInboxEntry {
  let id: string;
  let workspaceId: string;
  let content: string;
  let category: InboxCategory;
  try {
    id = normalizeInboxId(row.id);
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    content = normalizeInboxContent(row.content);
    category = normalizeInboxCategory(row.category);
  } catch (error) {
    throw new DatabaseIntegrityError('Inbox row contains invalid values.', { cause: error });
  }
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new DatabaseIntegrityError('Inbox row belongs to an unexpected workspace.');
  }
  if (row.content !== content) {
    throw new DatabaseIntegrityError('Inbox content normalization is invalid.');
  }
  if (!isIsoTimestamp(row.created_at) || !isIsoTimestamp(row.updated_at)) {
    throw new DatabaseIntegrityError('Inbox timestamps are invalid.');
  }
  if (row.updated_at < row.created_at) {
    throw new DatabaseIntegrityError('Inbox update time precedes its creation time.');
  }
  if (row.archived_at !== null && !isIsoTimestamp(row.archived_at)) {
    throw new DatabaseIntegrityError('Inbox archive timestamp is invalid.');
  }
  if (row.archived_at !== null && row.archived_at < row.created_at) {
    throw new DatabaseIntegrityError('Inbox archive time precedes its creation time.');
  }
  if (row.archived_at !== null && row.updated_at < row.archived_at) {
    throw new DatabaseIntegrityError('Inbox update time precedes its archive time.');
  }
  if (!allowArchived && row.archived_at !== null) {
    throw new DatabaseIntegrityError('An archived inbox entry appeared in the active list.');
  }
  return {
    id,
    workspaceId,
    content,
    category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toPublicEntry(entry: StoredInboxEntry): InboxEntry {
  return {
    id: entry.id,
    content: entry.content,
    category: entry.category,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
