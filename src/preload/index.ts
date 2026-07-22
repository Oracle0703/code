import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type BrowserBounds,
  type BrowserState,
  type DatabaseBackupInfo,
  type DatabaseStatus,
  type TerminalCreateOptions,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalSessionInfo,
  type Unsubscribe,
  type WorkbenchApi,
  type WorkspaceCreateInput,
  type WorkspacePreferences,
  type WorkspacePreferencesInput,
  type WorkspaceRenameInput,
  type WorkspaceSnapshot,
  type WorkspaceTargetInput,
} from '../shared/contracts';

function invoke<TResult>(channel: string, ...args: unknown[]): Promise<TResult> {
  return ipcRenderer.invoke(channel, ...args) as Promise<TResult>;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrappedListener = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload);
  };

  ipcRenderer.on(channel, wrappedListener);
  return () => {
    ipcRenderer.removeListener(channel, wrappedListener);
  };
}

const workbenchApi: WorkbenchApi = Object.freeze({
  app: Object.freeze({
    getVersion: () => invoke<string>(IPC_CHANNELS.app.getVersion),
  }),
  database: Object.freeze({
    getStatus: () => invoke<DatabaseStatus>(IPC_CHANNELS.database.getStatus),
    createBackup: () => invoke<DatabaseBackupInfo>(IPC_CHANNELS.database.createBackup),
    listBackups: () => invoke<DatabaseBackupInfo[]>(IPC_CHANNELS.database.listBackups),
  }),
  workspace: Object.freeze({
    getSnapshot: () => invoke<WorkspaceSnapshot>(IPC_CHANNELS.workspace.getSnapshot),
    create: (input: WorkspaceCreateInput) =>
      invoke<WorkspaceSnapshot>(IPC_CHANNELS.workspace.create, input),
    rename: (input: WorkspaceRenameInput) =>
      invoke<WorkspaceSnapshot>(IPC_CHANNELS.workspace.rename, input),
    activate: (input: WorkspaceTargetInput) =>
      invoke<WorkspaceSnapshot>(IPC_CHANNELS.workspace.activate, input),
    archive: (input: WorkspaceTargetInput) =>
      invoke<WorkspaceSnapshot>(IPC_CHANNELS.workspace.archive, input),
    updatePreferences: (input: WorkspacePreferencesInput) =>
      invoke<WorkspacePreferences>(IPC_CHANNELS.workspace.updatePreferences, input),
  }),
  window: Object.freeze({
    minimize: () => invoke<void>(IPC_CHANNELS.window.minimize),
    toggleMaximize: () => invoke<boolean>(IPC_CHANNELS.window.toggleMaximize),
    close: () => invoke<void>(IPC_CHANNELS.window.close),
  }),
  browser: Object.freeze({
    getState: () => invoke<BrowserState>(IPC_CHANNELS.browser.getState),
    navigate: (url: string) => invoke<BrowserState>(IPC_CHANNELS.browser.navigate, url),
    back: () => invoke<BrowserState>(IPC_CHANNELS.browser.back),
    forward: () => invoke<BrowserState>(IPC_CHANNELS.browser.forward),
    reload: () => invoke<BrowserState>(IPC_CHANNELS.browser.reload),
    stop: () => invoke<BrowserState>(IPC_CHANNELS.browser.stop),
    setBounds: (bounds: BrowserBounds) => invoke<void>(IPC_CHANNELS.browser.setBounds, bounds),
    setVisible: (visible: boolean) => invoke<void>(IPC_CHANNELS.browser.setVisible, visible),
    onStateChange: (listener: (state: BrowserState) => void) =>
      subscribe(IPC_CHANNELS.browser.stateChanged, listener),
  }),
  terminal: Object.freeze({
    create: (options?: TerminalCreateOptions) =>
      invoke<TerminalSessionInfo>(IPC_CHANNELS.terminal.create, options),
    write: (id: string, data: string) => invoke<void>(IPC_CHANNELS.terminal.write, id, data),
    resize: (id: string, columns: number, rows: number) =>
      invoke<void>(IPC_CHANNELS.terminal.resize, id, columns, rows),
    close: (id: string) => invoke<void>(IPC_CHANNELS.terminal.close, id),
    onData: (listener: (event: TerminalDataEvent) => void) =>
      subscribe(IPC_CHANNELS.terminal.data, listener),
    onExit: (listener: (event: TerminalExitEvent) => void) =>
      subscribe(IPC_CHANNELS.terminal.exit, listener),
  }),
});

contextBridge.exposeInMainWorld('workbench', workbenchApi);
