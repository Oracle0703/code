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
  workspace: {
    getSnapshot: 'workspace:get-snapshot',
    create: 'workspace:create',
    rename: 'workspace:rename',
    activate: 'workspace:activate',
    archive: 'workspace:archive',
    updatePreferences: 'workspace:update-preferences',
  },
  inbox: {
    getSnapshot: 'inbox:get-snapshot',
    create: 'inbox:create',
    categorize: 'inbox:categorize',
    archive: 'inbox:archive',
    undoArchive: 'inbox:undo-archive',
    captureRequested: 'inbox:capture-requested',
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

export const WORKSPACE_VIEW_IDS = [
  'today',
  'inbox',
  'tasks',
  'notes',
  'automations',
  'settings',
] as const;

export type WorkspaceViewId = (typeof WORKSPACE_VIEW_IDS)[number];

export const WORKSPACE_THEMES = ['dark', 'light'] as const;

export type WorkspaceTheme = (typeof WORKSPACE_THEMES)[number];

export const WORKSPACE_COLORS = [
  '#7b6ee8',
  '#348bd4',
  '#2da77e',
  '#d97757',
  '#c6579a',
  '#b68b32',
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

export interface WorkspaceInfo {
  readonly id: string;
  readonly name: string;
  readonly color: WorkspaceColor;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkspacePreferences {
  readonly activeView: WorkspaceViewId;
  readonly theme: WorkspaceTheme;
  readonly sidebarCollapsed: boolean;
  readonly browserOpen: boolean;
  readonly browserWidth: number;
  readonly terminalOpen: boolean;
  readonly terminalHeight: number;
}

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = Object.freeze({
  activeView: 'today',
  theme: 'dark',
  sidebarCollapsed: false,
  browserOpen: true,
  browserWidth: 430,
  terminalOpen: true,
  terminalHeight: 260,
});

export interface WorkspaceSnapshot {
  readonly currentWorkspaceId: string;
  readonly workspaces: readonly WorkspaceInfo[];
  readonly preferences: WorkspacePreferences;
}

export interface WorkspaceCreateInput {
  readonly name: string;
  readonly color: WorkspaceColor;
}

export interface WorkspaceRenameInput {
  readonly workspaceId: string;
  readonly name: string;
}

export interface WorkspaceTargetInput {
  readonly workspaceId: string;
}

export type WorkspacePreferencesPatch = Partial<WorkspacePreferences>;

export interface WorkspacePreferencesInput {
  readonly workspaceId: string;
  readonly patch: WorkspacePreferencesPatch;
}

export const INBOX_CATEGORIES = ['uncategorized', 'task', 'note', 'link'] as const;

export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

export interface InboxEntry {
  readonly id: string;
  readonly content: string;
  readonly category: InboxCategory;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InboxSnapshot {
  readonly workspaceId: string;
  readonly entries: readonly InboxEntry[];
}

export interface InboxCreateInput {
  readonly workspaceId: string;
  readonly content: string;
  readonly category: InboxCategory;
}

export interface InboxTargetInput {
  readonly workspaceId: string;
  readonly entryId: string;
}

export interface InboxCategorizeInput extends InboxTargetInput {
  readonly category: InboxCategory;
}

export interface InboxArchiveResult {
  readonly snapshot: InboxSnapshot;
  readonly undoToken: string;
  readonly undoExpiresAt: string;
}

export interface InboxUndoInput {
  readonly workspaceId: string;
  readonly undoToken: string;
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
  workspace: {
    getSnapshot(): Promise<WorkspaceSnapshot>;
    create(input: WorkspaceCreateInput): Promise<WorkspaceSnapshot>;
    rename(input: WorkspaceRenameInput): Promise<WorkspaceSnapshot>;
    activate(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot>;
    archive(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot>;
    updatePreferences(input: WorkspacePreferencesInput): Promise<WorkspacePreferences>;
  };
  inbox: {
    getSnapshot(input: WorkspaceTargetInput): Promise<InboxSnapshot>;
    create(input: InboxCreateInput): Promise<InboxSnapshot>;
    categorize(input: InboxCategorizeInput): Promise<InboxSnapshot>;
    archive(input: InboxTargetInput): Promise<InboxArchiveResult>;
    undoArchive(input: InboxUndoInput): Promise<InboxSnapshot>;
    onCaptureRequest(listener: () => void): Unsubscribe;
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
