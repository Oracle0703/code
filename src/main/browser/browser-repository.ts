import {
  BROWSER_MAX_BOOKMARKS,
  BROWSER_MAX_TABS,
  normalizeBrowserId,
  normalizeBrowserRevision,
  normalizeBrowserTitle,
} from '../../shared/browser-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { normalizeBrowserUrl } from '../security/browser-url';

interface BrowserTabRow {
  id: unknown;
  workspace_id: unknown;
  url: unknown;
  title: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface BrowserStateRow {
  workspace_id: unknown;
  active_tab_id: unknown;
  revision: unknown;
  updated_at: unknown;
}

interface BrowserBookmarkRow {
  id: unknown;
  workspace_id: unknown;
  url: unknown;
  title: unknown;
  created_at: unknown;
}

interface CountRow {
  count: unknown;
}

interface WorkspaceCountRow {
  workspace_id: unknown;
  count: unknown;
}

export interface BrowserTabData {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredBrowserTab extends BrowserTabData {
  readonly workspaceId: string;
}

export interface BrowserBookmarkData {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly createdAt: string;
}

export interface StoredBrowserBookmark extends BrowserBookmarkData {
  readonly workspaceId: string;
}

export interface BrowserData {
  readonly workspaceId: string;
  readonly revision: number;
  readonly activeTabId: string;
  readonly tabs: readonly BrowserTabData[];
  readonly bookmarks: readonly BrowserBookmarkData[];
}

export interface StoredBrowserState {
  readonly workspaceId: string;
  readonly activeTabId: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface NewBrowserTabRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly title: string;
  readonly timestamp: string;
}

export interface NewBrowserBookmarkRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly url: string;
  readonly title: string;
  readonly timestamp: string;
}

export class BrowserRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  readData(workspaceId: string): BrowserData {
    const state = this.readState(workspaceId);
    const tabs = this.listTabs(workspaceId);
    if (!tabs.some(({ id }) => id === state.activeTabId)) {
      throw new DatabaseIntegrityError('The active browser tab is missing from its workspace.');
    }
    return {
      workspaceId,
      revision: state.revision,
      activeTabId: state.activeTabId,
      tabs: tabs.map(toPublicTab),
      bookmarks: this.listBookmarks(workspaceId).map(toPublicBookmark),
    };
  }

  readState(workspaceId: string): StoredBrowserState {
    const state = this.findState(workspaceId);
    if (!state) {
      throw new DatabaseIntegrityError('Browser workspace state is missing.');
    }
    return state;
  }

