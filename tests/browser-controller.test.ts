import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPersistence } from '../src/main/browser/browser-controller';
import { BrowserController } from '../src/main/browser/browser-controller';
import { BrowserNotFoundError } from '../src/main/browser/browser-errors';
import type { BrowserData } from '../src/main/browser/browser-repository';
import type { BrowserSnapshot } from '../src/shared/contracts';
import { BROWSER_DEFAULT_TITLE, BROWSER_DEFAULT_URL } from '../src/shared/browser-domain';

const electron = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeEmitter {
    readonly listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener) {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: Listener) {
      const wrapped: Listener = (...args) => {
        this.removeListener(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: Listener) {
      return this.removeListener(event, listener);
    }

    removeListener(event: string, listener: Listener) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }
  }

  class FakeSession extends FakeEmitter {
    permissionCheckHandler: unknown;
    permissionRequestHandler: unknown;

    setPermissionCheckHandler(handler: unknown) {
      this.permissionCheckHandler = handler;
    }

    setPermissionRequestHandler(handler: unknown) {
      this.permissionRequestHandler = handler;
    }
  }

  class FakeWebContents extends FakeEmitter {
    url = '';
    title = '';
    loading = false;
    destroyed = false;
    windowOpenHandler: ((details: { url: string }) => unknown) | undefined;
    readonly loadCalls: string[] = [];
    readonly navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };

    setWindowOpenHandler(handler: (details: { url: string }) => unknown) {
      this.windowOpenHandler = handler;
    }

    getURL() {
      return this.url;
    }

    getTitle() {
      return this.title;
    }

    isLoading() {
      return this.loading;
    }

    isDestroyed() {
      return this.destroyed;
    }

    loadURL(url: string) {
      this.loading = true;
      this.loadCalls.push(url);
      this.url = url;
      this.loading = false;
      return Promise.resolve();
    }

    reload() {
      this.loading = true;
    }

    stop() {
      this.loading = false;
    }

    close() {
      this.destroyed = true;
    }
  }

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    visible = true;
    bounds: unknown;

    constructor() {
      state.views.push(this);
    }

    setVisible(visible: boolean) {
      this.visible = visible;
    }

    setBounds(bounds: unknown) {
      this.bounds = bounds;
    }
  }

  const state = {
    session: new FakeSession(),
    views: [] as FakeWebContentsView[],
    showItemInFolder: vi.fn(),
  };

  return { FakeEmitter, FakeSession, FakeWebContents, FakeWebContentsView, state };
});

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(async () => ({
    isFile: () => true,
    isSymbolicLink: () => false,
  })),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/downloads' },
  session: { fromPartition: () => electron.state.session },
  shell: { showItemInFolder: electron.state.showItemInFolder },
  WebContentsView: electron.FakeWebContentsView,
}));

vi.mock('node:fs/promises', () => ({
  lstat: filesystem.lstat,
}));

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TAB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TAB_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TIMESTAMP = '2026-07-22T12:00:00.000Z';

const activeControllers: BrowserController[] = [];

beforeEach(() => {
  electron.state.views.length = 0;
  electron.state.showItemInFolder.mockClear();
  filesystem.lstat.mockReset();
  filesystem.lstat.mockResolvedValue({
    isFile: () => true,
    isSymbolicLink: () => false,
  });
});

afterEach(() => {
  for (const controller of activeControllers.splice(0)) controller.destroy();
});

