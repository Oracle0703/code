import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, type WebContents } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { IPC_CHANNELS, type WindowCloseReason } from '../shared/contracts';
import { isQuickCaptureShortcut } from '../shared/quick-capture-shortcut';
import { BrowserController } from './browser/browser-controller';
import { DatabaseError, DatabaseService } from './database';
import { registerIpcHandlers } from './ipc/register-handlers';
import { isAllowedBrowserUrl } from './security/browser-url';
import {
  finishApprovedCloseSurfaces,
  prepareApprovedCloseSurfaces,
  runAfterCloseApproval,
  settleShutdownsBefore,
} from './shutdown-coordinator';
import { createTrustedRendererLocation } from './security/trusted-renderer';
import { TerminalManager } from './terminal/terminal-manager';
import { WindowCloseCoordinator } from './window-close-coordinator';
import { createWorkspaceIpcAdapter } from './workspace-ipc-adapter';

let mainWindow: BrowserWindow | null = null;
let databaseService: DatabaseService | null = null;
let databaseShutdownPromise: Promise<void> | null = null;
let allowQuit = false;
let startupFailureShown = false;
const runtimeShutdowns = new Set<() => Promise<void>>();
const closeApprovalRequests = new Set<(reason: WindowCloseReason) => Promise<boolean>>();
const approvedCloseSurfaces = new Set<BrowserWindow>();
let quitApprovalPromise: Promise<void> | null = null;

