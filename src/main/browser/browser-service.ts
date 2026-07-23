import { randomUUID } from 'node:crypto';
import {
  BROWSER_DEFAULT_TITLE,
  BROWSER_DEFAULT_URL,
  BROWSER_MAX_BOOKMARKS,
  BROWSER_MAX_TABS,
  normalizeBrowserId,
  sanitizeBrowserTitle,
} from '../../shared/browser-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { normalizeBrowserUrl } from '../security/browser-url';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  BrowserConflictError,
  BrowserError,
  BrowserNotFoundError,
  BrowserOperationError,
  BrowserValidationError,
} from './browser-errors';
import {
  BrowserRepository,
  type BrowserData,
  type BrowserTabData,
  type StoredBrowserState,
  type StoredBrowserTab,
} from './browser-repository';

export type {
  BrowserBookmarkData,
  BrowserData,
  BrowserTabData,
  StoredBrowserBookmark,
  StoredBrowserState,
  StoredBrowserTab,
} from './browser-repository';

export interface BrowserWorkspaceDataInput {
  readonly workspaceId: string;
}

export interface BrowserCreateTabDataInput extends BrowserWorkspaceDataInput {
  readonly url?: string;
}

export interface BrowserTabDataInput extends BrowserWorkspaceDataInput {
  readonly tabId: string;
}

export interface BrowserTabMetadataInput extends BrowserTabDataInput {
  readonly url: string;
  readonly title: string;
}

export interface BrowserBookmarkDataInput extends BrowserWorkspaceDataInput {
  readonly bookmarkId: string;
}

