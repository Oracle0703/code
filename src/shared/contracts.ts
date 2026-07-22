/**
 * The only messages allowed to cross the renderer/main-process boundary.
 *
 * Keep this file free of Electron and Node imports so it can be consumed by the
 * sandboxed renderer and by the preload script.
 */
export const IPC_CHANNELS = {
  app: {
    getVersion: 'app:get-version',
  },
  database: {
    getStatus: 'database:get-status',
    createBackup: 'database:create-backup',
    listBackups: 'database:list-backups',
  },
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    close: 'window:close',
  },
  browser: {
    getState: 'browser:get-state',
    navigate: 'browser:navigate',
    back: 'browser:back',
    forward: 'browser:forward',
    reload: 'browser:reload',
    stop: 'browser:stop',
    setBounds: 'browser:set-bounds',
    setVisible: 'browser:set-visible',
    stateChanged: 'browser:state-changed',
  },
  terminal: {
    create: 'terminal:create',
    write: 'terminal:write',
    resize: 'terminal:resize',
    close: 'terminal:close',
    data: 'terminal:data',
    exit: 'terminal:exit',
  },
} as const;

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

export type DatabaseBackupReason = 'manual' | 'pre-migration';

export interface DatabaseBackupInfo {
  id: string;
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  reason: DatabaseBackupReason;
  schemaVersion: number;
}

export interface DatabaseStatus {
  schemaVersion: number;
  appliedMigrations: number;
  sqliteVersion: string;
  journalMode: 'wal';
  integrityCheck: 'ok';
  backupCount: number;
}

export const TERMINAL_SHELLS = ['default', 'powershell', 'cmd', 'wsl', 'bash', 'zsh'] as const;

export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

export interface TerminalCreateOptions {
  cwd?: string;
  shell?: TerminalShell;
}

export interface TerminalSessionInfo {
  id: string;
  shell: TerminalShell;
  cwd: string;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
}

export type Unsubscribe = () => void;

export interface WorkbenchApi {
  app: {
    getVersion(): Promise<string>;
  };
  database: {
    getStatus(): Promise<DatabaseStatus>;
    createBackup(): Promise<DatabaseBackupInfo>;
    listBackups(): Promise<DatabaseBackupInfo[]>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
  };
  browser: {
    getState(): Promise<BrowserState>;
    navigate(url: string): Promise<BrowserState>;
    back(): Promise<BrowserState>;
    forward(): Promise<BrowserState>;
    reload(): Promise<BrowserState>;
    stop(): Promise<BrowserState>;
    setBounds(bounds: BrowserBounds): Promise<void>;
    setVisible(visible: boolean): Promise<void>;
    onStateChange(listener: (state: BrowserState) => void): Unsubscribe;
  };
  terminal: {
    create(options?: TerminalCreateOptions): Promise<TerminalSessionInfo>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, columns: number, rows: number): Promise<void>;
    close(id: string): Promise<void>;
    onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
    onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
  };
}
