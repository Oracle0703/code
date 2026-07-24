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
    getManagementSnapshot: 'database:get-management-snapshot',
    updateBackupPolicy: 'database:update-backup-policy',
    exportData: 'database:export-data',
    chooseImport: 'database:choose-import',
    commitImport: 'database:commit-import',
    cancelImport: 'database:cancel-import',
    backupStateChanged: 'database:backup-state-changed',
  },
  search: {
    query: 'search:query',
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
  focus: {
    getSnapshot: 'focus:get-snapshot',
    start: 'focus:start',
    pause: 'focus:pause',
    resume: 'focus:resume',
    cancel: 'focus:cancel',
    changed: 'focus:changed',
  },
  automation: {
    getSnapshot: 'automation:get-snapshot',
    create: 'automation:create',
    update: 'automation:update',
    setEnabled: 'automation:set-enabled',
    archive: 'automation:archive',
    changed: 'automation:changed',
  },
  assistant: {
    getCredentialStatus: 'assistant:get-credential-status',
    configureCredential: 'assistant:configure-credential',
    removeCredential: 'assistant:remove-credential',
    getSnapshot: 'assistant:get-snapshot',
    start: 'assistant:start',
    cancel: 'assistant:cancel',
    changed: 'assistant:changed',
  },
  window: {
    minimize: 'window:minimize',
    toggleMaximize: 'window:toggle-maximize',
    close: 'window:close',
    closeProtectionReady: 'window:close-protection-ready',
    respondCloseRequest: 'window:respond-close-request',
    closeRequested: 'window:close-requested',
  },
  browser: {
    getSnapshot: 'browser:get-snapshot',
    createTab: 'browser:create-tab',
    activateTab: 'browser:activate-tab',
    closeTab: 'browser:close-tab',
    navigate: 'browser:navigate',
    back: 'browser:back',
    forward: 'browser:forward',
    reload: 'browser:reload',
    stop: 'browser:stop',
    toggleBookmark: 'browser:toggle-bookmark',
    removeBookmark: 'browser:remove-bookmark',
    openBookmark: 'browser:open-bookmark',
    pauseDownload: 'browser:pause-download',
    resumeDownload: 'browser:resume-download',
    cancelDownload: 'browser:cancel-download',
    dismissDownload: 'browser:dismiss-download',
    revealDownload: 'browser:reveal-download',
    setBounds: 'browser:set-bounds',
    setVisible: 'browser:set-visible',
    stateChanged: 'browser:state-changed',
    focusAddressRequested: 'browser:focus-address-requested',
    openUrlRequested: 'browser:open-url-requested',
  },
  terminal: {
    getSnapshot: 'terminal:get-snapshot',
    create: 'terminal:create',
    updateProfile: 'terminal:update-profile',
    updateWslDistribution: 'terminal:update-wsl-distribution',
    chooseWorkingDirectory: 'terminal:choose-working-directory',
    resetWorkingDirectory: 'terminal:reset-working-directory',
    refreshCapabilities: 'terminal:refresh-capabilities',
    activate: 'terminal:activate',
    restart: 'terminal:restart',
    write: 'terminal:write',
    resize: 'terminal:resize',
    clear: 'terminal:clear',
    close: 'terminal:close',
    data: 'terminal:data',
    exit: 'terminal:exit',
    stateChanged: 'terminal:state-changed',
  },
} as const;

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isLoading: boolean;
}

export interface BrowserBookmark {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly createdAt: string;
}

export type BrowserDownloadState =
  'progressing' | 'paused' | 'interrupted' | 'completed' | 'cancelled' | 'failed';

