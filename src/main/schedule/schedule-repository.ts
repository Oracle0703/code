import type { ScheduleItem, ScheduleKind, ScheduleSnapshot } from '../../shared/contracts';
import {
  normalizeScheduleCivilDate,
  normalizeScheduleId,
  normalizeScheduleKind,
  normalizeScheduleRange,
  normalizeScheduleRevision,
  normalizeScheduleTitle,
} from '../../shared/schedule-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';

interface ScheduleRow {
  id: unknown;
  workspace_id: unknown;
  title: unknown;
  kind: unknown;
  scheduled_for: unknown;
  start_minute: unknown;
  end_minute: unknown;
  revision: unknown;
  created_at: unknown;
  updated_at: unknown;
  archived_at: unknown;
}

export interface NewScheduleRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly kind: ScheduleKind;
  readonly scheduledFor: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly timestamp: string;
}

export interface StoredScheduleItem extends ScheduleItem {
  readonly workspaceId: string;
  readonly archivedAt: string | null;
}

export class ScheduleRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  readSnapshot(workspaceId: string, todayDate: string): ScheduleSnapshot {
    return {
      workspaceId,
      todayDate,
      items: this.#database
        .all<ScheduleRow>(
          `SELECT id, workspace_id, title, kind, scheduled_for, start_minute, end_minute,
                  revision, created_at, updated_at, archived_at
           FROM schedule_items
           WHERE workspace_id = ? AND scheduled_for = ? AND archived_at IS NULL
           ORDER BY start_minute, end_minute, id`,
          [workspaceId, todayDate],
        )
        .map((row) => toPublicItem(mapScheduleRow(row, workspaceId, false))),
    };
  }

  findActive(
    workspaceId: string,
    scheduleId: string,
    scheduledFor: string,
  ): StoredScheduleItem | undefined {
    const row = this.#database.get<ScheduleRow>(
      `SELECT id, workspace_id, title, kind, scheduled_for, start_minute, end_minute,
              revision, created_at, updated_at, archived_at
       FROM schedule_items
       WHERE workspace_id = ? AND id = ? AND scheduled_for = ? AND archived_at IS NULL`,
      [workspaceId, scheduleId, scheduledFor],
    );
    return row ? mapScheduleRow(row, workspaceId, false) : undefined;
  }

  insert(record: NewScheduleRecord): void {
    this.#database.run(
      `INSERT INTO schedule_items (
         id, workspace_id, title, kind, scheduled_for, start_minute, end_minute,
         revision, created_at, updated_at, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      [
        record.id,
        record.workspaceId,
        record.title,
        record.kind,
        record.scheduledFor,
        record.startMinute,
        record.endMinute,
        record.timestamp,
        record.timestamp,
      ],
    );
  }

  update(
    workspaceId: string,
    scheduleId: string,
    scheduledFor: string,
    expectedRevision: number,
    title: string,
    kind: ScheduleKind,
    startMinute: number,
    endMinute: number,
    timestamp: string,
  ): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE schedule_items
         SET title = ?, kind = ?, start_minute = ?, end_minute = ?,
             revision = revision + 1, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND scheduled_for = ?
           AND archived_at IS NULL AND revision = ?`,
        [
          title,
          kind,
          startMinute,
          endMinute,
          timestamp,
          workspaceId,
          scheduleId,
          scheduledFor,
          expectedRevision,
        ],
      ).changes,
      'updated',
    );
  }

  archive(
    workspaceId: string,
    scheduleId: string,
    scheduledFor: string,
    expectedRevision: number,
    timestamp: string,
  ): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE schedule_items
         SET revision = revision + 1, archived_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND scheduled_for = ?
           AND archived_at IS NULL AND revision = ?`,
        [timestamp, timestamp, workspaceId, scheduleId, scheduledFor, expectedRevision],
      ).changes,
      'archived',
    );
  }

  validateIntegrity(): void {
    const rows = this.#database.all<ScheduleRow>(
      `SELECT id, workspace_id, title, kind, scheduled_for, start_minute, end_minute,
              revision, created_at, updated_at, archived_at
       FROM schedule_items
       ORDER BY workspace_id, scheduled_for, start_minute, id`,
    );
    for (const row of rows) mapScheduleRow(row, undefined, true);
  }

  #assertChanged(value: unknown, operation: string): void {
    if (typeof value !== 'number' || Number(value) !== 1) {
      throw new DatabaseIntegrityError(`The schedule item could not be ${operation}.`);
    }
  }
}

function mapScheduleRow(
  row: ScheduleRow,
  expectedWorkspaceId: string | undefined,
  allowArchived: boolean,
): StoredScheduleItem {
  let id: string;
  let workspaceId: string;
  let title: string;
  let kind: ScheduleKind;
  let scheduledFor: string;
  let startMinute: number;
  let endMinute: number;
  let revision: number;
  try {
    id = normalizeScheduleId(row.id);
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    title = normalizeScheduleTitle(row.title);
    kind = normalizeScheduleKind(row.kind);
    scheduledFor = normalizeScheduleCivilDate(row.scheduled_for);
    ({ startMinute, endMinute } = normalizeScheduleRange(row.start_minute, row.end_minute));
    revision = normalizeScheduleRevision(row.revision);
  } catch (error) {
    throw new DatabaseIntegrityError('Schedule row contains invalid values.', { cause: error });
  }
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new DatabaseIntegrityError('Schedule row belongs to an unexpected workspace.');
  }
  if (row.title !== title) {
    throw new DatabaseIntegrityError('Schedule title normalization is invalid.');
  }
  if (!isIsoTimestamp(row.created_at) || !isIsoTimestamp(row.updated_at)) {
    throw new DatabaseIntegrityError('Schedule timestamps are invalid.');
  }
  if (row.updated_at < row.created_at) {
    throw new DatabaseIntegrityError('Schedule update time precedes its creation time.');
  }
  if (row.archived_at !== null && !isIsoTimestamp(row.archived_at)) {
    throw new DatabaseIntegrityError('Schedule archive timestamp is invalid.');
  }
  if (
    row.archived_at !== null &&
    (row.archived_at < row.created_at || row.updated_at < row.archived_at)
  ) {
    throw new DatabaseIntegrityError('Schedule archive timestamp ordering is invalid.');
  }
  if (!allowArchived && row.archived_at !== null) {
    throw new DatabaseIntegrityError('An archived schedule item appeared in the active list.');
  }
  return {
    id,
    workspaceId,
    title,
    kind,
    scheduledFor,
    startMinute,
    endMinute,
    revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toPublicItem(item: StoredScheduleItem): ScheduleItem {
  return {
    id: item.id,
    title: item.title,
    kind: item.kind,
    scheduledFor: item.scheduledFor,
    startMinute: item.startMinute,
    endMinute: item.endMinute,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
