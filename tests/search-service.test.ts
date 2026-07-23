import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { DatabaseIntegrityError } from '../src/main/database/errors';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
} from '../src/main/database/sqlite-adapter';
import { SearchNotFoundError, SearchService, SearchValidationError } from '../src/main/search';

const temporaryDirectories: string[] = [];
const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_ARCHIVED = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-07-23';
const BASE_TIME = '2026-07-23T08:00:00.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

describe('SearchService', () => {
  it('searches all six data kinds and returns bounded, typed excerpts', async () => {
    const { database, service } = await createSearchContext();
    seedWorkspace(database, WORKSPACE_A, 'Alpha 工作区');
    seedAllKinds(database, WORKSPACE_A, 'alpha');

    const snapshot = await service.query({
      workspaceId: WORKSPACE_A,
      query: 'alpha',
      scope: 'workspace',
    });

    expect(snapshot).toMatchObject({
      workspaceId: WORKSPACE_A,
      query: 'alpha',
      scope: 'workspace',
      truncated: false,
      truncatedKinds: [],
    });
    expect(new Set(snapshot.results.map(({ kind }) => kind))).toEqual(
      new Set(['inbox', 'task', 'note', 'schedule', 'browser-tab', 'browser-bookmark']),
    );
    expect(snapshot.results.every(({ workspaceId }) => workspaceId === WORKSPACE_A)).toBe(true);
    expect(snapshot.results.every(({ workspaceName }) => workspaceName === 'Alpha 工作区')).toBe(
      true,
    );

    const note = snapshot.results.find(({ kind }) => kind === 'note');
    expect(note).toMatchObject({ title: 'Reference note', matchField: 'content' });
    expect(note?.excerpt).toContain('alpha');
    expect(Array.from(note?.excerpt ?? '')).toHaveLength(
      Math.min(Array.from(note?.excerpt ?? '').length, 180),
    );

    const bookmark = snapshot.results.find(({ kind }) => kind === 'browser-bookmark');
    expect(bookmark).toMatchObject({ matchField: 'url' });
    expect(bookmark?.excerpt).toContain('/alpha/');
    database.close();
  });

  it('isolates workspace scope, ranks the anchor first in all scope, and hides archived workspaces', async () => {
    const { database, service } = await createSearchContext();
    seedWorkspace(database, WORKSPACE_A, '当前工作区');
    seedWorkspace(database, WORKSPACE_B, '其他工作区');
    seedWorkspace(database, WORKSPACE_ARCHIVED, '已归档工作区');
    seedTask(database, WORKSPACE_A, idFor(100), 'shared target', timestamp(2));
    seedTask(database, WORKSPACE_B, idFor(101), 'shared target', timestamp(3));
    seedTask(database, WORKSPACE_ARCHIVED, idFor(102), 'shared target', timestamp(4));
    database.run('UPDATE workspaces SET archived_at = ?, updated_at = ? WHERE id = ?', [
      timestamp(5),
      timestamp(5),
      WORKSPACE_ARCHIVED,
    ]);

    const local = await service.query({
      workspaceId: WORKSPACE_A,
      query: 'shared',
      scope: 'workspace',
    });
    expect(local.results.map(({ workspaceId }) => workspaceId)).toEqual([WORKSPACE_A]);

    const global = await service.query({
      workspaceId: WORKSPACE_A,
      query: 'shared',
      scope: 'all',
    });
    expect(global.results.map(({ workspaceId }) => workspaceId)).toEqual([
      WORKSPACE_A,
      WORKSPACE_B,
    ]);
    database.close();
  });

  it('uses a literal LIKE fallback for two-character CJK and wildcard queries', async () => {
    const { database, service } = await createSearchContext();
    seedWorkspace(database, WORKSPACE_A, '当前工作区');
    seedInbox(database, WORKSPACE_A, idFor(110), '部署计划', timestamp(1));
    seedInbox(database, WORKSPACE_A, idFor(111), '折扣 %_ 记录', timestamp(2));
    seedInbox(database, WORKSPACE_A, idFor(112), '完全无关', timestamp(3));

    await expect(
      service.query({ workspaceId: WORKSPACE_A, query: '计划', scope: 'workspace' }),
    ).resolves.toMatchObject({
      results: [expect.objectContaining({ entityId: idFor(110) })],
    });
    const wildcard = await service.query({
      workspaceId: WORKSPACE_A,
      query: '%_',
      scope: 'workspace',
    });
    expect(wildcard.results.map(({ entityId }) => entityId)).toEqual([idFor(111)]);
    database.close();
  });

  it('quotes FTS operators and quotes as literal three-character queries', async () => {
    const { database, service } = await createSearchContext();
    seedWorkspace(database, WORKSPACE_A, '当前工作区');
    seedNote(
      database,
      WORKSPACE_A,
      idFor(120),
      'Quoted phrase',
      'The instruction says say "yes" OR no literally.',
      timestamp(1),
    );

    const snapshot = await service.query({
      workspaceId: WORKSPACE_A,
      query: 'say "yes" OR no',
      scope: 'workspace',
    });
    expect(snapshot.results).toEqual([
      expect.objectContaining({ kind: 'note', entityId: idFor(120), matchField: 'content' }),
    ]);
    database.close();
  });

  it('only returns active items from the Main-computed current schedule date', async () => {
    const { database, service } = await createSearchContext();
    seedWorkspace(database, WORKSPACE_A, '当前工作区');
    seedSchedule(database, WORKSPACE_A, idFor(130), 'daily review today', TODAY, timestamp(1));
    seedSchedule(
      database,
      WORKSPACE_A,
      idFor(131),
      'daily review tomorrow',
      '2026-07-24',
      timestamp(2),
    );
    seedSchedule(
      database,
      WORKSPACE_A,
      idFor(132),
      'daily review archived',
      TODAY,
      timestamp(4),
      timestamp(4),
    );

    const snapshot = await service.query({
      workspaceId: WORKSPACE_A,
      query: 'daily review',
      scope: 'workspace',
    });
    expect(snapshot.results).toEqual([
      expect.objectContaining({
        entityId: idFor(130),
        excerpt: `${TODAY} · 09:00–10:00`,
      }),
    ]);
    database.close();
  });

  it('enforces per-kind and total limits and reports every truncated kind deterministically', async () => {
    const { database, service } = await createSearchContext();
    seedWorkspace(database, WORKSPACE_A, '当前工作区');

    for (let index = 0; index < 8; index += 1) {
      const suffix = index.toString().padStart(2, '0');
      const time = timestamp(index + 1);
      seedInbox(database, WORKSPACE_A, idFor(200 + index), `common inbox ${suffix}`, time);
      seedTask(database, WORKSPACE_A, idFor(300 + index), `common task ${suffix}`, time);
      seedNote(database, WORKSPACE_A, idFor(400 + index), `common note ${suffix}`, 'body', time);
      seedSchedule(
        database,
        WORKSPACE_A,
        idFor(500 + index),
        `common schedule ${suffix}`,
        TODAY,
        time,
        null,
        600 + index,
        660 + index,
      );
      seedTab(
        database,
        WORKSPACE_A,
        idFor(600 + index),
        `common tab ${suffix}`,
        `https://example.com/tab-${suffix}`,
        time,
      );
      seedBookmark(
        database,
        WORKSPACE_A,
        idFor(700 + index),
        `common bookmark ${suffix}`,
        `https://example.com/bookmark-${suffix}`,
        time,
      );
    }

    const total = await service.query({
      workspaceId: WORKSPACE_A,
      query: 'common',
      scope: 'workspace',
    });
    expect(total.results).toHaveLength(40);
    expect(total.truncated).toBe(true);
    expect(total.truncatedKinds).toEqual(['browser-bookmark']);

    seedTask(database, WORKSPACE_A, idFor(399), 'common task', timestamp(20));
    const perKind = await service.query({
      workspaceId: WORKSPACE_A,
      query: 'common task',
      scope: 'workspace',
    });
    expect(perKind.results).toHaveLength(8);
    expect(perKind.truncatedKinds).toEqual(['task']);
    expect(perKind.results[0]?.entityId).toBe(idFor(399));
    database.close();
  });

  it('rejects invalid inputs before executing and requires an active anchor workspace', async () => {
    const execute = vi.fn();
    const service = new SearchService({
      execute,
      todayFactory: () => TODAY,
    });
    expect(() =>
      service.query({ workspaceId: '../../escape', query: 'valid', scope: 'workspace' }),
    ).toThrow(SearchValidationError);
    expect(() =>
      service.query({ workspaceId: WORKSPACE_A, query: 'x', scope: 'workspace' }),
    ).toThrow(SearchValidationError);
    expect(() =>
      service.query({
        workspaceId: WORKSPACE_A,
        query: 'valid',
        scope: 'invalid' as 'workspace',
      }),
    ).toThrow(SearchValidationError);
    expect(execute).not.toHaveBeenCalled();

    const context = await createSearchContext();
    seedWorkspace(context.database, WORKSPACE_A, '已归档', BASE_TIME);
    await expect(
      context.service.query({ workspaceId: WORKSPACE_A, query: 'valid', scope: 'all' }),
    ).rejects.toBeInstanceOf(SearchNotFoundError);
    context.database.close();
  });

  it('preserves executor failures without changing their identity', async () => {
    const unavailable = new Error('database unavailable');
    const unexpected = new SearchService({
      execute: async () => {
        throw unavailable;
      },
      todayFactory: () => TODAY,
    });
    await expect(
      unexpected.query({ workspaceId: WORKSPACE_A, query: 'valid', scope: 'workspace' }),
    ).rejects.toBe(unavailable);

    const integrity = new DatabaseIntegrityError('corrupt');
    const corrupted = new SearchService({
      execute: async () => {
        throw integrity;
      },
      todayFactory: () => TODAY,
    });
    await expect(
      corrupted.query({ workspaceId: WORKSPACE_A, query: 'valid', scope: 'workspace' }),
    ).rejects.toBe(integrity);
  });

  it('rejects snapshots with incomplete or out-of-sync FTS indexes', async () => {
    const incomplete = await createSearchContext();
    incomplete.database.exec('DROP TRIGGER notes_search_update');
    expect(() => incomplete.service.validateSnapshot(incomplete.database)).toThrow(
      DatabaseIntegrityError,
    );
    incomplete.database.close();

    const outOfSync = await createSearchContext();
    seedWorkspace(outOfSync.database, WORKSPACE_A, '当前工作区');
    const missingTaskId = idFor(900);
    const missingTaskTitle = 'missing index row';
    seedTask(outOfSync.database, WORKSPACE_A, missingTaskId, missingTaskTitle, timestamp(1));
    const missingTask = outOfSync.database.get<{ rowid: number }>(
      'SELECT rowid FROM tasks WHERE id = ?',
      [missingTaskId],
    );
    outOfSync.database.run(
      `INSERT INTO tasks_search(tasks_search, rowid, title)
       VALUES ('delete', ?, ?)`,
      [missingTask?.rowid ?? -1, missingTaskTitle],
    );
    expect(() => outOfSync.service.validateSnapshot(outOfSync.database)).toThrow(
      DatabaseIntegrityError,
    );
    outOfSync.database.close();
  });

  it('uses the FTS5 external-content integrity check to reject stale indexed terms', async () => {
    const context = await createSearchContext();
    seedWorkspace(context.database, WORKSPACE_A, '当前工作区');
    const taskId = idFor(901);
    seedTask(context.database, WORKSPACE_A, taskId, 'original searchable title', timestamp(1));
    context.database.exec(`
      DROP TRIGGER tasks_search_update;
      CREATE TRIGGER tasks_search_update
      AFTER UPDATE OF title ON tasks
      BEGIN
        SELECT 1;
      END;
    `);
    context.database.run('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?', [
      'replacement searchable title',
      timestamp(2),
      taskId,
    ]);

    expect(() => context.service.validateSnapshot(context.database)).not.toThrow();
    expect(() => context.service.validateContentIntegrity(context.database)).toThrow(
      DatabaseIntegrityError,
    );
    context.database.close();
  });
});