describe('BrowserController lifecycle', () => {
  it('never exposes different snapshots with the same revision during lazy create and close-last', async () => {
    const observed: BrowserSnapshot[] = [];
    const harness = createHarness({
      onStateChange: (snapshot) => observed.push(cloneSnapshot(snapshot)),
    });

    observed.push(await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }));
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    observed.push(await harness.controller.createTab({ workspaceId: WORKSPACE_A }));
    observed.push(
      await harness.controller.closeTab({
        workspaceId: WORKSPACE_A,
        tabId: TAB_C,
      }),
    );
    observed.push(
      await harness.controller.closeTab({
        workspaceId: WORKSPACE_A,
        tabId: TAB_A,
      }),
    );

    expect(observed.at(-1)?.tabs).toMatchObject([
      { id: TAB_A, url: BROWSER_DEFAULT_URL, isLoading: true },
    ]);
    expectSnapshotRevisionInvariant(observed);
  });

  it('focuses the trusted address bar after a remote Ctrl+T creates a tab', async () => {
    const onFocusAddress = vi.fn();
    const harness = createHarness({ onFocusAddress });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = electron.state.views[0]?.webContents;
    expect(contents).toBeDefined();
    const event = { preventDefault: vi.fn() };

    contents?.emit('before-input-event', event, {
      type: 'keyDown',
      key: 't',
      control: true,
      meta: false,
      alt: false,
      shift: false,
      isAutoRepeat: false,
      isComposing: false,
    });

    await vi.waitFor(() => expect(onFocusAddress).toHaveBeenCalledTimes(1));
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(harness.persistence.createBrowserTab).toHaveBeenCalledTimes(1);
  });

  it('gives one close ownership of a sole runtime tab and keeps one replacement view', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const originalView = electron.state.views[0];
    const firstCloseResult = deferred<BrowserData>();
    const resetTab = {
      ...browserData(WORKSPACE_A, TAB_A),
      revision: 2,
    };
    harness.persistence.closeBrowserTab.mockImplementationOnce(() => firstCloseResult.promise);

    const firstClose = harness.controller.closeTab({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
    });
    const secondClose = harness.controller.closeTab({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
    });
    await expect(secondClose).rejects.toThrow(/tab is closing/u);
    await vi.waitFor(() => expect(harness.persistence.closeBrowserTab).toHaveBeenCalledTimes(1));

    firstCloseResult.resolve(resetTab);
    await expect(firstClose).resolves.toMatchObject({
      activeTabId: TAB_A,
      tabs: [{ id: TAB_A }],
    });
    const replacementView = electron.state.views[1];
    expect(originalView?.webContents.destroyed).toBe(true);
    expect(replacementView).toBeDefined();
    expect(replacementView?.webContents.destroyed).toBe(false);

    expect(electron.state.views).toHaveLength(2);
    expect(replacementView?.webContents.destroyed).toBe(false);
    expect(replacementView?.visible).toBe(true);
  });

  it('rejects same-tab operations after a close owns the runtime tab', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const closeResult = deferred<BrowserData>();
    harness.persistence.closeBrowserTab.mockImplementationOnce(() => closeResult.promise);

    const close = harness.controller.closeTab({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
    });
    await vi.waitFor(() => expect(harness.persistence.closeBrowserTab).toHaveBeenCalledTimes(1));

    await expect(
      harness.controller.navigate({
        workspaceId: WORKSPACE_A,
        tabId: TAB_A,
        url: 'https://late.example/',
      }),
    ).rejects.toThrow(/tab is closing/u);
    await expect(
      harness.controller.toggleBookmark({
        workspaceId: WORKSPACE_A,
        tabId: TAB_A,
      }),
    ).rejects.toThrow(/tab is closing/u);
    expect(harness.persistence.toggleBrowserBookmark).not.toHaveBeenCalled();

    closeResult.resolve({ ...browserData(WORKSPACE_A, TAB_A), revision: 2 });
    await expect(close).resolves.toMatchObject({
      activeTabId: TAB_A,
      tabs: [{ id: TAB_A }],
    });
  });

  it('reconciles a navigation that settles while its owning close later fails', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    const navigation = deferNextLoad(contents);
    const closeResult = deferred<BrowserData>();
    harness.persistence.closeBrowserTab.mockImplementationOnce(() => closeResult.promise);
    const targetUrl = 'https://recovered.example/final';

    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: targetUrl,
    });
    const close = harness.controller.closeTab({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
    });
    await vi.waitFor(() => expect(harness.persistence.closeBrowserTab).toHaveBeenCalledTimes(1));

    contents.url = targetUrl;
    contents.loading = false;
    navigation.resolve();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    closeResult.reject(new Error('close failed'));
    await expect(close).rejects.toThrow('close failed');

    contents.title = 'Recovered title';
    contents.emit('page-title-updated', {}, contents.title);
    await vi.waitFor(() =>
      expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]).toMatchObject({
        url: targetUrl,
        title: 'Recovered title',
      }),
    );
    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      tabs: [
        expect.objectContaining({
          id: TAB_A,
          url: targetUrl,
          title: 'Recovered title',
          isLoading: false,
        }),
      ],
    });
  });

  it('rejects a navigation already awaiting persistence when close claims its tab', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    const targetUrl = 'https://late.example/persisting';
    const navigation = harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: targetUrl,
    });
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));

    const close = harness.controller.closeTab({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
    });
    harness.persistence.resolveMetadata(0);
    await expect(navigation).rejects.toThrow(/tab changed/u);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(2));
    harness.persistence.resolveMetadata(1);

    await expect(close).resolves.toMatchObject({
      activeTabId: TAB_A,
      tabs: [{ id: TAB_A, url: BROWSER_DEFAULT_URL }],
    });
    expect(contents.loadCalls).not.toContain(targetUrl);
    expect(harness.persistence.closeBrowserTab).toHaveBeenCalledTimes(1);
  });

  it('denies remote permissions, unsafe navigation, redirects, and all native popups', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    const permissionCheck = electron.state.session.permissionCheckHandler as (
      contents: unknown,
      permission: string,
    ) => boolean;
    const permissionRequest = electron.state.session.permissionRequestHandler as (
      contents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
    ) => void;
    const permissionCallback = vi.fn();

    expect(permissionCheck(contents, 'geolocation')).toBe(false);
    permissionRequest(contents, 'notifications', permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);

    for (const [eventName, url] of [
      ['will-navigate', 'file:///tmp/secret.txt'],
      ['will-redirect', 'javascript:alert(1)'],
    ] as const) {
      const event = { preventDefault: vi.fn() };
      contents.emit(eventName, event, url);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    }

    expect(contents.windowOpenHandler?.({ url: 'javascript:alert(1)' })).toEqual({
      action: 'deny',
    });
    expect(contents.windowOpenHandler?.({ url: 'https://safe.example/' })).toEqual({
      action: 'deny',
    });
    await vi.waitFor(() =>
      expect(harness.persistence.createBrowserTab).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE_A,
        url: 'https://safe.example/',
      }),
    );
  });

  it('serializes explicit navigation behind all previously queued live metadata', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);

    contents.url = 'https://old.example/one';
    contents.title = 'Old one';
    contents.emit('did-navigate', {}, contents.url);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));

    contents.title = 'Old two';
    contents.emit('page-title-updated', {}, contents.title);
    const navigation = harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: 'https://new.example/final',
    });

    expect(harness.persistence.pendingMetadata).toHaveLength(1);
    harness.persistence.resolveMetadata(0);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(2));
    harness.persistence.resolveMetadata(1);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(3));
    expect(harness.persistence.pendingMetadata[2]?.input).toMatchObject({
      url: 'https://new.example/final',
      title: 'Old two',
    });
    harness.persistence.resolveMetadata(2);
    await expect(navigation).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      activeTabId: TAB_A,
    });
    expect(
      harness.persistence.pendingMetadata.map(({ input }) => [input.url, input.title]),
    ).toEqual([
      ['https://old.example/one', 'Old one'],
      ['https://old.example/one', 'Old two'],
      ['https://new.example/final', 'Old two'],
    ]);
  });

  it('finishes bookmark persistence against one snapshot under continuous title events', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    contents.title = 'Before bookmark';
    contents.emit('page-title-updated', {}, contents.title);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));

    const toggled = harness.controller.toggleBookmark({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
    });
    for (let index = 0; index < 100; index += 1) {
      contents.title = `During bookmark ${index}`;
      contents.emit('page-title-updated', {}, contents.title);
    }
    harness.persistence.resolveMetadata(0);

    await expect(toggled).resolves.toMatchObject({
      workspaceId: WORKSPACE_A,
      activeTabId: TAB_A,
    });
    expect(harness.persistence.toggleBrowserBookmark).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(2));
    expect(harness.persistence.pendingMetadata[1]?.input.title).toBe('During bookmark 99');
    harness.persistence.resolveMetadata(1);
  });

  it('preserves an accepted uncommitted navigation while switching workspaces', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    contents.url = BROWSER_DEFAULT_URL;
    const targetUrl = 'https://accepted.example/switch';
    const navigation = deferNextLoad(contents);

    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: targetUrl,
    });
    expect(contents.getURL()).toBe(BROWSER_DEFAULT_URL);
    expect(contents.loadCalls.at(-1)).toBe(targetUrl);

    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_B }),
    ).resolves.toMatchObject({ workspaceId: WORKSPACE_B });
    expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]?.url).toBe(targetUrl);
    navigation.resolve();
  });

  it('preserves an accepted uncommitted navigation during shutdown', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    contents.url = BROWSER_DEFAULT_URL;
    const targetUrl = 'https://accepted.example/shutdown';
    const navigation = deferNextLoad(contents);

    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: targetUrl,
    });
    expect(contents.getURL()).toBe(BROWSER_DEFAULT_URL);

    await expect(harness.controller.shutdown()).resolves.toBeUndefined();
    expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]?.url).toBe(targetUrl);
    navigation.resolve();
  });

  it('commits successful navigation events and clears failed pending navigation state', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    contents.url = BROWSER_DEFAULT_URL;
    const requestedUrl = 'https://requested.example/';
    const committedUrl = 'https://requested.example/final';
    const requestedNavigation = deferNextLoad(contents);

    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: requestedUrl,
    });
    contents.url = `${BROWSER_DEFAULT_URL}#stale`;
    contents.emit('did-navigate-in-page', {}, contents.url, true);
    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ id: TAB_A, url: requestedUrl })],
    });
    contents.url = committedUrl;
    contents.loading = false;
    contents.emit('did-navigate', {}, committedUrl);
    requestedNavigation.resolve();
    await vi.waitFor(() =>
      expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]?.url).toBe(committedUrl),
    );

    const failedUrl = 'https://failed.example/';
    const failedNavigation = deferNextLoad(contents);
    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: failedUrl,
    });
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', failedUrl, true);
    failedNavigation.reject(new Error('ERR_NAME_NOT_RESOLVED'));
    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ id: TAB_A, url: failedUrl, isLoading: false })],
    });

    contents.url = committedUrl;
    contents.emit('did-navigate', {}, committedUrl);
    await vi.waitFor(() =>
      expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]?.url).toBe(committedUrl),
    );
  });

  it('ignores in-page navigation and load failures from subframes', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    contents.url = BROWSER_DEFAULT_URL;
    const requestedUrl = 'https://requested.example/main';
    const navigation = deferNextLoad(contents);

    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: requestedUrl,
    });
    contents.emit('did-navigate-in-page', {}, requestedUrl, false);
    contents.emit('did-navigate-in-page', {}, `${BROWSER_DEFAULT_URL}#iframe`, false);
    contents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://iframe.example/',
      false,
    );

    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ id: TAB_A, url: requestedUrl, isLoading: true })],
    });

    contents.emit('did-navigate-in-page', {}, `${BROWSER_DEFAULT_URL}#stale`, true);
    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ id: TAB_A, url: requestedUrl, isLoading: true })],
    });

    contents.url = requestedUrl;
    contents.loading = false;
    navigation.resolve();
  });

  it('lets only the latest same-URL load promise settle an explicit navigation', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    const firstNavigation = deferNextLoad(contents);
    const secondNavigation = deferNextLoad(contents);
    const targetUrl = 'https://same.example/path';

    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: targetUrl,
    });
    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: targetUrl,
    });

    contents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://stale.example/',
      true,
    );
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', targetUrl, true);
    firstNavigation.reject(new Error('first navigation failed'));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ id: TAB_A, url: targetUrl, isLoading: true })],
    });

    contents.url = targetUrl;
    contents.loading = false;
    secondNavigation.resolve();
    await vi.waitFor(async () => {
      await expect(
        harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
      ).resolves.toMatchObject({
        tabs: [expect.objectContaining({ id: TAB_A, url: targetUrl, isLoading: false })],
      });
    });
  });

  it('settles an owning aborted navigation after did-stop-loading was ignored', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    const navigation = deferNextLoad(contents);

    await harness.controller.navigate({
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      url: 'https://cancelled.example/',
    });
    contents.url = BROWSER_DEFAULT_URL;
    contents.loading = false;
    contents.emit('did-stop-loading');
    navigation.reject(new Error('ERR_ABORTED'));

    await vi.waitFor(async () => {
      await expect(
        harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
      ).resolves.toMatchObject({
        tabs: [
          expect.objectContaining({
            id: TAB_A,
            url: BROWSER_DEFAULT_URL,
            isLoading: false,
          }),
        ],
      });
    });
  });

  it('coalesces a 100-event live metadata burst to the in-flight write and latest value', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);

    contents.url = 'https://burst.example/0';
    contents.title = 'Burst 0';
    contents.emit('did-navigate', {}, contents.url);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));

    for (let index = 1; index < 100; index += 1) {
      contents.url = `https://burst.example/${index}`;
      contents.title = `Burst ${index}`;
      contents.emit('did-navigate-in-page', {}, contents.url, true);
      contents.emit('page-title-updated', {}, contents.title);
    }

    expect(harness.persistence.pendingMetadata).toHaveLength(1);
    harness.persistence.resolveMetadata(0);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(2));
    expect(harness.persistence.pendingMetadata[1]?.input).toMatchObject({
      url: 'https://burst.example/99',
      title: 'Burst 99',
    });
    harness.persistence.resolveMetadata(1);
    await vi.waitFor(() =>
      expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]).toMatchObject({
        url: 'https://burst.example/99',
        title: 'Burst 99',
      }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(harness.persistence.pendingMetadata).toHaveLength(2);
  });

  it('destroys the old view and flushes its latest metadata before loading another workspace', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    contents.url = 'https://latest.example/path';
    contents.title = 'Latest title';
    contents.emit('did-navigate', {}, contents.url);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));
    contents.emit('page-title-updated', {}, contents.title);

    const switched = harness.controller.getSnapshot({ workspaceId: WORKSPACE_B });
    await vi.waitFor(() => expect(contents.destroyed).toBe(true));
    expect(harness.persistence.pendingMetadata[0]?.input).toMatchObject({
      workspaceId: WORKSPACE_A,
      url: 'https://latest.example/path',
      title: 'Latest title',
    });
    harness.persistence.resolveMetadata(0);

    await expect(switched).resolves.toMatchObject({ workspaceId: WORKSPACE_B });
    expect(harness.persistence.getBrowserData).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_B,
    });
    expect(harness.persistence.pendingMetadata).toHaveLength(1);
  });

  it('disposes a destroyed native child and reloads its saved URL in one replacement view', async () => {
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const oldView = electron.state.views[0];
    const oldContents = requireContents(0);
    const savedUrl = 'https://saved.example/recover';
    oldContents.url = savedUrl;
    oldContents.loading = false;
    oldContents.emit('did-navigate', {}, savedUrl);
    await vi.waitFor(() =>
      expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]?.url).toBe(savedUrl),
    );

    oldContents.destroyed = true;
    await harness.controller.stop({ workspaceId: WORKSPACE_A, tabId: TAB_A });

    const replacementView = electron.state.views[1];
    expect(replacementView).toBeDefined();
    expect(harness.childViews).toEqual(new Set([replacementView]));
    expect(replacementView?.webContents.loadCalls).toEqual([savedUrl]);
    expect(replacementView?.webContents.destroyed).toBe(false);
    expect(oldView?.webContents.destroyed).toBe(true);

    oldContents.url = 'https://stale.example/';
    oldContents.emit('did-navigate', {}, oldContents.url);
    oldContents.emit(
      'before-input-event',
      { preventDefault: vi.fn() },
      {
        type: 'keyDown',
        key: 'w',
        control: true,
        meta: false,
        alt: false,
        shift: false,
        isAutoRepeat: false,
        isComposing: false,
      },
    );
    await expect(
      harness.controller.getSnapshot({ workspaceId: WORKSPACE_A }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ id: TAB_A, url: savedUrl })],
    });
    expect(harness.persistence.closeBrowserTab).not.toHaveBeenCalled();

    const staleDownloadEvent = { preventDefault: vi.fn() };
    electron.state.session.emit(
      'will-download',
      staleDownloadEvent,
      new FakeDownloadItem(),
      oldContents,
    );
    expect(staleDownloadEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('keeps the old remote view destroyed after a final metadata flush failure and allows retry', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const oldView = electron.state.views[0];
    expect(oldView).toBeDefined();
    const contents = requireContents(0);
    contents.url = 'https://unsaved.example/';
    contents.title = 'Unsaved';
    contents.emit('did-navigate', {}, contents.url);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));

    const switched = harness.controller.getSnapshot({ workspaceId: WORKSPACE_B });
    harness.persistence.rejectMetadata(0, new Error('first write failed'));
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(2));
    const finalFailure = new Error('final flush failed');
    harness.persistence.rejectMetadata(1, finalFailure);

    await expect(switched).rejects.toBe(finalFailure);
    expect(oldView?.visible).toBe(false);
    expect(contents.destroyed).toBe(true);
    expect(electron.state.views).toHaveLength(1);
    expect(harness.persistence.getBrowserData).not.toHaveBeenCalledWith({
      workspaceId: WORKSPACE_B,
    });

    const retried = harness.controller.getSnapshot({ workspaceId: WORKSPACE_B });
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(3));
    harness.persistence.resolveMetadata(2);
    await expect(retried).resolves.toMatchObject({ workspaceId: WORKSPACE_B });
    expect(oldView?.visible).toBe(false);
    expect(contents.destroyed).toBe(true);
  });

  it('discards a dirty missing old tab and continues switching workspaces', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const oldView = electron.state.views[0];
    expect(oldView).toBeDefined();
    const contents = requireContents(0);
    contents.url = 'https://removed.example/';
    contents.title = 'Removed';
    contents.emit('did-navigate', {}, contents.url);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));

    const switched = harness.controller.getSnapshot({ workspaceId: WORKSPACE_B });
    harness.persistence.rejectMetadata(0, new Error('initial write failed'));
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(2));
    harness.persistence.rejectMetadata(
      1,
      new BrowserNotFoundError('The old browser tab is unavailable.'),
    );

    await expect(switched).resolves.toMatchObject({ workspaceId: WORKSPACE_B });
    expect(harness.persistence.getBrowserData).toHaveBeenLastCalledWith({
      workspaceId: WORKSPACE_B,
    });
    expect(oldView?.visible).toBe(false);
    expect(contents.destroyed).toBe(true);
  });

  it('checks workspace generation before and after revealing a completed download', async () => {
    const revealStat = deferred<{
      isFile(): true;
      isSymbolicLink(): false;
    }>();
    filesystem.lstat.mockReturnValueOnce(revealStat.promise);
    const harness = createHarness();
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    const item = new FakeDownloadItem();
    electron.state.session.emit('will-download', { preventDefault: vi.fn() }, item, contents);
    item.emit('done', {}, 'completed');
    const snapshot = await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    const downloadId = snapshot.downloads[0]?.id;
    expect(downloadId).toBeDefined();

    const reveal = harness.controller.revealDownload({
      workspaceId: WORKSPACE_A,
      downloadId: downloadId!,
    });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_B });
    revealStat.resolve({
      isFile: () => true,
      isSymbolicLink: () => false,
    });

    await expect(reveal).rejects.toThrow(/workspace changed/u);
    expect(electron.state.showItemInFolder).not.toHaveBeenCalled();
  });

  it('destroys remote views before a bounded idempotent shutdown metadata flush', async () => {
    const harness = createHarness({ controlledMetadata: true });
    await harness.controller.getSnapshot({ workspaceId: WORKSPACE_A });
    await harness.controller.setVisible({ workspaceId: WORKSPACE_A, visible: true });
    const contents = requireContents(0);
    const view = electron.state.views[0];
    contents.url = 'https://shutdown.example/first';
    contents.title = 'First';
    contents.emit('did-navigate', {}, contents.url);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(1));
    contents.url = 'https://shutdown.example/final';
    contents.title = 'Final';
    contents.emit('page-title-updated', {}, contents.title);

    const firstShutdown = harness.controller.shutdown();
    const secondShutdown = harness.controller.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    expect(view?.visible).toBe(false);
    await expect(harness.controller.getSnapshot({ workspaceId: WORKSPACE_A })).rejects.toThrow(
      /no longer available/u,
    );
    await vi.waitFor(() => expect(contents.destroyed).toBe(true));
    for (let index = 0; index < 100; index += 1) {
      contents.url = `https://shutdown.example/stale-${index}`;
      contents.title = `Stale ${index}`;
      contents.emit('did-navigate', {}, contents.url);
      contents.emit('page-title-updated', {}, contents.title);
    }

    harness.persistence.resolveMetadata(0);
    await vi.waitFor(() => expect(harness.persistence.pendingMetadata).toHaveLength(2));
    expect(harness.persistence.pendingMetadata[1]?.input).toMatchObject({
      url: 'https://shutdown.example/final',
      title: 'Final',
    });
    harness.persistence.resolveMetadata(1);

    await expect(firstShutdown).resolves.toBeUndefined();
    expect(contents.destroyed).toBe(true);
    expect(harness.persistence.pendingMetadata).toHaveLength(2);
    expect(harness.persistence.data.get(WORKSPACE_A)?.tabs[0]).toMatchObject({
      url: 'https://shutdown.example/final',
      title: 'Final',
    });
  });
});

