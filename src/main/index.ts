import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, type WebContents } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { IPC_CHANNELS } from '../shared/contracts';
import { BrowserController } from './browser/browser-controller';
import { DatabaseError, DatabaseService } from './database';
import { registerIpcHandlers } from './ipc/register-handlers';
import { isAllowedBrowserUrl } from './security/browser-url';
import { createTrustedRendererLocation } from './security/trusted-renderer';
import { TerminalManager } from './terminal/terminal-manager';

let mainWindow: BrowserWindow | null = null;
let databaseService: DatabaseService | null = null;
let databaseShutdownPromise: Promise<void> | null = null;
let allowQuit = false;
let startupFailureShown = false;

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

  const browser = new BrowserController(window, (state) => {
    sendToRenderer(IPC_CHANNELS.browser.stateChanged, state);
  });
  const terminal = new TerminalManager({
    data: (event) => sendToRenderer(IPC_CHANNELS.terminal.data, event),
    exit: (event) => sendToRenderer(IPC_CHANNELS.terminal.exit, event),
  });
  const unregisterIpc = registerIpcHandlers({
    window,
    browser,
    database,
    workspace: database,
    terminal,
    trustedRendererLocation,
  });

  const rendererSession = window.webContents.session;
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) {
      browser.navigate(url);
      browser.setVisible(true);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (isAllowedBrowserUrl(url)) {
      browser.navigate(url);
      browser.setVisible(true);
    }
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  let cleanedUp = false;
  const cleanUp = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    unregisterIpc();
    terminal.closeAll();
    browser.destroy();
    rendererSession.setPermissionCheckHandler(null);
    rendererSession.setPermissionRequestHandler(null);
  };

  window.once('closed', () => {
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
    if (!databaseShutdownPromise) {
      databaseShutdownPromise = databaseService
        .close()
        .catch((error: unknown) => {
          console.error('Daily Workbench failed to close its database cleanly.', error);
        })
        .finally(() => {
          databaseService = null;
          allowQuit = true;
          app.quit();
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
