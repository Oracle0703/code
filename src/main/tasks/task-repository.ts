import type { Task, TaskSnapshot, TaskStatus } from '../../shared/contracts';
import {
  normalizeTaskCivilDate,
  normalizeTaskId,
  normalizeTaskStatus,
  normalizeTaskTitle,
} from '../../shared/task-domain';
import { normalizeInboxId } from '../../shared/inbox-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';

interface TaskRow {
  id: unknown;
  workspace_id: unknown;
  title: unknown;
  status: unknown;
  planned_for: unknown;
  source_inbox_entry_id: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

interface CountRow {
  count: unknown;
}

export interface NewTaskRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly plannedFor: string | null;
  readonly sourceInboxEntryId: string | null;
  readonly timestamp: string;
}

export interface StoredTask extends Task {
  readonly workspaceId: string;
}

export class TaskRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  readSnapshot(workspaceId: string, todayDate: string): TaskSnapshot {
    return {
      workspaceId,
      todayDate,
      tasks: this.#database
        .all<TaskRow>(
          `SELECT id, workspace_id, title, status, planned_for, source_inbox_entry_id,
                  created_at, updated_at, completed_at
           FROM tasks
           WHERE workspace_id = ?
           ORDER BY created_at DESC, id DESC`,
          [workspaceId],
        )
        .map((row) => toPublicTask(mapTaskRow(row, workspaceId))),
    };
  }

  find(workspaceId: string, taskId: string): StoredTask | undefined {
    const row = this.#database.get<TaskRow>(
      `SELECT id, workspace_id, title, status, planned_for, source_inbox_entry_id,
              created_at, updated_at, completed_at
       FROM tasks
       WHERE workspace_id = ? AND id = ?`,
      [workspaceId, taskId],
    );
    return row ? mapTaskRow(row, workspaceId) : undefined;
  }

  insert(record: NewTaskRecord): void {
    this.#database.run(
      `INSERT INTO tasks (
         id, workspace_id, title, status, planned_for, source_inbox_entry_id,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, NULL)`,
      [
        record.id,
        record.workspaceId,
        record.title,
        record.plannedFor,
        record.sourceInboxEntryId,
        record.timestamp,
        record.timestamp,
      ],
    );
  }

  rename(workspaceId: string, taskId: string, title: string, timestamp: string): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE tasks SET title = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
        [title, timestamp, workspaceId, taskId],
      ).changes,
      'renamed',
    );
  }

  updateStatus(workspaceId: string, taskId: string, status: TaskStatus, timestamp: string): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE tasks
         SET status = ?, updated_at = ?, completed_at = ?
         WHERE workspace_id = ? AND id = ?`,
        [status, timestamp, status === 'completed' ? timestamp : null, workspaceId, taskId],
      ).changes,
      'updated',
    );
  }

  updatePlanning(
    workspaceId: string,
    taskId: string,
    plannedFor: string | null,
    timestamp: string,
  ): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE tasks SET planned_for = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
        [plannedFor, timestamp, workspaceId, taskId],
      ).changes,
      'planned',
    );
  }

  validateIntegrity(): void {
    const rows = this.#database.all<TaskRow>(
      `SELECT id, workspace_id, title, status, planned_for, source_inbox_entry_id,
              created_at, updated_at, completed_at
       FROM tasks
       ORDER BY workspace_id, created_at, id`,
    );
    for (const row of rows) mapTaskRow(row, undefined);

    const invalidSourceCount = this.#database.get<CountRow>(
      `SELECT COUNT(*) AS count
       FROM tasks AS task
       JOIN inbox_entries AS inbox
         ON inbox.id = task.source_inbox_entry_id
        AND inbox.workspace_id = task.workspace_id
       WHERE task.source_inbox_entry_id IS NOT NULL
         AND inbox.archived_at IS NULL`,
    )?.count;
    if (
      typeof invalidSourceCount !== 'number' ||
      !Number.isSafeInteger(invalidSourceCount) ||
      invalidSourceCount !== 0
    ) {
      throw new DatabaseIntegrityError('Task inbox source integrity is invalid.');
    }
  }

  #assertChanged(value: unknown, operation: string): void {
    if (typeof value !== 'number' || Number(value) !== 1) {
      throw new DatabaseIntegrityError(`The task could not be ${operation}.`);
    }
  }
}

function mapTaskRow(row: TaskRow, expectedWorkspaceId: string | undefined): StoredTask {
  let id: string;
  let workspaceId: string;
  let title: string;
  let status: TaskStatus;
  let plannedFor: string | null;
  let sourceInboxEntryId: string | null;
  try {
    id = normalizeTaskId(row.id);
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    title = normalizeTaskTitle(row.title);
    status = normalizeTaskStatus(row.status);
    plannedFor = row.planned_for === null ? null : normalizeTaskCivilDate(row.planned_for);
    sourceInboxEntryId =
      row.source_inbox_entry_id === null ? null : normalizeInboxId(row.source_inbox_entry_id);
  } catch (error) {
    throw new DatabaseIntegrityError('Task row contains invalid values.', { cause: error });
  }
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new DatabaseIntegrityError('Task row belongs to an unexpected workspace.');
  }
  if (row.title !== title) {
    throw new DatabaseIntegrityError('Task title normalization is invalid.');
  }
  if (!isIsoTimestamp(row.created_at) || !isIsoTimestamp(row.updated_at)) {
    throw new DatabaseIntegrityError('Task timestamps are invalid.');
  }
  if (row.updated_at < row.created_at) {
    throw new DatabaseIntegrityError('Task update time precedes its creation time.');
  }
  if (row.completed_at !== null && !isIsoTimestamp(row.completed_at)) {
    throw new DatabaseIntegrityError('Task completion timestamp is invalid.');
  }
  if ((status === 'completed') !== (row.completed_at !== null)) {
    throw new DatabaseIntegrityError('Task completion state is inconsistent.');
  }
  if (row.completed_at !== null) {
    if (row.completed_at < row.created_at || row.updated_at < row.completed_at) {
      throw new DatabaseIntegrityError('Task completion timestamp ordering is invalid.');
    }
  }
  return {
    id,
    workspaceId,
    title,
    status,
    plannedFor,
    sourceInboxEntryId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toPublicTask(task: StoredTask): Task {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    plannedFor: task.plannedFor,
    sourceInboxEntryId: task.sourceInboxEntryId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
