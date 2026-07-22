import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type DatabaseBackupInfo, type DatabaseStatus } from '../../shared/contracts';
import type { BrowserController } from '../browser/browser-controller';
import { isTrustedRendererUrl, type TrustedRendererLocation } from '../security/trusted-renderer';
import type { TerminalManager } from '../terminal/terminal-manager';
import {
  assertNoArguments,
  parseBoolean,
  parseBrowserBounds,
  parseBrowserUrl,
  parseSessionId,
  parseTerminalCreateOptions,
  parseTerminalData,
  parseTerminalSize,
} from './validation';

interface IpcDependencies {
  window: BrowserWindow;
  browser: BrowserController;
  database: {
    getStatus(): Promise<DatabaseStatus>;
    createBackup(): Promise<DatabaseBackupInfo>;
    listBackups(): Promise<DatabaseBackupInfo[]>;
  };
  terminal: TerminalManager;
  trustedRendererLocation: TrustedRendererLocation;
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export function registerIpcHandlers({
  window,
  browser,
  database,
  terminal,
  trustedRendererLocation,
}: IpcDependencies): () => void {
  const registeredChannels: string[] = [];

  const register = (channel: string, handler: InvokeHandler): void => {
    const trustedHandler: InvokeHandler = (event, ...args) => {
      if (
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !isTrustedRendererUrl(event.senderFrame.url, trustedRendererLocation)
      ) {
        throw new Error('Untrusted IPC sender');
      }
      return handler(event, ...args);
    };

    ipcMain.handle(channel, trustedHandler);
    registeredChannels.push(channel);
  };

  register(IPC_CHANNELS.app.getVersion, () => app.getVersion());

  register(IPC_CHANNELS.database.getStatus, (_event, ...args) => {
    assertNoArguments(args, 'Getting database status');
    return database.getStatus();
  });
  register(IPC_CHANNELS.database.createBackup, (_event, ...args) => {
    assertNoArguments(args, 'Creating a database backup');
    return database.createBackup();
  });
  register(IPC_CHANNELS.database.listBackups, (_event, ...args) => {
    assertNoArguments(args, 'Listing database backups');
    return database.listBackups();
  });

  register(IPC_CHANNELS.window.minimize, () => {
    window.minimize();
  });
  register(IPC_CHANNELS.window.toggleMaximize, () => {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return window.isMaximized();
  });
  register(IPC_CHANNELS.window.close, () => {
    // Let Electron resolve the invoke before destroying its sender.
    queueMicrotask(() => {
      if (!window.isDestroyed()) {
        window.close();
      }
    });
  });

  register(IPC_CHANNELS.browser.getState, () => browser.getState());
  register(IPC_CHANNELS.browser.navigate, (_event, url) => {
    return browser.navigate(parseBrowserUrl(url));
  });
  register(IPC_CHANNELS.browser.back, () => browser.back());
  register(IPC_CHANNELS.browser.forward, () => browser.forward());
  register(IPC_CHANNELS.browser.reload, () => browser.reload());
  register(IPC_CHANNELS.browser.stop, () => browser.stop());
  register(IPC_CHANNELS.browser.setBounds, (_event, bounds) => {
    browser.setBounds(parseBrowserBounds(bounds));
  });
  register(IPC_CHANNELS.browser.setVisible, (_event, visible) => {
    browser.setVisible(parseBoolean(visible, 'visible'));
  });

  register(IPC_CHANNELS.terminal.create, (_event, options) => {
    return terminal.create(parseTerminalCreateOptions(options));
  });
  register(IPC_CHANNELS.terminal.write, (_event, id, data) => {
    terminal.write(parseSessionId(id), parseTerminalData(data));
  });
  register(IPC_CHANNELS.terminal.resize, (_event, id, columns, rows) => {
    const size = parseTerminalSize(columns, rows);
    terminal.resize(parseSessionId(id), size.columns, size.rows);
  });
  register(IPC_CHANNELS.terminal.close, (_event, id) => {
    terminal.close(parseSessionId(id));
  });

  return () => {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
  };
}