export interface BrowserDownload {
  readonly id: string;
  readonly fileName: string;
  readonly sourceHost: string;
  readonly mimeType: string;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly state: BrowserDownloadState;
  readonly canResume: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BrowserSnapshot {
  readonly workspaceId: string;
  readonly revision: number;
  readonly activeTabId: string;
  readonly tabs: readonly BrowserTab[];
  readonly bookmarks: readonly BrowserBookmark[];
  readonly downloads: readonly BrowserDownload[];
}

export interface BrowserWorkspaceInput {
  readonly workspaceId: string;
}

export interface BrowserCreateTabInput extends BrowserWorkspaceInput {
  readonly url?: string;
}

export interface BrowserTabTargetInput extends BrowserWorkspaceInput {
  readonly tabId: string;
}

export interface BrowserNavigateInput extends BrowserTabTargetInput {
  readonly url: string;
}

export interface BrowserBookmarkTargetInput extends BrowserWorkspaceInput {
  readonly bookmarkId: string;
}

export interface BrowserOpenBookmarkInput extends BrowserBookmarkTargetInput {
  readonly newTab: boolean;
}

export interface BrowserDownloadTargetInput extends BrowserWorkspaceInput {
  readonly downloadId: string;
}

export interface BrowserBoundsInput extends BrowserWorkspaceInput {
  readonly bounds: BrowserBounds;
}

export interface BrowserVisibilityInput extends BrowserWorkspaceInput {
  readonly visible: boolean;
}

export interface BrowserOpenUrlRequest extends BrowserWorkspaceInput {
  readonly url: string;
}

export type WindowCloseReason = 'window' | 'application' | 'data-replacement';

export interface WindowCloseRequest {
  readonly requestId: string;
  readonly reason: WindowCloseReason;
}

export interface WindowCloseResponse {
  readonly requestId: string;
  readonly approved: boolean;
}

export type DatabaseBackupReason = 'manual' | 'scheduled' | 'pre-migration' | 'pre-import';

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

export const SEARCH_SCOPES = ['workspace', 'all'] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const SEARCH_RESULT_KINDS = [
  'inbox',
  'task',
  'note',
  'schedule',
  'browser-tab',
  'browser-bookmark',
] as const;

export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

export interface SearchQueryInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly scope: SearchScope;
}

export interface SearchResult {
  readonly kind: SearchResultKind;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly matchField: 'title' | 'content' | 'url';
  readonly sortAt: string;
}

export interface SearchSnapshot {
  readonly workspaceId: string;
  readonly query: string;
  readonly scope: SearchScope;
  readonly results: readonly SearchResult[];
  readonly truncated: boolean;
  readonly truncatedKinds: readonly SearchResultKind[];
}

export const BACKUP_CADENCES = ['daily', 'weekly'] as const;

export type BackupCadence = (typeof BACKUP_CADENCES)[number];

