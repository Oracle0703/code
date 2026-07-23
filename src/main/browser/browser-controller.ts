import {
  app,
  session as electronSession,
  shell,
  type BrowserWindow,
  type Rectangle,
  type WebContents,
  WebContentsView,
} from 'electron';
import type {
  BrowserBookmark,
  BrowserBookmarkTargetInput,
  BrowserBoundsInput,
  BrowserCreateTabInput,
  BrowserDownloadTargetInput,
  BrowserNavigateInput,
  BrowserOpenBookmarkInput,
  BrowserSnapshot,
  BrowserTab,
  BrowserTabTargetInput,
  BrowserVisibilityInput,
  BrowserWorkspaceInput,
} from '../../shared/contracts';
import {
  BROWSER_DEFAULT_TITLE,
  BROWSER_DEFAULT_URL,
  sanitizeBrowserTitle,
} from '../../shared/browser-domain';
import { getBrowserShortcutAction } from '../../shared/browser-shortcut';
import { isQuickCaptureShortcut } from '../../shared/quick-capture-shortcut';
import { DownloadManager } from '../downloads';
import { isAllowedBrowserUrl, normalizeBrowserUrl } from '../security/browser-url';
import { BrowserConflictError, BrowserNotFoundError } from './browser-errors';
import type { BrowserData } from './browser-repository';

type SnapshotListener = (snapshot: BrowserSnapshot) => void;
type VoidListener = () => void;

export interface BrowserPersistence {
  getBrowserData(input: { readonly workspaceId: string }): Promise<BrowserData>;
  createBrowserTab(input: {
    readonly workspaceId: string;
    readonly url?: string;
  }): Promise<BrowserData>;
  activateBrowserTab(input: {
    readonly workspaceId: string;
    readonly tabId: string;
  }): Promise<BrowserData>;
  closeBrowserTab(input: {
    readonly workspaceId: string;
    readonly tabId: string;
  }): Promise<BrowserData>;
  persistBrowserTabMetadata(input: {
    readonly workspaceId: string;
    readonly tabId: string;
    readonly url: string;
    readonly title: string;
  }): Promise<BrowserData>;
  toggleBrowserBookmark(input: {
    readonly workspaceId: string;
    readonly tabId: string;
  }): Promise<BrowserData>;
  removeBrowserBookmark(input: {
    readonly workspaceId: string;
    readonly bookmarkId: string;
  }): Promise<BrowserData>;
}

export interface BrowserControllerCallbacks {
  readonly onStateChange: SnapshotListener;
  readonly onQuickCapture?: VoidListener;
  readonly onFocusAddress?: VoidListener;
}

interface RuntimeTab {
  readonly id: string;
  view: WebContentsView | null;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  hasLoaded: boolean;
  persistedUrl: string;
  persistedTitle: string;
  pendingNavigationUrl: string | null;
  pendingNavigationToken: number | null;
  navigationSequence: number;
  desiredMetadata: {
    readonly url: string;
    readonly title: string;
    readonly generation: number;
  } | null;
  metadataWorker: Promise<void> | null;
  persistenceTail: Promise<void>;
  persistenceError: unknown | null;
  suppressLiveMetadata: number;
  closing: boolean;
}

interface WorkspaceRuntime {
  readonly workspaceId: string;
  readonly tabs: Map<string, RuntimeTab>;
  activeTabId: string;
  bookmarks: readonly BrowserBookmark[];
  revision: number;
}

interface TabMetadataSnapshot {
  readonly url: string;
  readonly title: string;
}

export class BrowserController {
  readonly #browserSession = electronSession.fromPartition('persist:workbench-browser');
  readonly #workspaces = new Map<string, WorkspaceRuntime>();
  readonly #revisionByWorkspace = new Map<string, number>();
  readonly #contentsSources = new Map<WebContents, { workspaceId: string; tabId: string }>();
  readonly #downloads: DownloadManager;
  #activeWorkspaceId: string | null = null;
  #workspaceGeneration = 0;
  #workspaceTransitionTail: Promise<void> = Promise.resolve();
  #transitioningWorkspaceId: string | null = null;
  #requestedBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  #visible = false;
  #shuttingDown = false;
  #destroyed = false;
  #shutdownPromise: Promise<void> | null = null;
  readonly #activeOperations = new Set<Promise<unknown>>();