export type BrowserOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface BrowserServiceOptions {
  readonly execute: BrowserOperationExecutor;
  readonly now?: () => Date;
  readonly tabIdFactory?: () => string;
  readonly bookmarkIdFactory?: () => string;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

export class BrowserService {
  readonly #execute: BrowserOperationExecutor;
  readonly #now: () => Date;
  readonly #tabIdFactory: () => string;
  readonly #bookmarkIdFactory: () => string;
  readonly #onFatalTransaction: (error: DatabaseIntegrityError) => void;

  constructor({
    execute,
    now = () => new Date(),
    tabIdFactory = randomUUID,
    bookmarkIdFactory = randomUUID,
    onFatalTransaction = () => undefined,
  }: BrowserServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#tabIdFactory = tabIdFactory;
    this.#bookmarkIdFactory = bookmarkIdFactory;
    this.#onFatalTransaction = onFatalTransaction;
  }

  validateSnapshot(database: SqliteAdapter): void {
    new BrowserRepository(database).validateIntegrity();
  }

  getData(input: BrowserWorkspaceDataInput): Promise<BrowserData> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    return this.#execute((database) => {
      const workspace = this.#requireActiveWorkspace(database, workspaceId);
      const repository = new BrowserRepository(database);
      const state = repository.findState(workspaceId);
      if (state) {
        return repository.readData(workspaceId);
      }
      if (repository.countTabs(workspaceId) !== 0 || repository.countBookmarks(workspaceId) !== 0) {
        throw new DatabaseIntegrityError('Uninitialized browser data contains orphaned rows.');
      }
      return this.#transaction(database, 'initialize browser data', (browser) => {
        const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
        const tabId = this.#newTabId();
        browser.insertTab({
          id: tabId,
          workspaceId,
          url: BROWSER_DEFAULT_URL,
          title: BROWSER_DEFAULT_TITLE,
          timestamp,
        });
        browser.insertState(workspaceId, tabId, timestamp);
        return browser.readData(workspaceId);
      });
    });
  }

  createTab(input: BrowserCreateTabDataInput): Promise<BrowserData> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const url = input?.url === undefined ? BROWSER_DEFAULT_URL : this.#url(input.url);
    return this.#execute((database) =>
      this.#transaction(database, 'create a browser tab', (browser) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const state = this.#ensureInitialized(browser, workspace);
        if (browser.countTabs(workspaceId) >= BROWSER_MAX_TABS) {
          throw new BrowserConflictError(`A workspace can have at most ${BROWSER_MAX_TABS} tabs.`);
        }
        const timestamp = this.#timestampAtLeast(
          workspace.createdAt,
          workspace.updatedAt,
          state.updatedAt,
        );
        const tabId = this.#newTabId();
        browser.insertTab({
          id: tabId,
          workspaceId,
          url,
          title: BROWSER_DEFAULT_TITLE,
          timestamp,
        });
        browser.updateState(workspaceId, tabId, timestamp);
        return browser.readData(workspaceId);
      }),
    );
  }

  activateTab(input: BrowserTabDataInput): Promise<BrowserData> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const tabId = this.#tabId(input?.tabId);
    return this.#execute((database) =>
      this.#transaction(database, 'activate a browser tab', (browser) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const state = this.#ensureInitialized(browser, workspace);
        const tab = this.#requireTab(browser, workspaceId, tabId);
        if (state.activeTabId !== tabId) {
          browser.updateState(
            workspaceId,
            tabId,
            this.#timestampAtLeast(
              workspace.createdAt,
              workspace.updatedAt,
              state.updatedAt,
              tab.createdAt,
              tab.updatedAt,
            ),
          );
        }
        return browser.readData(workspaceId);
      }),
    );
  }

  closeTab(input: BrowserTabDataInput): Promise<BrowserData> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const tabId = this.#tabId(input?.tabId);
    return this.#execute((database) =>
      this.#transaction(database, 'close a browser tab', (browser) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const state = this.#ensureInitialized(browser, workspace);
        const tab = this.#requireTab(browser, workspaceId, tabId);
        const tabs = browser.listTabs(workspaceId);
        const timestamp = this.#timestampAtLeast(
          workspace.createdAt,
          workspace.updatedAt,
          state.updatedAt,
          tab.createdAt,
          tab.updatedAt,
        );

        if (tabs.length === 1) {
          browser.updateTabMetadata(
            workspaceId,
            tabId,
            BROWSER_DEFAULT_URL,
            BROWSER_DEFAULT_TITLE,
            timestamp,
          );
          browser.updateState(workspaceId, tabId, timestamp);
          return browser.readData(workspaceId);
        }

        if (state.activeTabId === tabId) {
          const index = tabs.findIndex(({ id }) => id === tabId);
          const fallback = tabs[index + 1] ?? tabs[index - 1];
          if (!fallback) {
            throw new DatabaseIntegrityError('A browser tab close fallback is missing.');
          }
          browser.updateState(
            workspaceId,
            fallback.id,
            this.#timestampAtLeast(timestamp, fallback.createdAt, fallback.updatedAt),
          );
        } else {
          browser.updateState(workspaceId, state.activeTabId, timestamp);
        }
        browser.deleteTab(workspaceId, tabId);
        return browser.readData(workspaceId);
      }),
    );
  }

  persistTabMetadata(input: BrowserTabMetadataInput): Promise<BrowserData> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const tabId = this.#tabId(input?.tabId);
    const url = this.#url(input?.url);
    const title = sanitizeBrowserTitle(input?.title);
    return this.#execute((database) =>
      this.#transaction(database, 'persist browser tab metadata', (browser) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const state = this.#ensureInitialized(browser, workspace);
        const tab = this.#requireTab(browser, workspaceId, tabId);
        if (tab.url !== url || tab.title !== title) {
          const timestamp = this.#timestampAtLeast(
            workspace.createdAt,
            workspace.updatedAt,
            state.updatedAt,
            tab.createdAt,
            tab.updatedAt,
          );
          browser.updateTabMetadata(workspaceId, tabId, url, title, timestamp);
          browser.updateState(workspaceId, state.activeTabId, timestamp);
        }
        return browser.readData(workspaceId);
      }),
    );
  }

  toggleBookmark(input: BrowserTabDataInput): Promise<BrowserData> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const tabId = this.#tabId(input?.tabId);
    return this.#execute((database) =>
      this.#transaction(database, 'toggle a browser bookmark', (browser) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const state = this.#ensureInitialized(browser, workspace);
        const tab = this.#requireTab(browser, workspaceId, tabId);
        if (tab.url === 'about:blank') {
          throw new BrowserValidationError('The blank browser page cannot be bookmarked.');
        }
        const existing = browser.findBookmarkByUrl(workspaceId, tab.url);
        const timestamp = this.#timestampAtLeast(
          workspace.createdAt,
          workspace.updatedAt,
          state.updatedAt,
          tab.createdAt,
          tab.updatedAt,
          ...(existing ? [existing.createdAt] : []),
        );
        if (existing) {
          browser.deleteBookmark(workspaceId, existing.id);
        } else {
          if (browser.countBookmarks(workspaceId) >= BROWSER_MAX_BOOKMARKS) {
            throw new BrowserConflictError(
              `A workspace can have at most ${BROWSER_MAX_BOOKMARKS} bookmarks.`,
            );
          }
          browser.insertBookmark({
            id: this.#newBookmarkId(),
            workspaceId,
            url: tab.url,
            title: tab.title,
            timestamp,
          });
        }
        browser.updateState(workspaceId, state.activeTabId, timestamp);
        return browser.readData(workspaceId);
      }),
    );
  }

  removeBookmark(input: BrowserBookmarkDataInput): Promise<BrowserData> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const bookmarkId = this.#bookmarkId(input?.bookmarkId);
    return this.#execute((database) =>
      this.#transaction(database, 'remove a browser bookmark', (browser) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const state = this.#ensureInitialized(browser, workspace);
        const bookmark = browser.findBookmark(workspaceId, bookmarkId);
        if (!bookmark) throw new BrowserNotFoundError('The browser bookmark is unavailable.');
        const timestamp = this.#timestampAtLeast(
          workspace.createdAt,
          workspace.updatedAt,
          state.updatedAt,
          bookmark.createdAt,
        );
        browser.deleteBookmark(workspaceId, bookmarkId);
        browser.updateState(workspaceId, state.activeTabId, timestamp);
        return browser.readData(workspaceId);
      }),
    );
  }

  #ensureInitialized(
    repository: BrowserRepository,
    workspace: { readonly id: string; readonly createdAt: string; readonly updatedAt: string },
  ): StoredBrowserState {
    const state = repository.findState(workspace.id);
    if (state) return state;
    if (repository.countTabs(workspace.id) !== 0 || repository.countBookmarks(workspace.id) !== 0) {
      throw new DatabaseIntegrityError('Uninitialized browser data contains orphaned rows.');
    }
    const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
    const tabId = this.#newTabId();
    repository.insertTab({
      id: tabId,
      workspaceId: workspace.id,
      url: BROWSER_DEFAULT_URL,
      title: BROWSER_DEFAULT_TITLE,
      timestamp,
    });
    repository.insertState(workspace.id, tabId, timestamp);
    return repository.readState(workspace.id);
  }

  #transaction<T>(
    database: SqliteAdapter,
    operation: string,
    callback: (repository: BrowserRepository) => T,
  ): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError('A browser operation encountered an active transaction.');
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(new BrowserRepository(database));
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The browser operation escaped its transaction.');
      }
      commitStarted = true;
      database.exec('COMMIT');
      return result;
    } catch (error) {
      const transactionActiveAtFailure = database.isTransaction;
      let rollbackError: unknown;
      try {
        if (transactionStarted && transactionActiveAtFailure) database.exec('ROLLBACK');
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
      const transactionRemainsActive = database.isTransaction;
      const commitOutcomeUnknown = commitStarted && !transactionActiveAtFailure;
      if (
        rollbackError !== undefined ||
        transactionRemainsActive ||
        transactionEscaped ||
        commitOutcomeUnknown
      ) {
        const cause =
          rollbackError === undefined
            ? error
            : new AggregateError([error, rollbackError], 'The browser operation rollback failed.');
        const fatalError = new DatabaseIntegrityError(
          'The browser transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof BrowserError || error instanceof DatabaseIntegrityError) throw error;
      throw new BrowserOperationError(`The browser service could not ${operation}.`, {
        cause: error,
      });
    }
  }

  #requireActiveWorkspace(database: SqliteAdapter, workspaceId: string) {
    const workspace = new WorkspaceRepository(database).findActive(workspaceId);
    if (!workspace) throw new BrowserNotFoundError('The browser workspace is unavailable.');
    return workspace;
  }

  #requireTab(repository: BrowserRepository, workspaceId: string, tabId: string): StoredBrowserTab {
    const tab = repository.findTab(workspaceId, tabId);
    if (!tab) throw new BrowserNotFoundError('The browser tab is unavailable.');
    return tab;
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new BrowserValidationError('Browser workspace id is invalid.', { cause: error });
    }
  }

  #newTabId(): string {
    try {
      return normalizeBrowserId(this.#tabIdFactory());
    } catch (error) {
      throw new BrowserValidationError('Generated browser tab id is invalid.', { cause: error });
    }
  }

  #newBookmarkId(): string {
    try {
      return normalizeBrowserId(this.#bookmarkIdFactory());
    } catch (error) {
      throw new BrowserValidationError('Generated browser bookmark id is invalid.', {
        cause: error,
      });
    }
  }

  #tabId(value: unknown): string {
    try {
      return normalizeBrowserId(value);
    } catch (error) {
      throw new BrowserValidationError('Browser tab id is invalid.', { cause: error });
    }
  }

  #bookmarkId(value: unknown): string {
    try {
      return normalizeBrowserId(value);
    } catch (error) {
      throw new BrowserValidationError('Browser bookmark id is invalid.', { cause: error });
    }
  }

  #url(value: unknown): string {
    try {
      if (typeof value !== 'string') throw new TypeError('Browser URL must be a string.');
      return normalizeBrowserUrl(value);
    } catch (error) {
      throw new BrowserValidationError('Browser URL is invalid.', { cause: error });
    }
  }

  #validNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new BrowserValidationError('Browser timestamp is invalid.');
    }
    return value;
  }

  #timestampAtLeast(...lowerBounds: readonly string[]): string {
    let latest = this.#validNow().toISOString();
    for (const lowerBound of lowerBounds) {
      const timestamp = new Date(lowerBound);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== lowerBound) {
        throw new BrowserValidationError('Browser timestamp boundary is invalid.');
      }
      if (lowerBound > latest) latest = lowerBound;
    }
    return latest;
  }
}

export function findBrowserTab(
  data: Pick<BrowserData, 'tabs'>,
  tabId: string,
): BrowserTabData | undefined {
  return data.tabs.find(({ id }) => id === tabId);
}