class FakePersistence implements BrowserPersistence {
  readonly data = new Map<string, BrowserData>([
    [WORKSPACE_A, browserData(WORKSPACE_A, TAB_A)],
    [WORKSPACE_B, browserData(WORKSPACE_B, TAB_B)],
  ]);
  readonly pendingMetadata: Array<{
    readonly input: {
      readonly workspaceId: string;
      readonly tabId: string;
      readonly url: string;
      readonly title: string;
    };
    readonly deferred: ReturnType<typeof deferred<BrowserData>>;
  }> = [];
  readonly getBrowserData = vi.fn(async ({ workspaceId }: { workspaceId: string }) =>
    this.read(workspaceId),
  );
  readonly createBrowserTab = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    const current = this.read(workspaceId);
    this.data.set(workspaceId, {
      ...current,
      revision: current.revision + 1,
      activeTabId: TAB_C,
      tabs: [
        ...current.tabs,
        {
          id: TAB_C,
          url: BROWSER_DEFAULT_URL,
          title: BROWSER_DEFAULT_TITLE,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ],
    });
    return this.read(workspaceId);
  });
  readonly activateBrowserTab = vi.fn(
    async ({ workspaceId, tabId }: { workspaceId: string; tabId: string }) => {
      const current = this.read(workspaceId);
      this.data.set(workspaceId, {
        ...current,
        revision: current.revision + 1,
        activeTabId: tabId,
      });
      return this.read(workspaceId);
    },
  );
  readonly closeBrowserTab = vi.fn(
    async ({ workspaceId, tabId }: { workspaceId: string; tabId: string }) => {
      const current = this.read(workspaceId);
      if (current.tabs.length === 1) {
        this.data.set(workspaceId, {
          ...current,
          revision: current.revision + 1,
          tabs: [
            {
              ...current.tabs[0]!,
              url: BROWSER_DEFAULT_URL,
              title: BROWSER_DEFAULT_TITLE,
              updatedAt: TIMESTAMP,
            },
          ],
        });
      } else {
        const tabs = current.tabs.filter(({ id }) => id !== tabId);
        this.data.set(workspaceId, {
          ...current,
          revision: current.revision + 1,
          activeTabId: current.activeTabId === tabId ? tabs[0]!.id : current.activeTabId,
          tabs,
        });
      }
      return this.read(workspaceId);
    },
  );
  readonly persistBrowserTabMetadata = vi.fn(
    (input: {
      readonly workspaceId: string;
      readonly tabId: string;
      readonly url: string;
      readonly title: string;
    }) => {
      if (!this.controlledMetadata) {
        return Promise.resolve(this.commitMetadata(input));
      }
      const operation = deferred<BrowserData>();
      this.pendingMetadata.push({ input: { ...input }, deferred: operation });
      return operation.promise;
    },
  );
  readonly toggleBrowserBookmark = vi.fn(async ({ workspaceId }: { workspaceId: string }) =>
    this.read(workspaceId),
  );
  readonly removeBrowserBookmark = vi.fn(async ({ workspaceId }: { workspaceId: string }) =>
    this.read(workspaceId),
  );

  constructor(private readonly controlledMetadata: boolean) {}

  resolveMetadata(index: number): void {
    const pending = this.pendingMetadata[index];
    if (!pending) throw new Error(`Missing metadata operation ${index}`);
    pending.deferred.resolve(this.commitMetadata(pending.input));
  }

  rejectMetadata(index: number, error: unknown): void {
    const pending = this.pendingMetadata[index];
    if (!pending) throw new Error(`Missing metadata operation ${index}`);
    pending.deferred.reject(error);
  }

  private commitMetadata(input: {
    readonly workspaceId: string;
    readonly tabId: string;
    readonly url: string;
    readonly title: string;
  }): BrowserData {
    const current = this.read(input.workspaceId);
    this.data.set(input.workspaceId, {
      ...current,
      revision: current.revision + 1,
      tabs: current.tabs.map((tab) =>
        tab.id === input.tabId
          ? { ...tab, url: input.url, title: input.title, updatedAt: TIMESTAMP }
          : tab,
      ),
    });
    return this.read(input.workspaceId);
  }

  private read(workspaceId: string): BrowserData {
    const value = this.data.get(workspaceId);
    if (!value) throw new Error(`Missing workspace ${workspaceId}`);
    return structuredClone(value);
  }
}