  findState(workspaceId: string): StoredBrowserState | undefined {
    const row = this.#database.get<BrowserStateRow>(
      `SELECT workspace_id, active_tab_id, revision, updated_at
       FROM browser_workspace_state
       WHERE workspace_id = ?`,
      [workspaceId],
    );
    return row ? mapStateRow(row, workspaceId) : undefined;
  }

  listTabs(workspaceId: string): StoredBrowserTab[] {
    return this.#database
      .all<BrowserTabRow>(
        `SELECT id, workspace_id, url, title, created_at, updated_at
         FROM browser_tabs
         WHERE workspace_id = ?
         ORDER BY created_at, id`,
        [workspaceId],
      )
      .map((row) => mapTabRow(row, workspaceId));
  }

  findTab(workspaceId: string, tabId: string): StoredBrowserTab | undefined {
    const row = this.#database.get<BrowserTabRow>(
      `SELECT id, workspace_id, url, title, created_at, updated_at
       FROM browser_tabs
       WHERE workspace_id = ? AND id = ?`,
      [workspaceId, tabId],
    );
    return row ? mapTabRow(row, workspaceId) : undefined;
  }

  listBookmarks(workspaceId: string): StoredBrowserBookmark[] {
    return this.#database
      .all<BrowserBookmarkRow>(
        `SELECT id, workspace_id, url, title, created_at
         FROM browser_bookmarks
         WHERE workspace_id = ?
         ORDER BY created_at, id`,
        [workspaceId],
      )
      .map((row) => mapBookmarkRow(row, workspaceId));
  }

  findBookmark(workspaceId: string, bookmarkId: string): StoredBrowserBookmark | undefined {
    const row = this.#database.get<BrowserBookmarkRow>(
      `SELECT id, workspace_id, url, title, created_at
       FROM browser_bookmarks
       WHERE workspace_id = ? AND id = ?`,
      [workspaceId, bookmarkId],
    );
    return row ? mapBookmarkRow(row, workspaceId) : undefined;
  }

  findBookmarkByUrl(workspaceId: string, url: string): StoredBrowserBookmark | undefined {
    const row = this.#database.get<BrowserBookmarkRow>(
      `SELECT id, workspace_id, url, title, created_at
       FROM browser_bookmarks
       WHERE workspace_id = ? AND url = ?`,
      [workspaceId, url],
    );
    return row ? mapBookmarkRow(row, workspaceId) : undefined;
  }

  countTabs(workspaceId: string): number {
    return this.#count(
      'SELECT COUNT(*) AS count FROM browser_tabs WHERE workspace_id = ?',
      workspaceId,
      'browser tab count',
    );
  }

  countBookmarks(workspaceId: string): number {
    return this.#count(
      'SELECT COUNT(*) AS count FROM browser_bookmarks WHERE workspace_id = ?',
      workspaceId,
      'browser bookmark count',
    );
  }

  insertTab(record: NewBrowserTabRecord): void {
    this.#assertChanged(
      this.#database.run(
        `INSERT INTO browser_tabs (
           id, workspace_id, url, title, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.workspaceId,
          record.url,
          record.title,
          record.timestamp,
          record.timestamp,
        ],
      ).changes,
      'inserted',
    );
  }

  insertState(workspaceId: string, activeTabId: string, timestamp: string): void {
    this.#assertChanged(
      this.#database.run(
        `INSERT INTO browser_workspace_state (
           workspace_id, active_tab_id, revision, updated_at
         ) VALUES (?, ?, 1, ?)`,
        [workspaceId, activeTabId, timestamp],
      ).changes,
      'initialized',
    );
  }

  updateState(workspaceId: string, activeTabId: string, timestamp: string): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE browser_workspace_state
         SET active_tab_id = ?, revision = revision + 1, updated_at = ?
         WHERE workspace_id = ?`,
        [activeTabId, timestamp, workspaceId],
      ).changes,
      'updated',
    );
  }

  updateTabMetadata(
    workspaceId: string,
    tabId: string,
    url: string,
    title: string,
    timestamp: string,
  ): void {
    this.#assertChanged(
      this.#database.run(
        `UPDATE browser_tabs
         SET url = ?, title = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
        [url, title, timestamp, workspaceId, tabId],
      ).changes,
      'updated',
    );
  }

  deleteTab(workspaceId: string, tabId: string): void {
    this.#assertChanged(
      this.#database.run('DELETE FROM browser_tabs WHERE workspace_id = ? AND id = ?', [
        workspaceId,
        tabId,
      ]).changes,
      'closed',
    );
  }

  insertBookmark(record: NewBrowserBookmarkRecord): void {
    this.#assertChanged(
      this.#database.run(
        `INSERT INTO browser_bookmarks (
           id, workspace_id, url, title, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
        [record.id, record.workspaceId, record.url, record.title, record.timestamp],
      ).changes,
      'bookmarked',
    );
  }

  deleteBookmark(workspaceId: string, bookmarkId: string): void {
    this.#assertChanged(
      this.#database.run('DELETE FROM browser_bookmarks WHERE workspace_id = ? AND id = ?', [
        workspaceId,
        bookmarkId,
      ]).changes,
      'removed from bookmarks',
    );
  }

  validateIntegrity(): void {
    const tabs = this.#database
      .all<BrowserTabRow>(
        `SELECT id, workspace_id, url, title, created_at, updated_at
         FROM browser_tabs
         ORDER BY workspace_id, created_at, id`,
      )
      .map((row) => mapTabRow(row, undefined));
    const states = this.#database
      .all<BrowserStateRow>(
        `SELECT workspace_id, active_tab_id, revision, updated_at
         FROM browser_workspace_state
         ORDER BY workspace_id`,
      )
      .map((row) => mapStateRow(row, undefined));
    const bookmarks = this.#database
      .all<BrowserBookmarkRow>(
        `SELECT id, workspace_id, url, title, created_at
         FROM browser_bookmarks
         ORDER BY workspace_id, created_at, id`,
      )
      .map((row) => mapBookmarkRow(row, undefined));

    const statesByWorkspace = new Map(states.map((state) => [state.workspaceId, state]));
    for (const state of states) {
      const workspaceTabs = tabs.filter((tab) => tab.workspaceId === state.workspaceId);
      const workspaceBookmarks = bookmarks.filter(
        (bookmark) => bookmark.workspaceId === state.workspaceId,
      );
      if (!workspaceTabs.some(({ id }) => id === state.activeTabId)) {
        throw new DatabaseIntegrityError('Browser state points to a missing workspace tab.');
      }
      const latestPersistentTimestamp = [
        ...workspaceTabs.map(({ updatedAt }) => updatedAt),
        ...workspaceBookmarks.map(({ createdAt }) => createdAt),
      ].reduce((latest, value) => (value > latest ? value : latest), state.updatedAt);
      if (state.updatedAt < latestPersistentTimestamp) {
        throw new DatabaseIntegrityError(
          'Browser state update time precedes its persisted workspace data.',
        );
      }
    }
    for (const tab of tabs) {
      if (!statesByWorkspace.has(tab.workspaceId)) {
        throw new DatabaseIntegrityError('A browser tab exists without workspace state.');
      }
    }
    for (const bookmark of bookmarks) {
      if (!statesByWorkspace.has(bookmark.workspaceId)) {
        throw new DatabaseIntegrityError('A browser bookmark exists without workspace state.');
      }
    }

    this.#validateGroupLimits(
      `SELECT workspace_id, COUNT(*) AS count
       FROM browser_tabs
       GROUP BY workspace_id`,
      BROWSER_MAX_TABS,
      'browser tab',
    );
    this.#validateGroupLimits(
      `SELECT workspace_id, COUNT(*) AS count
       FROM browser_bookmarks
       GROUP BY workspace_id`,
      BROWSER_MAX_BOOKMARKS,
      'browser bookmark',
    );
  }

  #validateGroupLimits(sql: string, maximum: number, name: string): void {
    for (const row of this.#database.all<WorkspaceCountRow>(sql)) {
      readWorkspaceId(row.workspace_id);
      const count = readCount(row.count, `${name} count`);
      if (count < 1 || count > maximum) {
        throw new DatabaseIntegrityError(`The ${name} workspace count is invalid.`);
      }
    }
  }

  #count(sql: string, workspaceId: string, name: string): number {
    return readCount(this.#database.get<CountRow>(sql, [workspaceId])?.count, name);
  }

  #assertChanged(value: unknown, operation: string): void {
    if (typeof value !== 'number' || Number(value) !== 1) {
      throw new DatabaseIntegrityError(`The browser item could not be ${operation}.`);
    }
  }
}