async function createSearchContext(): Promise<{
  readonly database: SqliteAdapter;
  readonly service: SearchService;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-search-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'search.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner(DEFAULT_MIGRATIONS).apply(database);
  return {
    database,
    service: new SearchService({
      execute: async (operation) => operation(database),
      todayFactory: () => TODAY,
    }),
  };
}

function seedWorkspace(
  database: SqliteAdapter,
  workspaceId: string,
  name: string,
  archivedAt: string | null = null,
): void {
  database.run(
    `INSERT INTO workspaces (
       id, name, name_key, color, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, '#7b6ee8', ?, ?, ?)`,
    [workspaceId, name, name.toLowerCase(), BASE_TIME, archivedAt ?? BASE_TIME, archivedAt],
  );
}

function seedAllKinds(database: SqliteAdapter, workspaceId: string, query: string): void {
  seedInbox(database, workspaceId, idFor(1), `${query} inbox`, timestamp(1));
  seedTask(database, workspaceId, idFor(2), `${query} task`, timestamp(2));
  seedNote(
    database,
    workspaceId,
    idFor(3),
    'Reference note',
    `A long Markdown body with **${query}** context.`,
    timestamp(3),
  );
  seedSchedule(database, workspaceId, idFor(4), `${query} review`, TODAY, timestamp(4));
  seedTab(
    database,
    workspaceId,
    idFor(5),
    `${query} docs`,
    'https://example.com/docs',
    timestamp(5),
  );
  seedBookmark(
    database,
    workspaceId,
    idFor(6),
    'Saved guide',
    `https://example.com/${query}/guide`,
    timestamp(6),
  );
}