class FakeDownloadItem extends electron.FakeEmitter {
  getFilename() {
    return 'report.txt';
  }

  getURLChain() {
    return ['https://example.com/report.txt'];
  }

  getMimeType() {
    return 'text/plain';
  }

  getReceivedBytes() {
    return 100;
  }

  getTotalBytes() {
    return 100;
  }

  getSavePath() {
    return '/tmp/downloads/report.txt';
  }

  hasUserGesture() {
    return true;
  }

  isPaused() {
    return false;
  }

  canResume() {
    return false;
  }

  setSaveDialogOptions() {}

  pause() {}

  resume() {}

  cancel() {}
}

function createHarness(options?: {
  controlledMetadata?: boolean;
  onFocusAddress?: () => void;
  onStateChange?: (snapshot: BrowserSnapshot) => void;
}) {
  const snapshots: BrowserSnapshot[] = [];
  const childViews = new Set<unknown>();
  const parent = new electron.FakeEmitter() as InstanceType<typeof electron.FakeEmitter> & {
    contentView: {
      addChildView(view: unknown): void;
      removeChildView(view: unknown): void;
    };
    getContentSize(): [number, number];
    isDestroyed(): boolean;
  };
  parent.contentView = {
    addChildView: (view) => childViews.add(view),
    removeChildView: (view) => childViews.delete(view),
  };
  parent.getContentSize = () => [1_440, 900];
  parent.isDestroyed = () => false;
  const persistence = new FakePersistence(Boolean(options?.controlledMetadata));
  const controller = new BrowserController(parent as unknown as BrowserWindow, persistence, {
    onStateChange: (snapshot) => {
      const cloned = cloneSnapshot(snapshot);
      snapshots.push(cloned);
      options?.onStateChange?.(cloned);
    },
    onFocusAddress: options?.onFocusAddress,
  });
  activeControllers.push(controller);
  return { controller, persistence, snapshots, childViews };
}

