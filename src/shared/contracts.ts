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
  task: {
    getSnapshot: 'task:get-snapshot',
    create: 'task:create',
    rename: 'task:rename',
    updateStatus: 'task:update-status',
    updatePlanning: 'task:update-planning',
    convertInbox: 'task:convert-inbox',
  },
  note: {
    getSnapshot: 'note:get-snapshot',
    create: 'note:create',
    update: 'note:update',
    archive: 'note:archive',
    convertInbox: 'note:convert-inbox',
  },
  schedule: {
    getSnapshot: 'schedule:get-snapshot',
    create: 'schedule:create',
    update: 'schedule:update',
    archive: 'schedule:archive',
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

export const TASK_STATUSES = ['todo', 'in_progress', 'completed'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PLANNING = ['today', 'none'] as const;

export type TaskPlanning = (typeof TASK_PLANNING)[number];

export interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly plannedFor: string | null;
  readonly sourceInboxEntryId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface TaskSnapshot {
  readonly workspaceId: string;
  readonly todayDate: string;
  readonly tasks: readonly Task[];
}

export interface TaskCreateInput {
  readonly workspaceId: string;
  readonly title: string;
  readonly planning: TaskPlanning;
}

export interface TaskTargetInput {
  readonly workspaceId: string;
  readonly taskId: string;
}

export interface TaskRenameInput extends TaskTargetInput {
  readonly title: string;
}

export interface TaskStatusInput extends TaskTargetInput {
  readonly status: TaskStatus;
}

export interface TaskPlanningInput extends TaskTargetInput {
  readonly planning: TaskPlanning;
}

export interface TaskConvertInboxInput {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly planning: TaskPlanning;
}

export interface TaskConversionResult {
  readonly taskSnapshot: TaskSnapshot;
  readonly inboxSnapshot: InboxSnapshot;
}

export interface Note {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly revision: number;
  readonly sourceInboxEntryId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteSnapshot {
  readonly workspaceId: string;
  readonly notes: readonly Note[];
}

export interface NoteCreateInput {
  readonly workspaceId: string;
  readonly title: string;
  readonly body: string;
}

export interface NoteTargetInput {
  readonly workspaceId: string;
  readonly noteId: string;
}

export interface NoteUpdateInput extends NoteTargetInput {
  readonly title: string;
  readonly body: string;
  readonly expectedRevision: number;
}

export interface NoteArchiveInput extends NoteTargetInput {
  readonly expectedRevision: number;
}

export interface NoteConvertInboxInput {
  readonly workspaceId: string;
  readonly entryId: string;
}

export interface NoteConversionResult {
  readonly noteSnapshot: NoteSnapshot;
  readonly inboxSnapshot: InboxSnapshot;
}

export const SCHEDULE_KINDS = ['focus', 'meeting', 'review', 'personal'] as const;

export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export interface ScheduleItem {
  readonly id: string;
  readonly title: string;
  readonly kind: ScheduleKind;
  readonly scheduledFor: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleSnapshot {
  readonly workspaceId: string;
  readonly todayDate: string;
  readonly items: readonly ScheduleItem[];
}

export interface ScheduleCreateInput {
  readonly workspaceId: string;
  readonly expectedDate: string;
  readonly title: string;
  readonly kind: ScheduleKind;
  readonly startMinute: number;
  readonly endMinute: number;
}

export interface ScheduleTargetInput {
  readonly workspaceId: string;
  readonly scheduleId: string;
  readonly expectedDate: string;
  readonly expectedRevision: number;
}

export interface ScheduleUpdateInput extends ScheduleTargetInput {
  readonly title: string;
  readonly kind: ScheduleKind;
  readonly startMinute: number;
  readonly endMinute: number;
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
  task: {
    getSnapshot(input: WorkspaceTargetInput): Promise<TaskSnapshot>;
    create(input: TaskCreateInput): Promise<TaskSnapshot>;
    rename(input: TaskRenameInput): Promise<TaskSnapshot>;
    updateStatus(input: TaskStatusInput): Promise<TaskSnapshot>;
    updatePlanning(input: TaskPlanningInput): Promise<TaskSnapshot>;
    convertInbox(input: TaskConvertInboxInput): Promise<TaskConversionResult>;
  };
  note: {
    getSnapshot(input: WorkspaceTargetInput): Promise<NoteSnapshot>;
    create(input: NoteCreateInput): Promise<NoteSnapshot>;
    update(input: NoteUpdateInput): Promise<NoteSnapshot>;
    archive(input: NoteArchiveInput): Promise<NoteSnapshot>;
    convertInbox(input: NoteConvertInboxInput): Promise<NoteConversionResult>;
  };
  schedule: {
    getSnapshot(input: WorkspaceTargetInput): Promise<ScheduleSnapshot>;
    create(input: ScheduleCreateInput): Promise<ScheduleSnapshot>;
    update(input: ScheduleUpdateInput): Promise<ScheduleSnapshot>;
    archive(input: ScheduleTargetInput): Promise<ScheduleSnapshot>;
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