export interface BackupPolicy {
  readonly enabled: boolean;
  readonly cadence: BackupCadence;
  readonly localTimeMinute: number;
  readonly weekday: number | null;
  readonly retentionCount: number;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface BackupPolicyUpdateInput {
  readonly enabled: boolean;
  readonly cadence: BackupCadence;
  readonly localTimeMinute: number;
  readonly weekday: number | null;
  readonly retentionCount: number;
  readonly expectedRevision: number;
}

export type BackupRunErrorCode = 'backup-failed' | 'retention-failed' | 'database-unavailable';

export interface BackupScheduleState {
  readonly policy: BackupPolicy;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorCode: BackupRunErrorCode | null;
  readonly consecutiveFailures: number;
  readonly nextRunAt: string | null;
  readonly running: boolean;
}

export interface DataManagementSnapshot {
  readonly database: DatabaseStatus;
  readonly backups: readonly DatabaseBackupInfo[];
  readonly schedule: BackupScheduleState;
}

export interface DataExportResult {
  readonly status: 'cancelled' | 'exported';
  readonly fileName?: string;
  readonly exportedAt?: string;
  readonly sizeBytes?: number;
  readonly recordCount?: number;
}

export interface DataImportCounts {
  readonly workspaces: number;
  readonly archivedWorkspaces: number;
  readonly inboxEntries: number;
  readonly tasks: number;
  readonly notes: number;
  readonly scheduleItems: number;
  readonly browserTabs: number;
  readonly browserBookmarks: number;
  readonly automations: number;
  readonly enabledAutomations: number;
  readonly focusSessions: number;
}

export interface DataImportPreview {
  readonly importId: string;
  readonly previewDigest: string;
  readonly expiresAt: string;
  readonly exportedAt: string;
  readonly sourceAppVersion: string;
  readonly sourceSchemaVersion: number;
  readonly currentWorkspaceName: string;
  readonly counts: DataImportCounts;
  readonly includesArchivedData: boolean;
  readonly includesBrowserData: boolean;
}

export type DataImportSelection =
  | { readonly status: 'cancelled' }
  | { readonly status: 'ready'; readonly preview: DataImportPreview };

export interface DataImportTargetInput {
  readonly importId: string;
}

export interface DataImportCommitInput extends DataImportTargetInput {
  readonly previewDigest: string;
}

export interface DataImportCommitResult {
  readonly restarting: true;
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

export const PLANNING_DAY_TOKENS = [
  'day-0',
  'day-1',
  'day-2',
  'day-3',
  'day-4',
  'day-5',
  'day-6',
] as const;

export type PlanningDayToken = (typeof PLANNING_DAY_TOKENS)[number];

export interface PlanningDay {
  readonly token: PlanningDayToken;
  readonly date: string;
}

export const TASK_PLANNING = [...PLANNING_DAY_TOKENS, 'none'] as const;

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
  readonly planningDays: readonly PlanningDay[];
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
  readonly planningDays: readonly PlanningDay[];
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

export const FOCUS_STATES = ['running', 'paused', 'completed', 'cancelled'] as const;

export type FocusState = (typeof FOCUS_STATES)[number];

export interface FocusSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  readonly status: FocusState;
  readonly remainingSeconds: number;
  readonly deadlineAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FocusSnapshot {
  readonly workspaceId: string;
  readonly todayDate: string;
  readonly observedAt: string;
  readonly session: FocusSession | null;
  readonly todayCompletedCount: number;
}

export interface FocusStartInput {
  readonly workspaceId: string;
  readonly taskId?: string;
}

export interface FocusTargetInput {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly expectedRevision: number;
}

export interface FocusChangedEvent {
  readonly workspaceId: string;
  readonly reason: 'transition' | 'timer' | 'external';
}

export const AUTOMATION_CADENCES = ['daily', 'weekly'] as const;

export type AutomationCadence = (typeof AUTOMATION_CADENCES)[number];

export const AUTOMATION_ACTION_KINDS = ['create-today-task', 'create-note'] as const;

export type AutomationActionKind = (typeof AUTOMATION_ACTION_KINDS)[number];

export type AutomationAction =
  | {
      readonly kind: 'create-today-task';
      readonly title: string;
    }
  | {
      readonly kind: 'create-note';
      readonly title: string;
      readonly body: string;
    };

export interface AutomationSchedule {
  readonly cadence: AutomationCadence;
  readonly localTimeMinute: number;
  readonly weekday: number | null;
}

export type AutomationRunErrorCode =
  'action-failed' | 'database-unavailable' | 'workspace-unavailable';

export type AutomationLastRun =
  | {
      readonly status: 'never';
    }
  | {
      readonly status: 'success';
      readonly attemptedAt: string;
      readonly completedAt: string;
      readonly outputKind: 'task' | 'note';
    }
  | {
      readonly status: 'failed';
      readonly attemptedAt: string;
      readonly errorCode: AutomationRunErrorCode;
      readonly consecutiveFailures: number;
      readonly nextRetryAt: string;
    };

export interface AutomationItem {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: AutomationSchedule;
  readonly action: AutomationAction;
  readonly revision: number;
  readonly nextRunAt: string | null;
  readonly lastRun: AutomationLastRun;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutomationSnapshot {
  readonly workspaceId: string;
  readonly items: readonly AutomationItem[];
}

export interface AutomationCreateInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly schedule: AutomationSchedule;
  readonly action: AutomationAction;
}

export interface AutomationTargetInput {
  readonly workspaceId: string;
  readonly automationId: string;
  readonly expectedRevision: number;
}

export interface AutomationUpdateInput extends AutomationTargetInput {
  readonly name: string;
  readonly schedule: AutomationSchedule;
  readonly action: AutomationAction;
}

export interface AutomationSetEnabledInput extends AutomationTargetInput {
  readonly enabled: boolean;
}

export interface AutomationChangedEvent {
  readonly workspaceId: string;
  readonly reason: 'definition' | 'run';
  readonly outputKind: 'task' | 'note' | null;
}

export type AssistantContextReference =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'today';
    }
  | {
      readonly kind: 'tasks';
      readonly taskIds: readonly string[];
    }
  | {
      readonly kind: 'note';
      readonly noteId: string;
      readonly revision: number;
    };

export interface AssistantCredentialInput {
  readonly apiKey: string;
}

export type AssistantCredentialAvailability = 'available' | 'unavailable';

export type AssistantCredentialReason =
  'secure-storage-unavailable' | 'plaintext-storage' | 'credential-corrupt' | null;

export interface AssistantCredentialStatus {
  readonly availability: AssistantCredentialAvailability;
  readonly configured: boolean;
  readonly removable: boolean;
  readonly provider: 'OpenAI';
  readonly model: 'gpt-5.6';
  readonly reason: AssistantCredentialReason;
}

export type AssistantPhase = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export type AssistantErrorCode =
  | 'not-configured'
  | 'credential-unavailable'
  | 'invalid-context'
  | 'provider-authentication'
  | 'provider-rate-limited'
  | 'provider-unavailable'
  | 'request-timeout'
  | 'response-too-large'
  | 'internal-error';

export interface AssistantError {
  readonly code: AssistantErrorCode;
  readonly message: string;
}

export interface AssistantContextSummary {
  readonly kind: AssistantContextReference['kind'];
  readonly label: string;
  readonly includedCount: number;
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface AssistantSnapshot {
  readonly sequence: number;
  readonly workspaceId: string;
  readonly phase: AssistantPhase;
  readonly runId: string | null;
  readonly prompt: string;
  readonly context: AssistantContextReference;
  readonly contextSummary: AssistantContextSummary;
  readonly response: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: AssistantError | null;
}

export interface AssistantStartInput {
  readonly prompt: string;
  readonly context: AssistantContextReference;
}

export interface AssistantCancelInput {
  readonly runId: string;
}

export const TERMINAL_PROFILE_IDS = [
  'system-default',
  'powershell-7',
  'windows-powershell',
  'command-prompt',
  'wsl-default',
  'bash',
  'zsh',
] as const;

export type TerminalProfileId = (typeof TERMINAL_PROFILE_IDS)[number];

export type TerminalProfileKind = 'system' | 'powershell' | 'command-prompt' | 'wsl' | 'posix';

export interface TerminalProfile {
  readonly id: TerminalProfileId;
  readonly label: string;
  readonly kind: TerminalProfileKind;
  readonly isDefault: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export type TerminalCwdMode = 'user-home' | 'selected-directory';

export interface TerminalWorkingDirectory {
  readonly mode: TerminalCwdMode;
  readonly displayPath: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

export interface TerminalWslDistribution {
  readonly id: string;
  readonly label: string;
}

export type TerminalWslCapabilityStatus =
  'unsupported' | 'not-installed' | 'no-distributions' | 'ready' | 'probe-error';

export interface TerminalWslConfiguration {
  readonly status: TerminalWslCapabilityStatus;
  readonly capabilityRevision: number;
  readonly distributions: readonly TerminalWslDistribution[];
  readonly selectedDistributionId: string | null;
  readonly selectedDistributionLabel: string | null;
  readonly selectedDistributionAvailable: boolean;
}

export interface TerminalConfigurationSnapshot {
  readonly revision: number;
  readonly preferredProfileId: TerminalProfileId;
  readonly workingDirectory: TerminalWorkingDirectory;
  readonly wsl: TerminalWslConfiguration;
}

export type TerminalSessionStatus = 'running' | 'exited';

export interface TerminalSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly profileId: TerminalProfileId;
  readonly label: string;
  readonly status: TerminalSessionStatus;
  readonly createdAt: string;
  readonly exitCode?: number;
}

export interface TerminalSnapshot {
  readonly workspaceId: string;
  readonly revision: number;
  readonly activeSessionId: string | null;
  readonly sessions: readonly TerminalSession[];
  readonly profiles: readonly TerminalProfile[];
  readonly configuration: TerminalConfigurationSnapshot;
}

export interface TerminalWorkspaceInput {
  readonly workspaceId: string;
}

export interface TerminalCreateInput extends TerminalWorkspaceInput {
  readonly configurationRevision: number;
  readonly profileId?: TerminalProfileId;
}

export interface TerminalConfigurationRevisionInput extends TerminalWorkspaceInput {
  readonly expectedRevision: number;
}

export interface TerminalProfilePreferenceInput extends TerminalConfigurationRevisionInput {
  readonly profileId: TerminalProfileId;
}

export interface TerminalWslPreferenceInput extends TerminalConfigurationRevisionInput {
  readonly capabilityRevision: number;
  readonly distributionId: string | null;
}

export interface TerminalSessionTargetInput extends TerminalWorkspaceInput {
  readonly sessionId: string;
}

export interface TerminalWriteInput extends TerminalSessionTargetInput {
  readonly data: string;
}

export interface TerminalResizeInput extends TerminalSessionTargetInput {
  readonly columns: number;
  readonly rows: number;
}

export interface TerminalDataEvent extends TerminalSessionTargetInput {
  readonly sequence: number;
  readonly data: string;
}

export interface TerminalExitEvent extends TerminalSessionTargetInput {
  readonly exitCode: number;
  readonly signal?: number;
}

export type TerminalWorkingDirectorySelection =
  | { readonly status: 'cancelled'; readonly snapshot: TerminalSnapshot }
  | { readonly status: 'updated'; readonly snapshot: TerminalSnapshot };

export type Unsubscribe = () => void;

export interface WorkbenchApi {
  app: {
    getVersion(): Promise<string>;
  };
  database: {
    getStatus(): Promise<DatabaseStatus>;
    createBackup(): Promise<DatabaseBackupInfo>;
    listBackups(): Promise<DatabaseBackupInfo[]>;
    getManagementSnapshot(): Promise<DataManagementSnapshot>;
    updateBackupPolicy(input: BackupPolicyUpdateInput): Promise<DataManagementSnapshot>;
    exportData(): Promise<DataExportResult>;
    chooseImport(): Promise<DataImportSelection>;
    commitImport(input: DataImportCommitInput): Promise<DataImportCommitResult>;
    cancelImport(input: DataImportTargetInput): Promise<void>;
    onBackupStateChange(listener: (snapshot: DataManagementSnapshot) => void): Unsubscribe;
  };
  search: {
    query(input: SearchQueryInput): Promise<SearchSnapshot>;
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
  focus: {
    getSnapshot(input: WorkspaceTargetInput): Promise<FocusSnapshot>;
    start(input: FocusStartInput): Promise<FocusSnapshot>;
    pause(input: FocusTargetInput): Promise<FocusSnapshot>;
    resume(input: FocusTargetInput): Promise<FocusSnapshot>;
    cancel(input: FocusTargetInput): Promise<FocusSnapshot>;
    onChanged(listener: (event: FocusChangedEvent) => void): Unsubscribe;
  };
  automation: {
    getSnapshot(input: WorkspaceTargetInput): Promise<AutomationSnapshot>;
    create(input: AutomationCreateInput): Promise<AutomationSnapshot>;
    update(input: AutomationUpdateInput): Promise<AutomationSnapshot>;
    setEnabled(input: AutomationSetEnabledInput): Promise<AutomationSnapshot>;
    archive(input: AutomationTargetInput): Promise<AutomationSnapshot>;
    onChanged(listener: (event: AutomationChangedEvent) => void): Unsubscribe;
  };
  assistant: {
    getCredentialStatus(): Promise<AssistantCredentialStatus>;
    configureCredential(input: AssistantCredentialInput): Promise<AssistantCredentialStatus>;
    removeCredential(): Promise<AssistantCredentialStatus>;
    getSnapshot(): Promise<AssistantSnapshot>;
    start(input: AssistantStartInput): Promise<AssistantSnapshot>;
    cancel(input: AssistantCancelInput): Promise<AssistantSnapshot>;
    onChanged(listener: (snapshot: AssistantSnapshot) => void): Unsubscribe;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    onCloseRequest(
      listener: (request: WindowCloseRequest) => boolean | Promise<boolean>,
    ): Unsubscribe;
  };
  browser: {
    getSnapshot(input: BrowserWorkspaceInput): Promise<BrowserSnapshot>;
    createTab(input: BrowserCreateTabInput): Promise<BrowserSnapshot>;
    activateTab(input: BrowserTabTargetInput): Promise<BrowserSnapshot>;
    closeTab(input: BrowserTabTargetInput): Promise<BrowserSnapshot>;
    navigate(input: BrowserNavigateInput): Promise<BrowserSnapshot>;
    back(input: BrowserTabTargetInput): Promise<BrowserSnapshot>;
    forward(input: BrowserTabTargetInput): Promise<BrowserSnapshot>;
    reload(input: BrowserTabTargetInput): Promise<BrowserSnapshot>;
    stop(input: BrowserTabTargetInput): Promise<BrowserSnapshot>;
    toggleBookmark(input: BrowserTabTargetInput): Promise<BrowserSnapshot>;
    removeBookmark(input: BrowserBookmarkTargetInput): Promise<BrowserSnapshot>;
    openBookmark(input: BrowserOpenBookmarkInput): Promise<BrowserSnapshot>;
    pauseDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot>;
    resumeDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot>;
    cancelDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot>;
    dismissDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot>;
    revealDownload(input: BrowserDownloadTargetInput): Promise<BrowserSnapshot>;
    setBounds(input: BrowserBoundsInput): Promise<void>;
    setVisible(input: BrowserVisibilityInput): Promise<void>;
    onStateChange(listener: (snapshot: BrowserSnapshot) => void): Unsubscribe;
    onFocusAddressRequest(listener: () => void): Unsubscribe;
    onOpenUrlRequest(listener: (request: BrowserOpenUrlRequest) => void): Unsubscribe;
  };
  terminal: {
    getSnapshot(input: TerminalWorkspaceInput): Promise<TerminalSnapshot>;
    create(input: TerminalCreateInput): Promise<TerminalSnapshot>;
    updateProfile(input: TerminalProfilePreferenceInput): Promise<TerminalSnapshot>;
    updateWslDistribution(input: TerminalWslPreferenceInput): Promise<TerminalSnapshot>;
    chooseWorkingDirectory(
      input: TerminalConfigurationRevisionInput,
    ): Promise<TerminalWorkingDirectorySelection>;
    resetWorkingDirectory(input: TerminalConfigurationRevisionInput): Promise<TerminalSnapshot>;
    refreshCapabilities(input: TerminalWorkspaceInput): Promise<TerminalSnapshot>;
    activate(input: TerminalSessionTargetInput): Promise<TerminalSnapshot>;
    restart(input: TerminalSessionTargetInput): Promise<TerminalSnapshot>;
    write(input: TerminalWriteInput): Promise<void>;
    resize(input: TerminalResizeInput): Promise<void>;
    clear(input: TerminalSessionTargetInput): Promise<void>;
    close(input: TerminalSessionTargetInput): Promise<TerminalSnapshot>;
    onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
    onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
    onStateChange(listener: (snapshot: TerminalSnapshot) => void): Unsubscribe;
  };
}