  readonly #handleParentResize = (): void => {
    this.#applyBounds();
  };

  public constructor(
    private readonly parentWindow: BrowserWindow,
    private readonly persistence: BrowserPersistence,
    private readonly callbacks: BrowserControllerCallbacks,
  ) {
    this.parentWindow.on('resize', this.#handleParentResize);
    this.#browserSession.setPermissionCheckHandler(() => false);
    this.#browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    this.#downloads = new DownloadManager({
      session: this.#browserSession,
      downloadsDirectory: app.getPath('downloads'),
      resolveSource: (contents) => {
        const source = this.#contentsSources.get(contents);
        return source ? { workspaceId: source.workspaceId } : null;
      },
      onChange: (workspaceId) => {
        const context = this.#workspaces.get(workspaceId);
        if (!context || this.#destroyed) return;
        this.#bumpRevision(context);
        this.#emitSnapshot(context);
      },
      revealPath: (path) => shell.showItemInFolder(path),
    });
  }

  public getSnapshot(input: BrowserWorkspaceInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const context = await this.#activateWorkspace(input.workspaceId);
      return this.#snapshot(context);
    });
  }

  public createTab(input: BrowserCreateTabInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const generation = this.#requireActiveGeneration(input.workspaceId);
      const data = await this.persistence.createBrowserTab({
        workspaceId: input.workspaceId,
        ...(input.url === undefined ? {} : { url: normalizeBrowserUrl(input.url) }),
      });
      const context = this.#applyPersistenceResult(data, generation);
      this.#showActiveTab(context);
      return this.#snapshot(context);
    });
  }

  public activateTab(input: BrowserTabTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const generation = this.#requireActiveGeneration(input.workspaceId);
      const existingContext = this.#requireWorkspace(input.workspaceId);
      const existingTab = this.#requireTab(existingContext, input.tabId);
      const data = await this.persistence.activateBrowserTab(input);
      this.#assertTabOperationCurrent(existingContext, existingTab);
      const context = this.#applyPersistenceResult(data, generation);
      this.#showActiveTab(context);
      return this.#snapshot(context);
    });
  }

  public closeTab(input: BrowserTabTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const generation = this.#requireActiveGeneration(input.workspaceId);
      const existingContext = this.#requireWorkspace(input.workspaceId);
      const existingTab = this.#requireTab(existingContext, input.tabId);
      this.#captureTabMetadata(existingTab);
      const metadata = this.#tabMetadataSnapshot(existingTab);
      existingTab.closing = true;
      let data: BrowserData;
      try {
        await this.#flushFrozenTabMetadata(input.workspaceId, existingTab, generation, metadata);
        this.#assertCurrentGeneration(input.workspaceId, generation);
        this.#assertTabOperationCurrent(existingContext, existingTab, true);
        data = await this.persistence.closeBrowserTab(input);
      } catch (error) {
        if (existingContext.tabs.get(input.tabId) === existingTab) {
          existingTab.closing = false;
          if (existingTab.pendingNavigationToken !== null) {
            existingTab.pendingNavigationToken = null;
            existingTab.pendingNavigationUrl = null;
            existingTab.navigationSequence += 1;
          }
          if (this.#isCurrentGeneration(input.workspaceId, generation)) {
            this.#captureTabMetadata(existingTab);
            const contents = existingTab.view?.webContents;
            if (contents && !contents.isDestroyed()) {
              existingTab.isLoading = contents.isLoading();
              this.#syncTab(existingContext, existingTab, existingTab.url, existingTab.isLoading);
            }
            this.#persistLiveMetadata(input.workspaceId, existingTab);
          }
        }
        throw error;
      }
      if (
        existingContext.tabs.get(input.tabId) === existingTab &&
        existingContext.tabs.size === 1 &&
        data.tabs.length === 1 &&
        data.tabs[0]?.id === input.tabId
      ) {
        this.#destroyTab(existingTab);
        existingContext.tabs.delete(input.tabId);
      }
      const context = this.#applyPersistenceResult(data, generation);
      this.#showActiveTab(context);
      return this.#snapshot(context);
    });
  }

  public navigate(input: BrowserNavigateInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const generation = this.#requireActiveGeneration(input.workspaceId);
      const context = this.#requireWorkspace(input.workspaceId);
      const tab = this.#requireTab(context, input.tabId);
      this.#materializeTab(context, tab);
      const url = normalizeBrowserUrl(input.url);
      tab.suppressLiveMetadata += 1;
      try {
        await this.#flushTabMetadata(input.workspaceId, tab, generation);
        this.#assertCurrentGeneration(input.workspaceId, generation);
        this.#assertTabOperationCurrent(context, tab);
        await this.#queueTabMetadata(
          input.workspaceId,
          tab,
          generation,
          url,
          sanitizeBrowserTitle(tab.title),
        );
        this.#assertCurrentGeneration(input.workspaceId, generation);
        this.#assertTabOperationCurrent(context, tab);
        tab.url = url;
        tab.persistedUrl = url;
        tab.pendingNavigationUrl = url;
        const navigationToken = ++tab.navigationSequence;
        tab.pendingNavigationToken = navigationToken;
        tab.isLoading = true;
        tab.hasLoaded = true;
        this.#bumpRevision(context);
        this.#emitSnapshot(context);
        const navigationContents = this.#requireTabContents(tab);
        const navigation = navigationContents.loadURL(url);
        void navigation.then(
          () => {
            if (
              !this.#destroyed &&
              this.#isCurrentGeneration(input.workspaceId, generation) &&
              tab.pendingNavigationToken === navigationToken &&
              this.#isCurrentTabContents(tab, navigationContents)
            ) {
              tab.pendingNavigationToken = null;
              tab.pendingNavigationUrl = null;
              const finalUrl = navigationContents.getURL();
              tab.url = isAllowedBrowserUrl(finalUrl) ? normalizeBrowserUrl(finalUrl) : url;
              tab.title = sanitizeBrowserTitle(navigationContents.getTitle() || tab.title);
              tab.isLoading = navigationContents.isLoading();
              this.#syncTab(context, tab, tab.url, tab.isLoading);
              this.#persistLiveMetadata(input.workspaceId, tab);
            }
          },
          (error: unknown) => {
            if (
              this.#destroyed ||
              !this.#isCurrentGeneration(input.workspaceId, generation) ||
              tab.pendingNavigationToken !== navigationToken ||
              !this.#isCurrentTabContents(tab, navigationContents)
            ) {
              return;
            }
            tab.pendingNavigationToken = null;
            tab.pendingNavigationUrl = null;
            if (this.#isNavigationCancellation(error)) {
              const currentUrl = navigationContents.getURL();
              if (isAllowedBrowserUrl(currentUrl)) {
                tab.url = normalizeBrowserUrl(currentUrl);
              }
              tab.title = sanitizeBrowserTitle(navigationContents.getTitle() || tab.title);
              tab.isLoading = navigationContents.isLoading();
              this.#syncTab(context, tab, tab.url, tab.isLoading);
              this.#persistLiveMetadata(input.workspaceId, tab);
            } else {
              tab.url = url;
              tab.isLoading = false;
              this.#syncTab(context, tab, url, false);
            }
          },
        );
        return this.#snapshot(context);
      } finally {
        tab.suppressLiveMetadata -= 1;
      }
    });
  }

  public back(input: BrowserTabTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const { context, tab } = this.#requireActiveTab(input);
      const history = this.#requireTabContents(tab).navigationHistory;
      if (history.canGoBack()) history.goBack();
      this.#syncTab(context, tab);
      return this.#snapshot(context);
    });
  }

  public forward(input: BrowserTabTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const { context, tab } = this.#requireActiveTab(input);
      const history = this.#requireTabContents(tab).navigationHistory;
      if (history.canGoForward()) history.goForward();
      this.#syncTab(context, tab);
      return this.#snapshot(context);
    });
  }

  public reload(input: BrowserTabTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const { context, tab } = this.#requireActiveTab(input);
      this.#ensureTabLoaded(context, tab);
      this.#requireTabContents(tab).reload();
      this.#syncTab(context, tab);
      return this.#snapshot(context);
    });
  }

  public stop(input: BrowserTabTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const { context, tab } = this.#requireActiveTab(input);
      this.#requireTabContents(tab).stop();
      tab.isLoading = false;
      this.#syncTab(context, tab);
      return this.#snapshot(context);
    });
  }

  public toggleBookmark(input: BrowserTabTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const generation = this.#requireActiveGeneration(input.workspaceId);
      const context = this.#requireWorkspace(input.workspaceId);
      const tab = this.#requireTab(context, input.tabId);
      this.#captureTabMetadata(tab);
      const metadata = this.#tabMetadataSnapshot(tab);
      tab.suppressLiveMetadata += 1;
      try {
        await this.#flushFrozenTabMetadata(input.workspaceId, tab, generation, metadata);
        this.#assertCurrentGeneration(input.workspaceId, generation);
        this.#assertTabOperationCurrent(context, tab);
        const data = await this.persistence.toggleBrowserBookmark(input);
        this.#assertTabOperationCurrent(context, tab);
        return this.#snapshot(this.#applyPersistenceResult(data, generation));
      } finally {
        tab.suppressLiveMetadata -= 1;
        if (
          this.#isCurrentGeneration(input.workspaceId, generation) &&
          context.tabs.get(tab.id) === tab
        ) {
          this.#captureTabMetadata(tab);
          this.#persistLiveMetadata(input.workspaceId, tab);
        }
      }
    });
  }

  public removeBookmark(input: BrowserBookmarkTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const generation = this.#requireActiveGeneration(input.workspaceId);
      return this.#snapshot(
        this.#applyPersistenceResult(
          await this.persistence.removeBrowserBookmark(input),
          generation,
        ),
      );
    });
  }

  public openBookmark(input: BrowserOpenBookmarkInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const context = this.#requireWorkspace(input.workspaceId);
      this.#requireActiveGeneration(input.workspaceId);
      const bookmark = context.bookmarks.find(({ id }) => id === input.bookmarkId);
      if (!bookmark) throw new BrowserNotFoundError('The browser bookmark is unavailable.');
      if (input.newTab) {
        return this.createTab({ workspaceId: input.workspaceId, url: bookmark.url });
      }
      return this.navigate({
        workspaceId: input.workspaceId,
        tabId: context.activeTabId,
        url: bookmark.url,
      });
    });
  }

  public pauseDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const context = this.#requireWorkspace(input.workspaceId);
      this.#requireActiveGeneration(input.workspaceId);
      this.#downloads.pause(input.workspaceId, input.downloadId);
      return this.#snapshot(context);
    });
  }

  public resumeDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const context = this.#requireWorkspace(input.workspaceId);
      this.#requireActiveGeneration(input.workspaceId);
      this.#downloads.resume(input.workspaceId, input.downloadId);
      return this.#snapshot(context);
    });
  }

  public cancelDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const context = this.#requireWorkspace(input.workspaceId);
      this.#requireActiveGeneration(input.workspaceId);
      this.#downloads.cancel(input.workspaceId, input.downloadId);
      return this.#snapshot(context);
    });
  }

  public dismissDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const context = this.#requireWorkspace(input.workspaceId);
      this.#requireActiveGeneration(input.workspaceId);
      this.#downloads.dismiss(input.workspaceId, input.downloadId);
      return this.#snapshot(context);
    });
  }

  public revealDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot> {
    return this.#runOperation(async () => {
      const context = this.#requireWorkspace(input.workspaceId);
      const generation = this.#requireActiveGeneration(input.workspaceId);
      await this.#downloads.reveal(input.workspaceId, input.downloadId, () => {
        this.#assertCurrentGeneration(input.workspaceId, generation);
      });
      this.#assertCurrentGeneration(input.workspaceId, generation);
      return this.#snapshot(context);
    });
  }

  public setBounds(input: BrowserBoundsInput): Promise<void> {
    return this.#runOperation(async () => {
      this.#requireActiveGeneration(input.workspaceId);
      this.#requestedBounds = { ...input.bounds };
      this.#applyBounds();
    });
  }

  public setVisible(input: BrowserVisibilityInput): Promise<void> {
    return this.#runOperation(async () => {
      if (!input.visible && this.#activeWorkspaceId !== input.workspaceId) {
        return;
      }
      const context = input.visible
        ? await this.#activateWorkspace(input.workspaceId)
        : this.#requireWorkspace(input.workspaceId);
      this.#visible = input.visible;
      this.#showActiveTab(context);
    });
  }

  public shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    if (this.#destroyed) {
      this.#shutdownPromise = Promise.resolve();
      return this.#shutdownPromise;
    }

    this.#shuttingDown = true;
    this.#visible = false;
    this.#hideAllTabs();
    for (const context of this.#workspaces.values()) {
      for (const tab of context.tabs.values()) this.#captureTabMetadata(tab);
    }
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
  }

  public discardWorkspace(workspaceId: string): void {
    if (this.#activeWorkspaceId === workspaceId) {
      this.#workspaceGeneration += 1;
      this.#activeWorkspaceId = null;
      this.#transitioningWorkspaceId = null;
      this.#visible = false;
    }
    const context = this.#workspaces.get(workspaceId);
    this.#workspaces.delete(workspaceId);
    this.#revisionByWorkspace.delete(workspaceId);
    this.#downloads.clearWorkspace(workspaceId);
    if (context) {
      for (const tab of context.tabs.values()) this.#destroyTab(tab);
    }
  }

  public destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#shuttingDown = true;
    this.#workspaceGeneration += 1;
    try {
      this.parentWindow.off('resize', this.#handleParentResize);
    } catch {
      // Continue tearing down native resources after a partially destroyed window.
    }
    this.#downloads.destroy();
    try {
      this.#browserSession.setPermissionCheckHandler(null);
    } catch {
      // The shared session may already be shutting down.
    }
    try {
      this.#browserSession.setPermissionRequestHandler(null);
    } catch {
      // The shared session may already be shutting down.
    }
    for (const context of this.#workspaces.values()) {
      for (const tab of context.tabs.values()) this.#destroyTab(tab);
    }
    this.#workspaces.clear();
    this.#contentsSources.clear();
  }

  async #finishShutdown(): Promise<void> {
    const failures: unknown[] = [];
    await this.#waitForActiveOperations();
    await Promise.allSettled([this.#workspaceTransitionTail]);

    this.#hideAllTabs();
    const frozenTabs = [...this.#workspaces.values()].flatMap((context) =>
      [...context.tabs.values()].map((tab) => {
        this.#captureTabMetadata(tab);
        const frozen = {
          context,
          tab,
          metadata: this.#tabMetadataSnapshot(tab),
        };
        this.#destroyTab(tab);
        return frozen;
      }),
    );

    const flushResults = await Promise.allSettled(
      frozenTabs.map(({ context, tab, metadata }) =>
        this.#flushFrozenTabMetadata(
          context.workspaceId,
          tab,
          this.#workspaceGeneration,
          metadata,
          true,
        ),
      ),
    );
    for (const result of flushResults) {
      if (result.status === 'rejected' && !(result.reason instanceof BrowserNotFoundError)) {
        failures.push(result.reason);
      }
    }

    this.destroy();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'The browser could not finish shutting down cleanly.');
    }
  }

  #runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#shuttingDown || this.#destroyed || this.parentWindow.isDestroyed()) {
      return Promise.reject(
        new BrowserConflictError('The browser controller is no longer available.'),
      );
    }
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#activeOperations.add(pending);
    void pending.then(
      () => this.#activeOperations.delete(pending),
      () => this.#activeOperations.delete(pending),
    );
    return pending;
  }

  async #waitForActiveOperations(): Promise<void> {
    while (this.#activeOperations.size > 0) {
      await Promise.allSettled([...this.#activeOperations]);
    }
  }

  #activateWorkspace(workspaceId: string): Promise<WorkspaceRuntime> {
    const transition = this.#workspaceTransitionTail.then(() =>
      this.#activateWorkspaceAfterPriorTransition(workspaceId),
    );
    this.#workspaceTransitionTail = transition.then(
      () => undefined,
      () => undefined,
    );
    return transition;
  }

  async #activateWorkspaceAfterPriorTransition(workspaceId: string): Promise<WorkspaceRuntime> {
    this.#ensureActive();
    if (this.#activeWorkspaceId === workspaceId) {
      const existing = this.#workspaces.get(workspaceId);
      if (existing) return existing;
    }

    const previousWorkspaceId = this.#activeWorkspaceId;
    const previousGeneration = this.#workspaceGeneration;
    const previousContext =
      previousWorkspaceId === null ? undefined : this.#workspaces.get(previousWorkspaceId);
    if (previousContext) {
      this.#transitioningWorkspaceId = previousContext.workspaceId;
      this.#hideAllTabs();
      const frozenMetadata = new Map<RuntimeTab, TabMetadataSnapshot | null>();
      for (const tab of previousContext.tabs.values()) {
        this.#captureTabMetadata(tab);
        frozenMetadata.set(tab, this.#tabMetadataSnapshot(tab));
        this.#destroyTab(tab);
      }
      try {
        await this.#flushWorkspaceMetadata(previousContext, previousGeneration, frozenMetadata);
        this.#assertWorkspaceGeneration(previousContext.workspaceId, previousGeneration, true);
      } catch (error) {
        if (!(error instanceof BrowserNotFoundError)) {
          this.#transitioningWorkspaceId = null;
          throw error;
        }
      }
      this.#workspaces.clear();
      this.#transitioningWorkspaceId = null;
    }

    this.#activeWorkspaceId = workspaceId;
    const generation = ++this.#workspaceGeneration;
    const data = await this.persistence.getBrowserData({ workspaceId });
    this.#assertCurrentGeneration(workspaceId, generation);

    const previousRevision = this.#revisionByWorkspace.get(workspaceId) ?? 0;
    const context: WorkspaceRuntime = {
      workspaceId,
      tabs: new Map(),
      activeTabId: data.activeTabId,
      bookmarks: [],
      revision: Math.max(data.revision, previousRevision + 1),
    };
    this.#revisionByWorkspace.set(workspaceId, context.revision);
    this.#workspaces.set(workspaceId, context);
    this.#syncPersistenceData(context, data, true);
    this.#showActiveTab(context);
    return context;
  }

  #applyPersistenceResult(data: BrowserData, generation: number): WorkspaceRuntime {
    this.#assertCurrentGeneration(data.workspaceId, generation);
    const context = this.#requireWorkspace(data.workspaceId);
    this.#syncPersistenceData(context, data, false);
    this.#bumpRevision(context, data.revision);
    this.#emitSnapshot(context);
    return context;
  }

  #syncPersistenceData(
    context: WorkspaceRuntime,
    data: BrowserData,
    preferPersistedMetadata: boolean,
  ): void {
    if (data.workspaceId !== context.workspaceId) {
      throw new BrowserConflictError('Browser data was returned for another workspace.');
    }
    const persistedIds = new Set(data.tabs.map(({ id }) => id));
    for (const [id, tab] of context.tabs) {
      if (!persistedIds.has(id)) {
        this.#destroyTab(tab);
        context.tabs.delete(id);
      }
    }
    for (const persisted of data.tabs) {
      const existing = context.tabs.get(persisted.id);
      if (existing) {
        existing.persistedUrl = persisted.url;
        existing.persistedTitle = persisted.title;
        if (preferPersistedMetadata || !existing.hasLoaded) {
          existing.url = persisted.url;
          existing.title = persisted.title;
        }
      } else {
        context.tabs.set(
          persisted.id,
          this.#createTabState(persisted.id, persisted.url, persisted.title),
        );
      }
    }
    if (!context.tabs.has(data.activeTabId)) {
      throw new BrowserConflictError('The active browser tab is missing from the returned data.');
    }
    context.activeTabId = data.activeTabId;
    context.bookmarks = data.bookmarks.map((bookmark) => ({ ...bookmark }));
  }

  #createTabState(tabId: string, url: string, title: string): RuntimeTab {
    return {
      id: tabId,
      view: null,
      url,
      title,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      hasLoaded: false,
      persistedUrl: url,
      persistedTitle: title,
      pendingNavigationUrl: null,
      pendingNavigationToken: null,
      navigationSequence: 0,
      desiredMetadata: null,
      metadataWorker: null,
      persistenceTail: Promise.resolve(),
      persistenceError: null,
      suppressLiveMetadata: 0,
      closing: false,
    };
  }

  #materializeTab(context: WorkspaceRuntime, tab: RuntimeTab): void {
    if (tab.view && !tab.view.webContents.isDestroyed()) return;
    if (tab.view) this.#destroyTab(tab, tab.view);
    const view = new WebContentsView({
      webPreferences: {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        webSecurity: true,
        webviewTag: false,
        partition: 'persist:workbench-browser',
      },
    });
    tab.view = view;
    this.parentWindow.contentView.addChildView(view);
    view.setVisible(false);
    this.#contentsSources.set(view.webContents, {
      workspaceId: context.workspaceId,
      tabId: tab.id,
    });
    this.#configureRemoteContentSecurity(context.workspaceId, tab);
    this.#registerNavigationEvents(context.workspaceId, tab);
  }

  #configureRemoteContentSecurity(workspaceId: string, tab: RuntimeTab): void {
    const contents = tab.view?.webContents;
    if (!contents) return;
    contents.setWindowOpenHandler(({ url }) => {
      if (this.#isCurrentTabContents(tab, contents) && isAllowedBrowserUrl(url)) {
        queueMicrotask(() => {
          if (
            this.#activeWorkspaceId === workspaceId &&
            !this.#destroyed &&
            this.#isCurrentTabContents(tab, contents)
          ) {
            void this.createTab({ workspaceId, url }).catch(() => undefined);
          }
        });
      }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!this.#isCurrentTabContents(tab, contents) || !isAllowedBrowserUrl(url)) {
        event.preventDefault();
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!this.#isCurrentTabContents(tab, contents) || !isAllowedBrowserUrl(url)) {
        event.preventDefault();
      }
    });
    contents.on('before-input-event', (event, input) => {
      if (!this.#isCurrentTabContents(tab, contents)) return;
      const shortcutInput = {
        type: input.type,
        key: input.key,
        control: input.control,
        meta: input.meta,
        alt: input.alt,
        shift: input.shift,
        repeat: input.isAutoRepeat,
        composing: input.isComposing,
      };
      if (isQuickCaptureShortcut(shortcutInput)) {
        event.preventDefault();
        this.callbacks.onQuickCapture?.();
        return;
      }
      const action = getBrowserShortcutAction(shortcutInput);
      if (!action || this.#activeWorkspaceId !== workspaceId) return;
      if (action === 'stop' && !tab.isLoading) return;
      event.preventDefault();
      if (action === 'focus-address') {
        this.callbacks.onFocusAddress?.();
      } else if (action === 'create-tab') {
        void this.createTab({ workspaceId })
          .then(() => this.callbacks.onFocusAddress?.())
          .catch(() => undefined);
      } else if (action === 'close-tab') {
        void this.closeTab({ workspaceId, tabId: tab.id }).catch(() => undefined);
      } else if (action === 'reload') {
        void this.reload({ workspaceId, tabId: tab.id }).catch(() => undefined);
      } else if (action === 'toggle-bookmark') {
        void this.toggleBookmark({ workspaceId, tabId: tab.id }).catch(() => undefined);
      } else if (action === 'next-tab' || action === 'previous-tab') {
        const context = this.#workspaces.get(workspaceId);
        const tabIds = context ? [...context.tabs.keys()] : [];
        const index = tabIds.indexOf(tab.id);
        if (index >= 0 && tabIds.length > 1) {
          const offset = action === 'next-tab' ? 1 : -1;
          const targetIndex = (index + offset + tabIds.length) % tabIds.length;
          const targetId = tabIds[targetIndex];
          if (targetId) {
            void this.activateTab({ workspaceId, tabId: targetId }).catch(() => undefined);
          }
        }
      } else if (action === 'back') {
        void this.back({ workspaceId, tabId: tab.id }).catch(() => undefined);
      } else if (action === 'forward') {
        void this.forward({ workspaceId, tabId: tab.id }).catch(() => undefined);
      } else {
        void this.stop({ workspaceId, tabId: tab.id }).catch(() => undefined);
      }
    });
  }

  #registerNavigationEvents(workspaceId: string, tab: RuntimeTab): void {
    const contents = tab.view?.webContents;
    if (!contents) return;
    contents.on('did-start-loading', () => {
      if (!this.#canCollectTabState(tab, contents)) return;
      tab.isLoading = true;
      this.#syncTabForCurrentWorkspace(workspaceId, tab);
    });
    contents.on('did-stop-loading', () => {
      if (!this.#canCollectTabState(tab, contents)) return;
      if (tab.pendingNavigationToken !== null) return;
      tab.isLoading = false;
      this.#syncTabForCurrentWorkspace(workspaceId, tab);
    });
    contents.on('did-navigate', (_event, url) => {
      if (!this.#canCollectTabState(tab, contents)) return;
      if (tab.pendingNavigationToken !== null || !this.#isCurrentContentsUrl(contents, url)) return;
      tab.url = url;
      this.#syncTabForCurrentWorkspace(workspaceId, tab, url);
      this.#persistLiveMetadata(workspaceId, tab);
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (
        !this.#canCollectTabState(tab, contents) ||
        !isMainFrame ||
        tab.pendingNavigationToken !== null ||
        !this.#isCurrentContentsUrl(contents, url)
      )
        return;
      tab.url = url;
      this.#syncTabForCurrentWorkspace(workspaceId, tab, url);
      this.#persistLiveMetadata(workspaceId, tab);
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!this.#canCollectTabState(tab, contents)) return;
      if (tab.pendingNavigationToken !== null) return;
      tab.title = sanitizeBrowserTitle(title);
      this.#syncTabForCurrentWorkspace(workspaceId, tab);
      this.#persistLiveMetadata(workspaceId, tab);
    });
    contents.on(
      'did-fail-load',
      (_event, _errorCode, _errorDescription, validatedUrl, isMainFrame) => {
        if (
          !this.#canCollectTabState(tab, contents) ||
          !isMainFrame ||
          tab.pendingNavigationToken !== null ||
          !this.#isCurrentContentsUrl(contents, validatedUrl)
        )
          return;
        tab.isLoading = false;
        this.#syncTabForCurrentWorkspace(workspaceId, tab, tab.url, false);
      },
    );
  }

  #persistLiveMetadata(workspaceId: string, tab: RuntimeTab): void {
    if (
      this.#destroyed ||
      this.#shuttingDown ||
      tab.closing ||
      tab.suppressLiveMetadata > 0 ||
      !isAllowedBrowserUrl(tab.url) ||
      (tab.url === tab.persistedUrl &&
        tab.title === tab.persistedTitle &&
        tab.metadataWorker === null)
    ) {
      return;
    }
    const url = normalizeBrowserUrl(tab.url);
    const title = sanitizeBrowserTitle(tab.title);
    tab.desiredMetadata = {
      url,
      title,
      generation: this.#workspaceGeneration,
    };
    void this.#ensureMetadataWorker(workspaceId, tab).catch(() => undefined);
  }

  #ensureMetadataWorker(workspaceId: string, tab: RuntimeTab): Promise<void> {
    if (tab.metadataWorker) return tab.metadataWorker;
    const worker = tab.persistenceTail.then(() => this.#drainDesiredMetadata(workspaceId, tab));
    tab.metadataWorker = worker;
    tab.persistenceTail = worker.then(
      () => {
        tab.persistenceError = null;
      },
      (error: unknown) => {
        tab.persistenceError = error;
      },
    );
    void worker.then(
      () => {
        if (tab.metadataWorker !== worker) return;
        tab.metadataWorker = null;
        if (tab.desiredMetadata && !this.#destroyed && !this.#shuttingDown) {
          void this.#ensureMetadataWorker(workspaceId, tab).catch(() => undefined);
        }
      },
      () => {
        if (tab.metadataWorker === worker) tab.metadataWorker = null;
      },
    );
    return worker;
  }

  async #drainDesiredMetadata(workspaceId: string, tab: RuntimeTab): Promise<void> {
    while (tab.desiredMetadata) {
      const desired = tab.desiredMetadata;
      if (desired.url === tab.persistedUrl && desired.title === tab.persistedTitle) {
        if (tab.desiredMetadata === desired) tab.desiredMetadata = null;
        continue;
      }
      const data = await this.persistence.persistBrowserTabMetadata({
        workspaceId,
        tabId: tab.id,
        url: desired.url,
        title: desired.title,
      });
      tab.persistedUrl = desired.url;
      tab.persistedTitle = desired.title;
      tab.persistenceError = null;
      if (tab.desiredMetadata === desired) tab.desiredMetadata = null;
      if (this.#isCurrentGeneration(workspaceId, desired.generation)) {
        this.#applyPersistenceResult(data, desired.generation);
      }
    }
  }

  #queueTabMetadata(
    workspaceId: string,
    tab: RuntimeTab,
    generation: number,
    url: string,
    title: string,
  ): Promise<void> {
    const operation = tab.persistenceTail.then(async () => {
      const data = await this.persistence.persistBrowserTabMetadata({
        workspaceId,
        tabId: tab.id,
        url,
        title,
      });
      tab.persistedUrl = url;
      tab.persistedTitle = title;
      tab.persistenceError = null;
      if (this.#isCurrentGeneration(workspaceId, generation)) {
        this.#applyPersistenceResult(data, generation);
      }
    });
    tab.persistenceTail = operation.then(
      () => undefined,
      (error: unknown) => {
        tab.persistenceError = error;
      },
    );
    return operation;
  }

  async #flushTabMetadata(workspaceId: string, tab: RuntimeTab, generation: number): Promise<void> {
    while (true) {
      const observedTail = tab.persistenceTail;
      await observedTail;
      this.#assertWorkspaceGeneration(workspaceId, generation, false);
      if (tab.closing || !isAllowedBrowserUrl(tab.url)) {
        return;
      }
      const url = normalizeBrowserUrl(tab.url);
      const title = sanitizeBrowserTitle(tab.title);
      if (url === tab.persistedUrl && title === tab.persistedTitle) {
        if (observedTail === tab.persistenceTail) {
          tab.desiredMetadata = null;
          tab.persistenceError = null;
          return;
        }
        continue;
      }
      tab.desiredMetadata = { url, title, generation };
      await this.#ensureMetadataWorker(workspaceId, tab);
    }
  }

  async #flushFrozenTabMetadata(
    workspaceId: string,
    tab: RuntimeTab,
    generation: number,
    metadata: TabMetadataSnapshot | null,
    allowTransition = false,
  ): Promise<void> {
    await tab.persistenceTail;
    this.#assertWorkspaceGeneration(workspaceId, generation, allowTransition);
    tab.desiredMetadata = null;
    tab.persistenceError = null;
    if (!metadata || (metadata.url === tab.persistedUrl && metadata.title === tab.persistedTitle)) {
      return;
    }
    await this.#queueTabMetadata(workspaceId, tab, generation, metadata.url, metadata.title);
  }

  async #flushWorkspaceMetadata(
    context: WorkspaceRuntime,
    generation: number,
    frozenMetadata: ReadonlyMap<RuntimeTab, TabMetadataSnapshot | null>,
  ): Promise<void> {
    for (const tab of context.tabs.values()) {
      await this.#flushFrozenTabMetadata(
        context.workspaceId,
        tab,
        generation,
        frozenMetadata.get(tab) ?? null,
        true,
      );
    }
  }

  #tabMetadataSnapshot(tab: RuntimeTab): TabMetadataSnapshot | null {
    if (!isAllowedBrowserUrl(tab.url)) return null;
    return {
      url: normalizeBrowserUrl(tab.url),
      title: sanitizeBrowserTitle(tab.title),
    };
  }

  #captureTabMetadata(tab: RuntimeTab): void {
    if (!tab.view || tab.view.webContents.isDestroyed()) return;
    try {
      const contents = tab.view.webContents;
      const currentUrl = contents.getURL();
      const currentTitle = contents.getTitle();
      tab.url = (tab.pendingNavigationUrl ?? currentUrl) || tab.url;
      tab.title = sanitizeBrowserTitle(currentTitle || tab.title);
    } catch {
      // Retain the last captured metadata if the native WebContents disappears.
    }
  }

  #syncTabForCurrentWorkspace(
    workspaceId: string,
    tab: RuntimeTab,
    observedUrl?: string,
    observedLoading?: boolean,
  ): void {
    const context = this.#workspaces.get(workspaceId);
    if (context) this.#syncTab(context, tab, observedUrl, observedLoading);
  }

  #syncTab(
    context: WorkspaceRuntime,
    tab: RuntimeTab,
    observedUrl?: string,
    observedLoading?: boolean,
  ): void {
    if (this.#destroyed || !tab.view || tab.view.webContents.isDestroyed()) return;
    const contents = tab.view.webContents;
    const history = contents.navigationHistory;
    const currentUrl = observedUrl ?? tab.pendingNavigationUrl ?? contents.getURL();
    const currentTitle = contents.getTitle();
    tab.url = currentUrl || tab.url;
    tab.title = sanitizeBrowserTitle(currentTitle || tab.title);
    tab.canGoBack = history.canGoBack();
    tab.canGoForward = history.canGoForward();
    tab.isLoading = observedLoading ?? contents.isLoading();
    this.#bumpRevision(context);
    this.#emitSnapshot(context);
  }

  #showActiveTab(context: WorkspaceRuntime): void {
    for (const tab of context.tabs.values()) {
      const shouldShow =
        this.#visible &&
        !this.#shuttingDown &&
        this.#activeWorkspaceId === context.workspaceId &&
        tab.id === context.activeTabId;
      if (shouldShow) this.#materializeTab(context, tab);
      tab.view?.setVisible(shouldShow);
      if (shouldShow) {
        tab.view?.setBounds(this.#boundedRectangle());
        this.#ensureTabLoaded(context, tab);
      }
    }
  }

  #ensureTabLoaded(context: WorkspaceRuntime, tab: RuntimeTab): void {
    if (this.#destroyed || this.#shuttingDown) return;
    this.#materializeTab(context, tab);
    if (tab.hasLoaded) return;
    tab.hasLoaded = true;
    tab.isLoading = true;
    this.#bumpRevision(context);
    this.#emitSnapshot(context);
    void tab.view?.webContents.loadURL(tab.url).catch((error: unknown) => {
      if (!this.#destroyed && !this.#isNavigationCancellation(error)) {
        tab.isLoading = false;
        this.#syncTab(context, tab);
      }
    });
  }

  #hideAllTabs(): void {
    for (const context of this.#workspaces.values()) {
      for (const tab of context.tabs.values()) {
        try {
          tab.view?.setVisible(false);
        } catch {
          // A closing native view can disappear while shutdown is hiding tabs.
        }
      }
    }
  }

  #applyBounds(): void {
    if (this.#destroyed || this.parentWindow.isDestroyed()) return;
    const context =
      this.#activeWorkspaceId === null ? undefined : this.#workspaces.get(this.#activeWorkspaceId);
    const tab = context?.tabs.get(context.activeTabId);
    if (tab?.view && !tab.view.webContents.isDestroyed()) {
      tab.view.setBounds(this.#boundedRectangle());
    }
  }

  #boundedRectangle(): Rectangle {
    const [contentWidth, contentHeight] = this.parentWindow.getContentSize();
    const x = Math.min(this.#requestedBounds.x, contentWidth);
    const y = Math.min(this.#requestedBounds.y, contentHeight);
    return {
      x,
      y,
      width: Math.max(0, Math.min(this.#requestedBounds.width, contentWidth - x)),
      height: Math.max(0, Math.min(this.#requestedBounds.height, contentHeight - y)),
    };
  }

  #snapshot(context: WorkspaceRuntime): BrowserSnapshot {
    return {
      workspaceId: context.workspaceId,
      revision: context.revision,
      activeTabId: context.activeTabId,
      tabs: [...context.tabs.values()].map(toBrowserTab),
      bookmarks: context.bookmarks.map((bookmark) => ({ ...bookmark })),
      downloads: this.#downloads.getDownloads(context.workspaceId),
    };
  }

  #emitSnapshot(context: WorkspaceRuntime): void {
    if (
      this.#activeWorkspaceId === context.workspaceId &&
      !this.#destroyed &&
      !this.#shuttingDown
    ) {
      this.callbacks.onStateChange(this.#snapshot(context));
    }
  }

  #bumpRevision(context: WorkspaceRuntime, persistedRevision = 0): void {
    context.revision = Math.max(context.revision + 1, persistedRevision);
    this.#revisionByWorkspace.set(context.workspaceId, context.revision);
  }

  #requireActiveTab(input: BrowserTabTargetInput): {
    context: WorkspaceRuntime;
    tab: RuntimeTab;
  } {
    this.#requireActiveGeneration(input.workspaceId);
    const context = this.#requireWorkspace(input.workspaceId);
    if (context.activeTabId !== input.tabId) {
      throw new BrowserConflictError('The target browser tab is no longer active.');
    }
    const tab = this.#requireTab(context, input.tabId);
    this.#ensureTabLoaded(context, tab);
    return { context, tab };
  }

  #requireTab(context: WorkspaceRuntime, tabId: string): RuntimeTab {
    const tab = context.tabs.get(tabId);
    if (!tab) {
      throw new BrowserNotFoundError('The browser tab is unavailable.');
    }
    if (tab.closing) {
      throw new BrowserConflictError('The browser tab is closing.');
    }
    return tab;
  }

  #assertTabOperationCurrent(
    context: WorkspaceRuntime,
    tab: RuntimeTab,
    allowClosing = false,
  ): void {
    if (context.tabs.get(tab.id) !== tab || (!allowClosing && tab.closing)) {
      throw new BrowserConflictError('The browser tab changed before the operation finished.');
    }
  }

  #requireTabContents(tab: RuntimeTab): WebContents {
    const contents = tab.view?.webContents;
    if (!contents || contents.isDestroyed()) {
      throw new BrowserNotFoundError('The browser tab is unavailable.');
    }
    return contents;
  }

  #requireWorkspace(workspaceId: string): WorkspaceRuntime {
    const context = this.#workspaces.get(workspaceId);
    if (!context) throw new BrowserConflictError('The browser workspace is not loaded.');
    return context;
  }

  #requireActiveGeneration(workspaceId: string): number {
    this.#ensureActive();
    if (this.#activeWorkspaceId !== workspaceId || this.#transitioningWorkspaceId === workspaceId) {
      throw new BrowserConflictError('The browser workspace is no longer active.');
    }
    return this.#workspaceGeneration;
  }

  #assertCurrentGeneration(workspaceId: string, generation: number): void {
    this.#assertWorkspaceGeneration(workspaceId, generation, false);
  }

  #assertWorkspaceGeneration(
    workspaceId: string,
    generation: number,
    allowTransition: boolean,
  ): void {
    if (!this.#isWorkspaceGenerationCurrent(workspaceId, generation, allowTransition)) {
      throw new BrowserConflictError(
        'The browser workspace changed before the operation finished.',
      );
    }
  }

  #isCurrentGeneration(workspaceId: string, generation: number): boolean {
    return this.#isWorkspaceGenerationCurrent(workspaceId, generation, false);
  }

  #isWorkspaceGenerationCurrent(
    workspaceId: string,
    generation: number,
    allowTransition: boolean,
  ): boolean {
    return (
      !this.#destroyed &&
      this.#activeWorkspaceId === workspaceId &&
      this.#workspaceGeneration === generation &&
      (allowTransition || this.#transitioningWorkspaceId !== workspaceId)
    );
  }

  #ensureActive(): void {
    if (this.#destroyed || this.parentWindow.isDestroyed()) {
      throw new BrowserConflictError('The browser controller is no longer available.');
    }
  }

  #destroyTab(tab: RuntimeTab, expectedView: WebContentsView | null = tab.view): void {
    if (tab.view !== expectedView) return;
    const view = expectedView;
    tab.view = null;
    tab.hasLoaded = false;
    tab.isLoading = false;
    tab.canGoBack = false;
    tab.canGoForward = false;
    tab.pendingNavigationUrl = null;
    tab.pendingNavigationToken = null;
    tab.navigationSequence += 1;
    if (!view) return;
    this.#contentsSources.delete(view.webContents);
    if (!this.parentWindow.isDestroyed()) {
      try {
        this.parentWindow.contentView.removeChildView(view);
      } catch {
        // Electron may already be tearing down the parent view.
      }
    }
    if (!view.webContents.isDestroyed()) {
      try {
        view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        // The native WebContents can disappear between the state check and close.
      }
    }
  }

  #isNavigationCancellation(error: unknown): boolean {
    return error instanceof Error && error.message.includes('ERR_ABORTED');
  }

  #isCurrentContentsUrl(contents: WebContents, url: string): boolean {
    const currentUrl = contents.getURL();
    return (
      isAllowedBrowserUrl(url) &&
      isAllowedBrowserUrl(currentUrl) &&
      normalizeBrowserUrl(url) === normalizeBrowserUrl(currentUrl)
    );
  }

  #isCurrentTabContents(tab: RuntimeTab, contents: WebContents): boolean {
    return !tab.closing && tab.view?.webContents === contents && !contents.isDestroyed();
  }

  #canCollectTabState(tab: RuntimeTab, contents: WebContents): boolean {
    return tab.suppressLiveMetadata === 0 && this.#isCurrentTabContents(tab, contents);
  }
}

function toBrowserTab(tab: RuntimeTab): BrowserTab {
  return {
    id: tab.id,
    url: tab.url || BROWSER_DEFAULT_URL,
    title: tab.title || BROWSER_DEFAULT_TITLE,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    isLoading: tab.isLoading,
  };
}
