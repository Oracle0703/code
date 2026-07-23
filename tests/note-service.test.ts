import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from '../src/main/database';
import {
  DatabaseBackupError,
  DatabaseIntegrityError,
  DatabaseStateError,
} from '../src/main/database/errors';
import {
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from '../src/main/database/sqlite-adapter';
import { NoteConflictError, NoteNotFoundError, NoteValidationError } from '../src/main/notes';
import { WORKSPACE_COLORS } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const NOTE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOTE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENTRY_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENTRY_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TASK_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DIRECT_TASK = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DIRECT_NOTE = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-07-22T12:34:56.000Z');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('note service', () => {
  it('creates, updates with revision CAS, archives, and reopens Markdown notes', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      noteIds: [NOTE_A],
    });
    const opened = await service.open();
    expect(opened.migration).toMatchObject({ fromVersion: 0, toVersion: 7 });

    let snapshot = await service.createNote({
      workspaceId: WORKSPACE_A,
      title: '  Markdown 笔记 👩‍💻  ',
      body: '# 标题\r\n\r\n- 内容\tA',
    });
    expect(snapshot.notes).toEqual([
      expect.objectContaining({
        id: NOTE_A,
        title: 'Markdown 笔记 👩‍💻',
        body: '# 标题\n\n- 内容\tA',
        revision: 1,
        sourceInboxEntryId: null,
      }),
    ]);

    snapshot = await service.updateNote({
      workspaceId: WORKSPACE_A,
      noteId: NOTE_A,
      expectedRevision: 1,
      title: '更新后的笔记',
      body: '```ts\nconst answer = 42;\n```',
    });
    expect(snapshot.notes[0]).toMatchObject({
      title: '更新后的笔记',
      revision: 2,
    });
    await expect(
      service.updateNote({
        workspaceId: WORKSPACE_A,
        noteId: NOTE_A,
        expectedRevision: 1,
        title: '不能覆盖',
        body: 'stale',
      }),
    ).rejects.toBeInstanceOf(NoteConflictError);

    snapshot = await service.archiveNote({
      workspaceId: WORKSPACE_A,
      noteId: NOTE_A,
      expectedRevision: 2,
    });
    expect(snapshot.notes).toEqual([]);
    await expect(
      service.archiveNote({
        workspaceId: WORKSPACE_A,
        noteId: NOTE_A,
        expectedRevision: 2,
      }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);
    await service.close();

    const database = openDatabase(dataDirectory);
    expect(
      database
        .prepare('SELECT revision, archived_at IS NOT NULL AS archived FROM notes WHERE id = ?')
        .get(NOTE_A),
    ).toEqual({ revision: 3, archived: 1 });
    expect(() =>
      database
        .prepare('UPDATE notes SET title = ?, revision = revision + 1 WHERE id = ?')
        .run('绕过归档保护', NOTE_A),
    ).toThrow(/archived note is immutable/u);
    expect(() => database.prepare('DELETE FROM notes WHERE id = ?').run(NOTE_A)).toThrow(
      /notes cannot be permanently deleted/u,
    );
    database.close();

    const reopened = createService(dataDirectory);
    await reopened.open();
    await expect(reopened.getNoteSnapshot({ workspaceId: WORKSPACE_A })).resolves.toEqual({
      workspaceId: WORKSPACE_A,
      notes: [],
    });
    await reopened.close();
  });

  it('atomically converts inbox entries and prevents task/note source reuse', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A, ENTRY_B],
      noteIds: [NOTE_A],
      taskIds: [TASK_A],
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '# 来自收件箱的笔记 👩‍💻',
      category: 'note',
    });

    const converted = await service.convertInboxToNote({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_A,
    });
    expect(converted.inboxSnapshot.entries).toEqual([]);
    expect(converted.noteSnapshot.notes).toEqual([
      expect.objectContaining({
        id: NOTE_A,
        title: '来自收件箱的笔记 👩‍💻',
        body: '# 来自收件箱的笔记 👩‍💻',
        revision: 1,
        sourceInboxEntryId: ENTRY_A,
      }),
    ]);
    await expect(
      service.convertInboxToNote({ workspaceId: WORKSPACE_A, entryId: ENTRY_A }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);

    let database = openDatabase(dataDirectory);
    expect(() =>
      database
        .prepare('UPDATE inbox_entries SET archived_at = NULL, updated_at = ? WHERE id = ?')
        .run(NOW.toISOString(), ENTRY_A),
    ).toThrow(/note inbox source must remain archived/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO tasks (
             id, workspace_id, title, status, planned_for, source_inbox_entry_id,
             created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, 'todo', NULL, ?, ?, ?, NULL)`,
        )
        .run(
          DIRECT_TASK,
          WORKSPACE_A,
          '不能复用笔记来源',
          ENTRY_A,
          NOW.toISOString(),
          NOW.toISOString(),
        ),
    ).toThrow(/inbox source is already linked to a note/u);
    database.close();

    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '先转换为任务',
      category: 'task',
    });
    await service.convertInboxToTask({
      workspaceId: WORKSPACE_A,
      entryId: ENTRY_B,
      planning: 'none',
    });
    database = openDatabase(dataDirectory);
    expect(() =>
      database
        .prepare(
          `INSERT INTO notes (
             id, workspace_id, title, body, revision, source_inbox_entry_id,
             created_at, updated_at, archived_at
           ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL)`,
        )
        .run(
          DIRECT_NOTE,
          WORKSPACE_A,
          '不能复用任务来源',
          '',
          ENTRY_B,
          NOW.toISOString(),
          NOW.toISOString(),
        ),
    ).toThrow(/inbox source is already linked to a task/u);
    database.close();
    await service.close();
  });

  it('isolates workspaces and rejects archived-workspace mutation at both layers', async () => {
    const dataDirectory = await createDataDirectory();
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A, WORKSPACE_B],
      noteIds: [NOTE_A],
    });
    await service.open();
    await service.createWorkspace({ name: '空间 B', color: WORKSPACE_COLORS[1] });
    await service.createNote({
      workspaceId: WORKSPACE_B,
      title: '空间 B 笔记',
      body: '',
    });
    await expect(service.getNoteSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      notes: [],
    });
    await expect(
      service.updateNote({
        workspaceId: WORKSPACE_A,
        noteId: NOTE_A,
        expectedRevision: 1,
        title: '串写',
        body: '',
      }),
    ).rejects.toBeInstanceOf(NoteNotFoundError);

    await service.archiveWorkspace({ workspaceId: WORKSPACE_B });
    await expect(service.getNoteSnapshot({ workspaceId: WORKSPACE_B })).rejects.toBeInstanceOf(
      NoteNotFoundError,
    );
    const database = openDatabase(dataDirectory);
    expect(() =>
      database
        .prepare('UPDATE notes SET title = ?, revision = revision + 1 WHERE id = ?')
        .run('绕过 Service', NOTE_A),
    ).toThrow(/archived workspace notes are immutable/u);
    database.close();
    await service.close();
  });

  it('rejects corrupt note rows before publishing backups or last-opened metadata', async () => {
    const backupDirectory = await createDataDirectory();
    const backupService = createService(backupDirectory, {
      workspaceIds: [WORKSPACE_A],
      noteIds: [NOTE_A],
    });
    await backupService.open();
    await backupService.createNote({
      workspaceId: WORKSPACE_A,
      title: '备份前损坏',
      body: '正文仍然存在',
    });

    let database = openDatabase(backupDirectory);
    database
      .prepare(
        'UPDATE notes SET created_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
      )
      .run('not-an-iso-date', 'not-an-iso-date', NOTE_A);
    database.close();

    await expect(backupService.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
    await expect(backupService.listBackups()).resolves.toEqual([]);
    const backupFiles = await readdir(join(backupDirectory, 'backups'));
    expect(backupFiles.some((fileName) => fileName.endsWith('.partial'))).toBe(false);
    await backupService.close();

    const startupDirectory = await createDataDirectory();
    const initialService = createService(startupDirectory, {
      workspaceIds: [WORKSPACE_A],
      noteIds: [NOTE_A],
    });
    await initialService.open();
    await initialService.createNote({
      workspaceId: WORKSPACE_A,
      title: '启动前损坏',
      body: '',
    });
    await initialService.close();

    database = openDatabase(startupDirectory);
    const lastOpenedBefore = database
      .prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'")
      .get()?.value;
    database
      .prepare(
        'UPDATE notes SET created_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
      )
      .run('not-an-iso-date', 'not-an-iso-date', NOTE_A);
    database.close();

    const corruptService = createService(startupDirectory, {
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    await expect(corruptService.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
    database = openDatabase(startupDirectory);
    expect(
      database.prepare("SELECT value FROM app_metadata WHERE key = 'last_opened_at'").get()?.value,
    ).toBe(lastOpenedBefore);
    database.close();
  });

  it('rolls back inbox conversion and poisons the queue when rollback is unsafe', async () => {
    const dataDirectory = await createDataDirectory();
    let failInsert = false;
    let failRollback = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      return options?.readOnly
        ? adapter
        : bindAdapterWithNoteFailure(
            adapter,
            () => failInsert,
            () => failRollback,
          );
    };
    const service = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      inboxIds: [ENTRY_A],
      noteIds: [NOTE_A],
      adapterFactory,
    });
    await service.open();
    await service.createInboxEntry({
      workspaceId: WORKSPACE_A,
      content: '事务必须保持原子',
      category: 'note',
    });
    failInsert = true;
    await expect(
      service.convertInboxToNote({ workspaceId: WORKSPACE_A, entryId: ENTRY_A }),
    ).rejects.toThrow();
    failInsert = false;
    await expect(service.getInboxSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      entries: [{ id: ENTRY_A }],
    });
    await expect(service.getNoteSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      notes: [],
    });

    failInsert = true;
    failRollback = true;
    const failed = service.convertInboxToNote({ workspaceId: WORKSPACE_A, entryId: ENTRY_A });
    const queued = service.getNoteSnapshot({ workspaceId: WORKSPACE_A });
    await expect(failed).rejects.toBeInstanceOf(DatabaseIntegrityError);
    await expect(queued).rejects.toBeInstanceOf(DatabaseStateError);
    failInsert = false;
    failRollback = false;
    await service.close().catch(() => undefined);
  });

  it('rejects malformed renderer and generated values before mutation', async () => {
    const dataDirectory = await createDataDirectory();
    const invalid = createService(dataDirectory, {
      workspaceIds: [WORKSPACE_A],
      noteIds: ['not-a-uuid'],
    });
    await invalid.open();
    expect(() =>
      invalid.createNote({ workspaceId: WORKSPACE_A, title: '不会落库', body: '' }),
    ).toThrow(NoteValidationError);
    await expect(invalid.getNoteSnapshot({ workspaceId: WORKSPACE_A })).resolves.toMatchObject({
      notes: [],
    });
    await invalid.close();
  });
});

interface ServiceOptions {
  workspaceIds?: string[];
  inboxIds?: string[];
  noteIds?: string[];
  taskIds?: string[];
  now?: () => Date;
  adapterFactory?: SqliteAdapterFactory;
}

function createService(dataDirectory: string, options: ServiceOptions = {}): DatabaseService {
  const workspaceIds = [...(options.workspaceIds ?? [])];
  const inboxIds = [...(options.inboxIds ?? [])];
  const noteIds = [...(options.noteIds ?? [])];
  const taskIds = [...(options.taskIds ?? [])];
  return new DatabaseService({
    dataDirectory,
    now: options.now ?? (() => new Date(NOW)),
    workspaceIdFactory: () => workspaceIds.shift() ?? WORKSPACE_A,
    inboxIdFactory: () => inboxIds.shift() ?? ENTRY_A,
    noteIdFactory: () => noteIds.shift() ?? NOTE_B,
    taskIdFactory: () => taskIds.shift() ?? TASK_A,
    taskTodayFactory: () => '2026-07-22',
    scheduleTodayFactory: () => '2026-07-22',
    adapterFactory: options.adapterFactory,
  });
}

async function createDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-notes-'));
  temporaryDirectories.push(root);
  return join(root, 'data');
}

function openDatabase(dataDirectory: string): DatabaseSync {
  return new DatabaseSync(join(dataDirectory, 'daily-workbench.sqlite3'));
}

function bindAdapterWithNoteFailure(
  adapter: SqliteAdapter,
  shouldFailInsert: () => boolean,
  shouldFailRollback: () => boolean,
): SqliteAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'run') {
        return (sql: string, parameters: readonly unknown[] = []) => {
          if (shouldFailInsert() && /^\s*INSERT INTO notes\b/u.test(sql)) {
            throw new Error('Injected note insert failure.');
          }
          return target.run(sql, parameters as never[]);
        };
      }
      if (property === 'exec') {
        return (sql: string) => {
          if (shouldFailRollback() && sql === 'ROLLBACK') {
            throw new Error('Injected note rollback failure.');
          }
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