function browserData(workspaceId: string, tabId: string): BrowserData {
  return {
    workspaceId,
    revision: 1,
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        url: BROWSER_DEFAULT_URL,
        title: BROWSER_DEFAULT_TITLE,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ],
    bookmarks: [],
  };
}

function requireContents(index: number): InstanceType<typeof electron.FakeWebContents> {
  const contents = electron.state.views[index]?.webContents;
  if (!contents) throw new Error(`Missing browser view ${index}`);
  return contents;
}

function cloneSnapshot(snapshot: BrowserSnapshot): BrowserSnapshot {
  return structuredClone(snapshot);
}

function expectSnapshotRevisionInvariant(snapshots: readonly BrowserSnapshot[]): void {
  const contentByRevision = new Map<number, string>();
  for (const snapshot of snapshots) {
    const content = JSON.stringify({ ...snapshot, revision: undefined });
    const existing = contentByRevision.get(snapshot.revision);
    if (existing !== undefined) expect(content).toBe(existing);
    else contentByRevision.set(snapshot.revision, content);
  }
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1]!;
    const current = snapshots[index]!;
    const previousContent = JSON.stringify({ ...previous, revision: undefined });
    const currentContent = JSON.stringify({ ...current, revision: undefined });
    if (previousContent !== currentContent) {
      expect(current.revision).toBeGreaterThan(previous.revision);
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferNextLoad(contents: InstanceType<typeof electron.FakeWebContents>) {
  const operation = deferred<void>();
  vi.spyOn(contents, 'loadURL').mockImplementationOnce((url: string) => {
    contents.loading = true;
    contents.loadCalls.push(url);
    return operation.promise;
  });
  return operation;
}
