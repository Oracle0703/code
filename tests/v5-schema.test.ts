import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';

const temporaryDirectories: string[] = [];
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const NOTE_SOURCE_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = '44444444-4444-4444-8444-444444444444';
const NOTE_ID = '55555555-5555-4555-8555-555555555555';
const SCHEDULE_ID = '66666666-6666-4666-8666-666666666666';
const CREATED_AT = '2026-07-22T08:00:00.000Z';
const UPDATED_AT = '2026-07-22T08:01:00.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

describe('v5 notes and schedule schema', () => {
  it('registers v5 as a contiguous immutable migration', async () => {
    const database = await createDatabase();
    const result = new MigrationRunner(DEFAULT_MIGRATIONS).apply(database);
    expect(result).toMatchObject({ fromVersion: 0, toVersion: 5 });
    expect(DEFAULT_MIGRATIONS.at(-1)).toMatchObject({
      version: 5,
      name: 'notes_schedule',
    });
    database.close();
  });

  it('prevents task/note source reuse and requires revisions to advance exactly once', async () => {
    const database = await createV5Database();
    seedWorkspace(database);
    seedArchivedInbox(database, TASK_SOURCE_ID, '任务来源');
    seedArchivedInbox(database, NOTE_SOURCE_ID, '笔记来源');

    database.run(
      `INSERT INTO tasks (
         id, workspace_id, title, status, planned_for, source_inbox_entry_id,
         created_at, updated_at, completed_at
       ) VALUES (?, ?, '任务', 'todo', NULL, ?, ?, ?, NULL)`,
      [TASK_ID, WORKSPACE_ID, TASK_SOURCE_ID, CREATED_AT, CREATED_AT],
    );
    expect(() =>
      insertNote(database, '77777777-7777-4777-8777-777777777777', TASK_SOURCE_ID),
    ).toThrow();

    insertNote(database, NOTE_ID, NOTE_SOURCE_ID);
    expect(() =>
      database.run(
        `INSERT INTO tasks (
           id, workspace_id, title, status, planned_for, source_inbox_entry_id,
           created_at, updated_at, completed_at
         ) VALUES (?, ?, '重复来源', 'todo', NULL, ?, ?, ?, NULL)`,
        [
          '88888888-8888-4888-8888-888888888888',
          WORKSPACE_ID,
          NOTE_SOURCE_ID,
          CREATED_AT,
          CREATED_AT,
        ],
      ),
    ).toThrow();

    expect(() =>
      database.run('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?', [
        '未推进版本',
        UPDATED_AT,
        NOTE_ID,
      ]),
    ).toThrow();
    expect(
      database.run(
        `UPDATE notes
         SET title = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = 1`,
        ['已保存标题', UPDATED_AT, NOTE_ID],
      ).changes,
    ).toBe(1);
    expect(
      database.get<{ revision: number }>('SELECT revision FROM notes WHERE id = ?', [NOTE_ID]),
    ).toEqual({ revision: 2 });

    database.close();
  });

  it('enforces valid civil dates, same-day ranges, immutable archives, and no hard delete', async () => {
    const database = await createV5Database();
    seedWorkspace(database);

    expect(() => insertSchedule(database, '2026-99-99', 540, 600)).toThrow();
    expect(() => insertSchedule(database, '2026-02-30', 540, 600)).toThrow();
    expect(() => insertSchedule(database, '2026-07-22', 600, 600)).toThrow();
    insertSchedule(database, '2026-07-22', 0, 1);

    expect(() =>
      database.run('UPDATE schedule_items SET title = ?, updated_at = ? WHERE id = ?', [
        '未推进版本',
        UPDATED_AT,
        SCHEDULE_ID,
      ]),
    ).toThrow();
    expect(
      database.run(
        `UPDATE schedule_items
         SET title = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = 1`,
        ['有效更新', UPDATED_AT, SCHEDULE_ID],
      ).changes,
    ).toBe(1);
    expect(
      database.run(
        `UPDATE schedule_items
         SET archived_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = 2`,
        [UPDATED_AT, UPDATED_AT, SCHEDULE_ID],
      ).changes,
    ).toBe(1);
    expect(() =>
      database.run(
        `UPDATE schedule_items
         SET title = '已归档后改写', revision = revision + 1
         WHERE id = ?`,
        [SCHEDULE_ID],
      ),
    ).toThrow();
    expect(() => database.run('DELETE FROM schedule_items WHERE id = ?', [SCHEDULE_ID])).toThrow();

    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-v5-schema-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'database.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createV5Database(): Promise<SqliteAdapter> {
  const database = await createDatabase();
  new MigrationRunner(DEFAULT_MIGRATIONS).apply(database);
  return database;
}

function seedWorkspace(database: SqliteAdapter): void {
  database.run(
    `INSERT INTO workspaces (
       id, name, name_key, color, created_at, updated_at, archived_at
     ) VALUES (?, '测试工作区', '测试工作区', '#7b6ee8', ?, ?, NULL)`,
    [WORKSPACE_ID, CREATED_AT, CREATED_AT],
  );
}

function seedArchivedInbox(database: SqliteAdapter, id: string, content: string): void {
  database.run(
    `INSERT INTO inbox_entries (
       id, workspace_id, content, category, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, 'note', ?, ?, ?)`,
    [id, WORKSPACE_ID, content, CREATED_AT, UPDATED_AT, UPDATED_AT],
  );
}

function insertNote(database: SqliteAdapter, id: string, sourceId: string): void {
  database.run(
    `INSERT INTO notes (
       id, workspace_id, title, body, revision, source_inbox_entry_id,
       created_at, updated_at, archived_at
     ) VALUES (?, ?, '笔记', '# 笔记\n\n正文', 1, ?, ?, ?, NULL)`,
    [id, WORKSPACE_ID, sourceId, CREATED_AT, CREATED_AT],
  );
}

function insertSchedule(
  database: SqliteAdapter,
  scheduledFor: string,
  startMinute: number,
  endMinute: number,
): void {
  database.run(
    `INSERT INTO schedule_items (
       id, workspace_id, title, kind, scheduled_for, start_minute, end_minute,
       revision, created_at, updated_at, archived_at
     ) VALUES (?, ?, '时间块', 'focus', ?, ?, ?, 1, ?, ?, NULL)`,
    [SCHEDULE_ID, WORKSPACE_ID, scheduledFor, startMinute, endMinute, CREATED_AT, CREATED_AT],
  );
}
