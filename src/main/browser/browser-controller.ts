import {
  type BrowserWindow,
  type Event,
  type Rectangle,
  type Session,
  WebContentsView,
} from 'electron';
import type { BrowserBounds, BrowserState } from '../../shared/contracts';
import { isAllowedBrowserUrl, normalizeBrowserUrl } from '../security/browser-url';

type StateListener = (state: BrowserState) => void;

const EMPTY_STATE: BrowserState = {
  url: 'https://www.google.com/',
  title: 'New tab',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
};

function statesEqual(left: BrowserState, right: BrowserState): boolean {
  return (
    left.url === right.url &&
    left.title === right.title &&
    left.canGoBack === right.canGoBack &&
    left.canGoForward === right.canGoForward &&
    left.isLoading === right.isLoading
  );
}

export class BrowserController {
  private readonly view: WebContentsView;
  private readonly browserSession: Session;
  private state: BrowserState = EMPTY_STATE;
  private lastRequestedUrl = EMPTY_STATE.url;
  private hasStartedNavigation = false;
  private requestedBounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 };
  private destroyed = false;

  private readonly handleParentResize = (): void => {
    this.applyBounds();
  };

  private readonly handleDownload = (event: Event): void => {
    event.preventDefault();
  };

  public constructor(
    private readonly parentWindow: BrowserWindow,
    private readonly onStateChange: StateListener,
  ) {
    this.view = new WebContentsView({
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
    this.browserSession = this.view.webContents.session;

    this.parentWindow.contentView.addChildView(this.view);
    this.view.setVisible(false);
    this.parentWindow.on('resize', this.handleParentResize);

    this.configureRemoteContentSecurity();
    this.registerNavigationEvents();
  }

  public getState(): BrowserState {
    return { ...this.state };
  }

  public navigate(input: string): BrowserState {
    this.ensureActive();
    const url = normalizeBrowserUrl(input);
    this.hasStartedNavigation = true;
    this.lastRequestedUrl = url;
    this.updateState({ url, isLoading: true });

    void this.view.webContents.loadURL(url).catch((error: unknown) => {
      if (!this.destroyed && !this.isNavigationCancellation(error)) {
        this.updateState({ isLoading: false });
      }
    });

    return this.getState();
  }

  public back(): BrowserState {
    this.ensureActive();
    const history = this.view.webContents.navigationHistory;
    if (history.canGoBack()) {
      history.goBack();
    }
    this.syncState();
    return this.getState();
  }

  public forward(): BrowserState {
    this.ensureActive();
    const history = this.view.webContents.navigationHistory;
    if (history.canGoForward()) {
      history.goForward();
    }
    this.syncState();
    return this.getState();
  }

  public reload(): BrowserState {
    this.ensureActive();
    this.view.webContents.reload();
    this.syncState();
    return this.getState();
  }

  public stop(): BrowserState {
    this.ensureActive();
    this.view.webContents.stop();
    this.updateState({ isLoading: false });
    return this.getState();
  }

  public setBounds(bounds: BrowserBounds): void {
    this.ensureActive();
    this.requestedBounds = { ...bounds };
    this.applyBounds();
  }

  public setVisible(visible: boolean): void {
    this.ensureActive();
    this.view.setVisible(visible);
    if (visible && !this.hasStartedNavigation) {
      this.navigate(this.lastRequestedUrl);
    }
  }

  public destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.parentWindow.off('resize', this.handleParentResize);
    this.browserSession.removeListener('will-download', this.handleDownload);
    this.browserSession.setPermissionCheckHandler(null);
    this.browserSession.setPermissionRequestHandler(null);

    if (!this.parentWindow.isDestroyed()) {
      this.parentWindow.contentView.removeChildView(this.view);
    }
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  private configureRemoteContentSecurity(): void {
    const contents = this.view.webContents;

    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    this.browserSession.on('will-download', this.handleDownload);

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserUrl(url)) {
        queueMicrotask(() => {
          if (!this.destroyed) {
            this.navigate(url);
          }
        });
      }
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
      if (!isAllowedBrowserUrl(url)) {
        event.preventDefault();
      }
    });

    contents.on('will-redirect', (event, url) => {
      if (!isAllowedBrowserUrl(url)) {
        event.preventDefault();
      }
    });
  }

  private registerNavigationEvents(): void {
    const contents = this.view.webContents;

    contents.on('did-start-loading', () => {
      this.updateState({ isLoading: true });
    });
    contents.on('did-stop-loading', () => {
      this.syncState({ isLoading: false });
    });
    contents.on('did-navigate', (_event, url) => {
      this.lastRequestedUrl = url;
      this.syncState({ url });
    });
    contents.on('did-navigate-in-page', (_event, url) => {
      this.lastRequestedUrl = url;
      this.syncState({ url });
    });
    contents.on('page-title-updated', (_event, title) => {
      this.syncState({ title: title || 'New tab' });
    });
    contents.on('did-fail-load', () => {
      this.syncState({ isLoading: false });
    });
  }

  private applyBounds(): void {
    if (this.destroyed || this.parentWindow.isDestroyed()) {
      return;
    }

    const [contentWidth, contentHeight] = this.parentWindow.getContentSize();
    const x = Math.min(this.requestedBounds.x, contentWidth);
    const y = Math.min(this.requestedBounds.y, contentHeight);
    const bounds: Rectangle = {
      x,
      y,
      width: Math.max(0, Math.min(this.requestedBounds.width, contentWidth - x)),
      height: Math.max(0, Math.min(this.requestedBounds.height, contentHeight - y)),
    };

    this.view.setBounds(bounds);
  }

  private syncState(overrides: Partial<BrowserState> = {}): void {
    if (this.destroyed || this.view.webContents.isDestroyed()) {
      return;
    }

    const contents = this.view.webContents;
    const history = contents.navigationHistory;
    const currentUrl = contents.getURL();
    const currentTitle = contents.getTitle();
    this.updateState({
      url: currentUrl || this.lastRequestedUrl,
      title: currentTitle || 'New tab',
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      isLoading: contents.isLoading(),
      ...overrides,
    });
  }

  private updateState(overrides: Partial<BrowserState>): void {
    if (this.destroyed) {
      return;
    }

    const nextState = { ...this.state, ...overrides };
    if (statesEqual(this.state, nextState)) {
      return;
    }

    this.state = nextState;
    this.onStateChange(this.getState());
  }

  private ensureActive(): void {
    if (this.destroyed || this.view.webContents.isDestroyed()) {
      throw new Error('Browser view is no longer available');
    }
  }

  private isNavigationCancellation(error: unknown): boolean {
    return error instanceof Error && error.message.includes('ERR_ABORTED');
  }
}