if (squirrelStartup) {
  app.quit();
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function denyWebviewAttachment(contents: WebContents): void {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

async function createMainWindow(database: DatabaseService): Promise<void> {
  const initialWorkspaceSnapshot = await database.getWorkspaceSnapshot();
  let rendererWorkspaceId = initialWorkspaceSnapshot.currentWorkspaceId;
  const rendererHtmlPath = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  const isDevelopmentRenderer = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  const rendererEntryUrl = isDevelopmentRenderer
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : pathToFileURL(rendererHtmlPath).href;
  const trustedRendererLocation = createTrustedRendererLocation(
    rendererEntryUrl,
    isDevelopmentRenderer,
  );

  const window = new BrowserWindow({
    width: 1_440,
    height: 900,
    minWidth: 1_100,
    minHeight: 720,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    title: 'Daily Workbench',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      allowRunningInsecureContent: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  mainWindow = window;
  approvedCloseSurfaces.add(window);

  window.webContents.on('before-input-event', (event, input) => {
    if (
      isQuickCaptureShortcut({
        type: input.type,
        key: input.key,
        control: input.control,
        meta: input.meta,
        alt: input.alt,
        shift: input.shift,
        repeat: input.isAutoRepeat,
        composing: input.isComposing,
      })
    ) {
      event.preventDefault();
      sendToRenderer(IPC_CHANNELS.inbox.captureRequested, undefined);
    }
  });

  const browser = new BrowserController(window, database, {
    onStateChange: (snapshot) => {
      sendToRenderer(IPC_CHANNELS.browser.stateChanged, snapshot);
    },
    onQuickCapture: () => {
      sendToRenderer(IPC_CHANNELS.inbox.captureRequested, undefined);
    },
    onFocusAddress: () => {
      sendToRenderer(IPC_CHANNELS.browser.focusAddressRequested, undefined);
    },
  });
  const closeCoordinator = new WindowCloseCoordinator({
    sendRequest: (request) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error('The window renderer is unavailable.');
      }
      window.webContents.send(IPC_CHANNELS.window.closeRequested, request);
    },
  });
  const requestCloseApproval = (reason: WindowCloseReason): Promise<boolean> =>
    closeCoordinator.requestApproval(reason);
  closeApprovalRequests.add(requestCloseApproval);
  const terminal = new TerminalManager({
    initialWorkspaceId: initialWorkspaceSnapshot.currentWorkspaceId,
    eventSink: {
      data: (event) => sendToRenderer(IPC_CHANNELS.terminal.data, event),
      exit: (event) => sendToRenderer(IPC_CHANNELS.terminal.exit, event),
      stateChanged: (snapshot) => sendToRenderer(IPC_CHANNELS.terminal.stateChanged, snapshot),
    },
  });
  const workspaceForIpc = createWorkspaceIpcAdapter(database, browser, terminal, (snapshot) => {
    rendererWorkspaceId = snapshot.currentWorkspaceId;
  });
  const unregisterIpc = registerIpcHandlers({
    window,
    windowLifecycle: {
      markCloseProtectionReady: () => closeCoordinator.markReady(),
      respondToCloseRequest: (response) => closeCoordinator.respond(response),
    },
    browser,
    database,
    workspace: workspaceForIpc,
    inbox: database,
    task: database,
    note: database,
    schedule: database,
    terminal,
    trustedRendererLocation,
  });

  const rendererSession = window.webContents.session;
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  const requestTrustedRendererUrl = (url: string): void => {
    if (!isAllowedBrowserUrl(url)) return;
    sendToRenderer(IPC_CHANNELS.browser.openUrlRequested, {
      workspaceId: rendererWorkspaceId,
      url,
    });
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    requestTrustedRendererUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    requestTrustedRendererUrl(url);
  });
  window.webContents.on('render-process-gone', () => {
    closeCoordinator.markUnavailable();
    void shutdownTerminal().catch((error: unknown) => {
      console.error('Daily Workbench failed to stop terminals after Renderer loss.', error);
    });
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  let cleanedUp = false;
  let closeFlowPromise: Promise<void> | null = null;
  let browserShutdownPromise: Promise<void> | null = null;
  let terminalShutdownPromise: Promise<void> | null = null;
  const shutdownBrowser = (): Promise<void> => {
    browserShutdownPromise ??= browser.shutdown();
    return browserShutdownPromise;
  };
  const shutdownTerminal = (): Promise<void> => {
    terminalShutdownPromise ??= terminal.shutdown();
    return terminalShutdownPromise;
  };
  runtimeShutdowns.add(shutdownBrowser);
  runtimeShutdowns.add(shutdownTerminal);
  const cleanUp = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    closeCoordinator.dispose();
    closeApprovalRequests.delete(requestCloseApproval);
    approvedCloseSurfaces.delete(window);
    unregisterIpc();
    void shutdownTerminal();
    browser.destroy();
    rendererSession.setPermissionCheckHandler(null);
    rendererSession.setPermissionRequestHandler(null);
  };

  window.on('close', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (closeFlowPromise) return;
    closeFlowPromise = runAfterCloseApproval([() => requestCloseApproval('window')], async () => {
      prepareApprovedCloseSurfaces([window], (error) => {
        console.error('Daily Workbench failed to disable its window before closing.', error);
      });
      try {
        await settleShutdownsBefore(
          [shutdownBrowser, shutdownTerminal],
          async () => undefined,
          (error) => {
            console.error(
              'Daily Workbench failed to stop a native workspace runtime before closing.',
              error,
            );
          },
        );
      } finally {
        // The approved window is already disabled and hidden, so force-close it without
        // reopening a second Renderer beforeunload decision after the asynchronous flush.
        finishApprovedCloseSurfaces([window], (error) => {
          console.error('Daily Workbench failed to destroy its approved window.', error);
        });
      }
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error('Daily Workbench could not complete the approved window close.', error);
      })
      .finally(() => {
        closeFlowPromise = null;
      });
  });

  window.once('closed', () => {
    runtimeShutdowns.delete(shutdownBrowser);
    runtimeShutdowns.delete(shutdownTerminal);
    closeApprovalRequests.delete(requestCloseApproval);
    approvedCloseSurfaces.delete(window);
    cleanUp();
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(rendererHtmlPath);
  }
}

function quitAfterStartupFailure(error: unknown): void {
  console.error('Daily Workbench failed to start.', error);
  if (!startupFailureShown) {
    startupFailureShown = true;
    const reference = error instanceof DatabaseError ? `\n\nReference: ${error.code}` : '';
    dialog.showErrorBox(
      'Daily Workbench could not start',
      `The local workspace could not be opened safely. Check application data permissions and try again.${reference}`,
    );
  }
  app.quit();
}

const hasSingleInstanceLock = !squirrelStartup && app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  if (!squirrelStartup) {
    app.quit();
  }
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    denyWebviewAttachment(contents);
  });

  app.on('before-quit', (event) => {
    if (allowQuit || !databaseService) {
      return;
    }

    event.preventDefault();
    if (!databaseShutdownPromise && !quitApprovalPromise) {
      const activeDatabase = databaseService;
      quitApprovalPromise = runAfterCloseApproval(
        [...closeApprovalRequests].map((requestApproval) => () => requestApproval('application')),
        async () => {
          prepareApprovedCloseSurfaces(approvedCloseSurfaces, (error) => {
            console.error('Daily Workbench failed to disable a window before quitting.', error);
          });
          databaseShutdownPromise = settleShutdownsBefore(
            runtimeShutdowns,
            () => activeDatabase.close(),
            (error) => {
              console.error(
                'Daily Workbench failed to stop a native workspace runtime before quitting.',
                error,
              );
            },
          )
            .catch((error: unknown) => {
              console.error('Daily Workbench failed to close its database cleanly.', error);
            })
            .finally(() => {
              databaseService = null;
              allowQuit = true;
              finishApprovedCloseSurfaces(approvedCloseSurfaces, (error) => {
                console.error('Daily Workbench failed to destroy an approved window.', error);
              });
              app.quit();
            });
          await databaseShutdownPromise;
        },
      )
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error('Daily Workbench could not complete the approved application quit.', error);
        })
        .finally(() => {
          quitApprovalPromise = null;
        });
    }
  });

  void app
    .whenReady()
    .then(async () => {
      if (process.platform === 'win32') {
        app.setAppUserModelId('com.squirrel.DailyWorkbench.daily-workbench');
      }

      const database = new DatabaseService({
        dataDirectory: join(app.getPath('userData'), 'data'),
      });
      databaseService = database;
      await database.open();
      if (databaseShutdownPromise) {
        return;
      }

      await createMainWindow(database);

      app.on('activate', () => {
        const activeDatabase = databaseService;
        if (
          activeDatabase &&
          !databaseShutdownPromise &&
          BrowserWindow.getAllWindows().length === 0
        ) {
          void createMainWindow(activeDatabase).catch(quitAfterStartupFailure);
        }
      });
    })
    .catch(quitAfterStartupFailure);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