function mapTabRow(row: BrowserTabRow, expectedWorkspaceId: string | undefined): StoredBrowserTab {
  let id: string;
  let workspaceId: string;
  let url: string;
  let title: string;
  try {
    id = normalizeBrowserId(row.id);
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    url = normalizeBrowserUrl(readString(row.url, 'browser tab URL'));
    title = normalizeBrowserTitle(row.title);
  } catch (error) {
    throw new DatabaseIntegrityError('Browser tab row contains invalid values.', { cause: error });
  }
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new DatabaseIntegrityError('Browser tab belongs to an unexpected workspace.');
  }
  if (row.url !== url || row.title !== title) {
    throw new DatabaseIntegrityError('Browser tab text normalization is invalid.');
  }
  const createdAt = readTimestamp(row.created_at, 'browser tab creation time');
  const updatedAt = readTimestamp(row.updated_at, 'browser tab update time');
  if (updatedAt < createdAt) {
    throw new DatabaseIntegrityError('Browser tab update time precedes its creation time.');
  }
  return { id, workspaceId, url, title, createdAt, updatedAt };
}

function mapStateRow(
  row: BrowserStateRow,
  expectedWorkspaceId: string | undefined,
): StoredBrowserState {
  let workspaceId: string;
  let activeTabId: string;
  let revision: number;
  try {
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    activeTabId = normalizeBrowserId(row.active_tab_id);
    revision = normalizeBrowserRevision(row.revision);
  } catch (error) {
    throw new DatabaseIntegrityError('Browser state row contains invalid values.', {
      cause: error,
    });
  }
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new DatabaseIntegrityError('Browser state belongs to an unexpected workspace.');
  }
  return {
    workspaceId,
    activeTabId,
    revision,
    updatedAt: readTimestamp(row.updated_at, 'browser state update time'),
  };
}

function mapBookmarkRow(
  row: BrowserBookmarkRow,
  expectedWorkspaceId: string | undefined,
): StoredBrowserBookmark {
  let id: string;
  let workspaceId: string;
  let url: string;
  let title: string;
  try {
    id = normalizeBrowserId(row.id);
    workspaceId = normalizeWorkspaceId(row.workspace_id);
    url = normalizeBrowserUrl(readString(row.url, 'browser bookmark URL'));
    title = normalizeBrowserTitle(row.title);
  } catch (error) {
    throw new DatabaseIntegrityError('Browser bookmark row contains invalid values.', {
      cause: error,
    });
  }
  if (url === 'about:blank') {
    throw new DatabaseIntegrityError('Browser bookmarks must use HTTP or HTTPS.');
  }
  if (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) {
    throw new DatabaseIntegrityError('Browser bookmark belongs to an unexpected workspace.');
  }
  if (row.url !== url || row.title !== title) {
    throw new DatabaseIntegrityError('Browser bookmark text normalization is invalid.');
  }
  return {
    id,
    workspaceId,
    url,
    title,
    createdAt: readTimestamp(row.created_at, 'browser bookmark creation time'),
  };
}

function toPublicTab(tab: StoredBrowserTab): BrowserTabData {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  };
}

function toPublicBookmark(bookmark: StoredBrowserBookmark): BrowserBookmarkData {
  return {
    id: bookmark.id,
    url: bookmark.url,
    title: bookmark.title,
    createdAt: bookmark.createdAt,
  };
}

function readWorkspaceId(value: unknown): string {
  try {
    return normalizeWorkspaceId(value);
  } catch (error) {
    throw new DatabaseIntegrityError('Browser workspace id is invalid.', { cause: error });
  }
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  return value;
}

function readTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  return value;
}

function readCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  return value;
}