function seedInbox(
  database: SqliteAdapter,
  workspaceId: string,
  id: string,
  content: string,
  updatedAt: string,
  archivedAt: string | null = null,
): void {
  database.run(
    `INSERT INTO inbox_entries (
       id, workspace_id, content, category, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, 'uncategorized', ?, ?, ?)`,
    [id, workspaceId, content, BASE_TIME, updatedAt, archivedAt],
  );
}

function seedTask(
  database: SqliteAdapter,
  workspaceId: string,
  id: string,
  title: string,
  updatedAt: string,
): void {
  database.run(
    `INSERT INTO tasks (
       id, workspace_id, title, status, planned_for, source_inbox_entry_id,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, 'todo', NULL, NULL, ?, ?, NULL)`,
    [id, workspaceId, title, BASE_TIME, updatedAt],
  );
}

function seedNote(
  database: SqliteAdapter,
  workspaceId: string,
  id: string,
  title: string,
  body: string,
  updatedAt: string,
  archivedAt: string | null = null,
): void {
  database.run(
    `INSERT INTO notes (
       id, workspace_id, title, body, revision, source_inbox_entry_id,
       created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
    [id, workspaceId, title, body, BASE_TIME, updatedAt, archivedAt],
  );
}

function seedSchedule(
  database: SqliteAdapter,
  workspaceId: string,
  id: string,
  title: string,
  scheduledFor: string,
  updatedAt: string,
  archivedAt: string | null = null,
  startMinute = 540,
  endMinute = 600,
): void {
  database.run(
    `INSERT INTO schedule_items (
       id, workspace_id, title, kind, scheduled_for, start_minute, end_minute,
       revision, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, 'review', ?, ?, ?, 1, ?, ?, ?)`,
    [
      id,
      workspaceId,
      title,
      scheduledFor,
      startMinute,
      endMinute,
      BASE_TIME,
      updatedAt,
      archivedAt,
    ],
  );
}

function seedTab(
  database: SqliteAdapter,
  workspaceId: string,
  id: string,
  title: string,
  url: string,
  updatedAt: string,
): void {
  database.run(
    `INSERT INTO browser_tabs (
       id, workspace_id, url, title, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, workspaceId, url, title, BASE_TIME, updatedAt],
  );
}

function seedBookmark(
  database: SqliteAdapter,
  workspaceId: string,
  id: string,
  title: string,
  url: string,
  createdAt: string,
): void {
  database.run(
    `INSERT INTO browser_bookmarks (
       id, workspace_id, url, title, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
    [id, workspaceId, url, title, createdAt],
  );
}

function idFor(value: number): string {
  return `${value.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function timestamp(offsetMinutes: number): string {
  return new Date(Date.parse(BASE_TIME) + offsetMinutes * 60_000).toISOString();
}
