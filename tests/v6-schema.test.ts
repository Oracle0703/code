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
const WORKSPACE_ID_B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAB_ID = '22222222-2222-4222-8222-222222222222';
const TAB_ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BOOKMARK_ID = '33333333-3333-4333-8333-333333333333';
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

describe('v6 browser persistence schema', () => {
  it('registers v6 as the contiguous browser tabs and bookmarks migration', async () => {
    const database = await createDatabase();
    expect(new MigrationRunner(DEFAULT_MIGRATIONS).apply(database)).toMatchObject({
      fromVersion: 0,
      toVersion: 6,
    });
    expect(DEFAULT_MIGRATIONS.at(-1)).toMatchObject({
      version: 6,
      name: 'browser_tabs_bookmarks',
    });
    database.close();
  });

  it('binds active tabs to their workspace and advances the state revision exactly once', async () => {
    const database = await createV6Database();
    seedWorkspace(database);
    insertTab(database, TAB_ID, 'https://example.com/');
    database.run(
      `INSERT INTO browser_workspace_state (
         workspace_id, active_tab_id, revision, updated_at
       ) VALUES (?, ?, 1, ?)`,
      [WORKSPACE_ID, TAB_ID, CREATED_AT],
    );

    expect(() => database.run('DELETE FROM browser_tabs WHERE id = ?', [TAB_ID])).toThrow();
    expect(() =>
      database.run(
        `UPDATE browser_workspace_state
         SET updated_at = ?
         WHERE workspace_id = ?`,
        [UPDATED_AT, WORKSPACE_ID],
      ),
    ).toThrow(/revision must advance exactly once/u);
    expect(
      database.run(
        `UPDATE browser_workspace_state
         SET revision = revision + 1, updated_at = ?
         WHERE workspace_id = ?`,
        [UPDATED_AT, WORKSPACE_ID],
      ).changes,
    ).toBe(1);
    expect(() =>
      database.run('DELETE FROM browser_workspace_state WHERE workspace_id = ?', [WORKSPACE_ID]),
    ).toThrow(/cannot be deleted/u);
    database.close();
  });

  it('accepts only HTTP(S) bookmarks and enforces workspace URL uniqueness', async () => {
    const database = await createV6Database();
    seedWorkspace(database);
    insertTab(database, TAB_ID, 'about:blank');
    database.run(
      `INSERT INTO browser_workspace_state (
         workspace_id, active_tab_id, revision, updated_at
       ) VALUES (?, ?, 1, ?)`,
      [WORKSPACE_ID, TAB_ID, CREATED_AT],
    );

    expect(() =>
      database.run(
        `INSERT INTO browser_bookmarks (
           id, workspace_id, url, title, created_at
         ) VALUES (?, ?, 'about:blank', '空白页', ?)`,
        [BOOKMARK_ID, WORKSPACE_ID, CREATED_AT],
      ),
    ).toThrow();
    database.run(
      `INSERT INTO browser_bookmarks (
         id, workspace_id, url, title, created_at
       ) VALUES (?, ?, 'https://example.com/', 'Example', ?)`,
      [BOOKMARK_ID, WORKSPACE_ID, CREATED_AT],
    );
    expect(() =>
      database.run(
        `INSERT INTO browser_bookmarks (
           id, workspace_id, url, title, created_at
         ) VALUES ('44444444-4444-4444-8444-444444444444', ?, 'https://example.com/', '重复', ?)`,
        [WORKSPACE_ID, CREATED_AT],
      ),
    ).toThrow();
    database.close();
  });

  it('enforces cross-workspace references, monotonic timestamps, and immutable bookmarks', async () => {
    const database = await createV6Database();
    seedWorkspace(database);
    seedWorkspace(database, WORKSPACE_ID_B, '另一个工作区');
    insertTab(database, TAB_ID, 'https://example.com/');
    insertTab(database, TAB_ID_B, 'https://example.org/', WORKSPACE_ID_B);

    expect(() =>
      database.run(
        `INSERT INTO browser_workspace_state (
           workspace_id, active_tab_id, revision, updated_at
         ) VALUES (?, ?, 1, ?)`,
        [WORKSPACE_ID, TAB_ID_B, CREATED_AT],
      ),
    ).toThrow();
    database.run(
      `INSERT INTO browser_workspace_state (
         workspace_id, active_tab_id, revision, updated_at
       ) VALUES (?, ?, 1, ?)`,
      [WORKSPACE_ID, TAB_ID, UPDATED_AT],
    );
    expect(() =>
      database.run('UPDATE browser_tabs SET workspace_id = ? WHERE id = ?', [
        WORKSPACE_ID_B,
        TAB_ID,
      ]),
    ).toThrow(/workspace is immutable/u);
    expect(() =>
      database.run('UPDATE browser_tabs SET created_at = ? WHERE id = ?', [
        '2026-07-22T07:59:00.000Z',
        TAB_ID,
      ]),
    ).toThrow(/creation time is immutable/u);
    expect(() =>
      database.run('UPDATE browser_tabs SET updated_at = ? WHERE id = ?', [
        '2026-07-22T07:59:00.000Z',
        TAB_ID,
      ]),
    ).toThrow(/cannot move backwards/u);
    expect(() =>
      database.run(
        `UPDATE browser_workspace_state
         SET revision = revision + 1, updated_at = ?
         WHERE workspace_id = ?`,
        [CREATED_AT, WORKSPACE_ID],
      ),
    ).toThrow(/cannot move backwards/u);

    database.run(
      `INSERT INTO browser_bookmarks (
         id, workspace_id, url, title, created_at
       ) VALUES (?, ?, 'https://example.com/', 'Example', ?)`,
      [BOOKMARK_ID, WORKSPACE_ID, CREATED_AT],
    );
    expect(() =>
      database.run('UPDATE browser_bookmarks SET title = ? WHERE id = ?', ['Changed', BOOKMARK_ID]),
    ).toThrow(/rows are immutable/u);
    database.close();
  });

  it('enforces tab and bookmark caps and protects archived workspace browser rows', async () => {
    const database = await createV6Database();
    seedWorkspace(database);
    seedWorkspace(database, WORKSPACE_ID_B, '保留工作区');
    insertTab(database, TAB_ID, 'about:blank');
    database.run(
      `INSERT INTO browser_workspace_state (
         workspace_id, active_tab_id, revision, updated_at
       ) VALUES (?, ?, 1, ?)`,
      [WORKSPACE_ID, TAB_ID, CREATED_AT],
    );

    for (let index = 0; index < 11; index += 1) {
      insertTab(database, browserId(index + 100), `https://example.com/tab-${index}`, WORKSPACE_ID);
    }
    expect(() =>
      insertTab(database, browserId(999), 'https://example.com/overflow', WORKSPACE_ID),
    ).toThrow(/tab limit exceeded/u);

    for (let index = 0; index < 500; index += 1) {
      database.run(
        `INSERT INTO browser_bookmarks (
           id, workspace_id, url, title, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [
          browserId(index + 1000),
          WORKSPACE_ID,
          `https://example.com/bookmark-${index}`,
          `Bookmark ${index}`,
          CREATED_AT,
        ],
      );
    }
    expect(() =>
      database.run(
        `INSERT INTO browser_bookmarks (
           id, workspace_id, url, title, created_at
         ) VALUES (?, ?, 'https://example.com/overflow', 'Overflow', ?)`,
        [browserId(9999), WORKSPACE_ID, CREATED_AT],
      ),
    ).toThrow(/bookmark limit exceeded/u);

    database.run('DELETE FROM browser_tabs WHERE id = ?', [browserId(100)]);
    database.run('DELETE FROM browser_bookmarks WHERE id = ?', [browserId(1000)]);
    database.run('UPDATE workspaces SET archived_at = ? WHERE id = ?', [UPDATED_AT, WORKSPACE_ID]);
    expect(() =>
      insertTab(database, browserId(10_000), 'https://example.com/archived', WORKSPACE_ID),
    ).toThrow(/requires an active workspace/u);
    expect(() =>
      database.run('UPDATE browser_tabs SET title = ? WHERE id = ?', ['Changed', TAB_ID]),
    ).toThrow(/archived workspace browser tabs are immutable/u);
    expect(() => database.run('DELETE FROM browser_tabs WHERE id = ?', [TAB_ID])).toThrow(
      /archived workspace browser tabs are immutable/u,
    );
    expect(() =>
      database.run(
        `UPDATE browser_workspace_state
         SET revision = revision + 1, updated_at = ?
         WHERE workspace_id = ?`,
        ['2026-07-22T08:02:00.000Z', WORKSPACE_ID],
      ),
    ).toThrow(/archived workspace browser state is immutable/u);
    expect(() =>
      database.run(
        `INSERT INTO browser_bookmarks (
           id, workspace_id, url, title, created_at
         ) VALUES (?, ?, 'https://example.com/archived', 'Archived', ?)`,
        [browserId(10_001), WORKSPACE_ID, CREATED_AT],
      ),
    ).toThrow(/requires an active workspace/u);
    expect(() =>
      database.run('UPDATE browser_bookmarks SET title = ? WHERE id = ?', [
        'Changed',
        browserId(1001),
      ]),
    ).toThrow();
    expect(() =>
      database.run('DELETE FROM browser_bookmarks WHERE id = ?', [browserId(1001)]),
    ).toThrow(/archived workspace browser bookmarks are immutable/u);
    database.close();
  });
});

async function createDatabase(): Promise<SqliteAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-v6-schema-'));
  temporaryDirectories.push(directory);
  const database = createNodeSqliteAdapter(join(directory, 'database.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  return database;
}

async function createV6Database(): Promise<SqliteAdapter> {
  const database = await createDatabase();
  new MigrationRunner(DEFAULT_MIGRATIONS).apply(database);
  return database;
}

function seedWorkspace(
  database: SqliteAdapter,
  workspaceId = WORKSPACE_ID,
  name = '测试工作区',
): void {
  database.run(
    `INSERT INTO workspaces (
       id, name, name_key, color, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, '#7b6ee8', ?, ?, NULL)`,
    [workspaceId, name, name, CREATED_AT, CREATED_AT],
  );
}

function insertTab(
  database: SqliteAdapter,
  id: string,
  url: string,
  workspaceId = WORKSPACE_ID,
): void {
  database.run(
    `INSERT INTO browser_tabs (
       id, workspace_id, url, title, created_at, updated_at
     ) VALUES (?, ?, ?, 'New tab', ?, ?)`,
    [id, workspaceId, url, CREATED_AT, CREATED_AT],
  );
}

function browserId(value: number): string {
  return `${value.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
}
