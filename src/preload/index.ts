import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IPC_CHANNELS,
  type BrowserBoundsInput,
  type BrowserBookmarkTargetInput,
  type BrowserCreateTabInput,
  type BrowserDownloadTargetInput,
  type BrowserNavigateInput,
  type BrowserOpenBookmarkInput,
  type BrowserOpenUrlRequest,
  type BrowserSnapshot,
  type BrowserTabTargetInput,
  type BrowserVisibilityInput,
  type BrowserWorkspaceInput,
  type BackupPolicyUpdateInput,
  type DataExportResult,
  type DataImportCommitInput,
  type DataImportCommitResult,
  type DataImportSelection,
  type DataImportTargetInput,
  type DataManagementSnapshot,
  type DatabaseBackupInfo,
  type DatabaseStatus,
  type InboxArchiveResult,
  type InboxCategorizeInput,
  type InboxCreateInput,
  type InboxSnapshot,
  type InboxTargetInput,
  type InboxUndoInput,
  type NoteArchiveInput,
  type NoteConversionResult,
  type NoteConvertInboxInput,
  type NoteCreateInput,
  type NoteSnapshot,
  type NoteUpdateInput,
  type ScheduleCreateInput,
  type ScheduleSnapshot,
  type ScheduleTargetInput,
  type ScheduleUpdateInput,
  type SearchQueryInput,
  type SearchSnapshot,
  type TaskConversionResult,
  type TaskConvertInboxInput,
  type TaskCreateInput,
  type TaskPlanningInput,
  type TaskRenameInput,
  type TaskSnapshot,
  type TaskStatusInput,
  type TerminalCreateInput,
  type TerminalConfigurationRevisionInput,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalProfilePreferenceInput,
  type TerminalResizeInput,
  type TerminalSessionTargetInput,
  type TerminalSnapshot,
  type TerminalWorkspaceInput,
  type TerminalWorkingDirectorySelection,
  type TerminalWslPreferenceInput,
  type TerminalWriteInput,
  type Unsubscribe,
  type WindowCloseRequest,
  type WindowCloseResponse,
  type WorkbenchApi,
  type WorkspaceCreateInput,
  type WorkspacePreferences,
  type WorkspacePreferencesInput,
  type WorkspaceRenameInput,
  type WorkspaceSnapshot,
  type WorkspaceTargetInput,
} from '../shared/contracts';
import { freezeRendererCloseSurface } from './close-surface';

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

function subscribeToCloseRequests(
  listener: (request: WindowCloseRequest) => boolean | Promise<boolean>,
): Unsubscribe {
  const wrappedListener = (_event: IpcRendererEvent, request: WindowCloseRequest): void => {
    void Promise.resolve()
      .then(() => listener(request))
      .then(
        async (approved) => {
          const releaseCloseSurface =
            approved === true ? freezeCurrentRendererCloseSurface() : null;
          try {
            await invoke<void>(IPC_CHANNELS.window.respondCloseRequest, {
              requestId: request.requestId,
              approved: approved === true,
            } satisfies WindowCloseResponse);
          } catch {
            try {
              await invoke<void>(IPC_CHANNELS.window.respondCloseRequest, {
                requestId: request.requestId,
                approved: false,
              } satisfies WindowCloseResponse);
            } catch {
              // Main may already be closing or the transport may be unavailable.
            } finally {
              releaseCloseSurface?.();
            }
          }
        },
        () =>
          invoke<void>(IPC_CHANNELS.window.respondCloseRequest, {
            requestId: request.requestId,
            approved: false,
          } satisfies WindowCloseResponse),
      )
      .catch(() => undefined);
  };

  ipcRenderer.on(IPC_CHANNELS.window.closeRequested, wrappedListener);
  void invoke<void>(IPC_CHANNELS.window.closeProtectionReady).catch(() => undefined);
  return () => {
    ipcRenderer.removeListener(IPC_CHANNELS.window.closeRequested, wrappedListener);
  };
}

function freezeCurrentRendererCloseSurface(): () => void {
  const preloadDocument = (
    globalThis as {
      document?: {
        documentElement?: { inert: boolean };
        activeElement?: unknown;
      };
    }
  ).document;
  const surface = preloadDocument?.documentElement;
  if (!surface) return () => undefined;
  const activeElement = preloadDocument.activeElement;
  let focusedControl: { blur(): void } | null = null;
  if (
    activeElement &&
    typeof activeElement === 'object' &&
    'blur' in activeElement &&
    typeof activeElement.blur === 'function'
  ) {
    const blur = activeElement.blur as () => void;
    focusedControl = { blur: () => blur.call(activeElement) };
  }
  return freezeRendererCloseSurface(surface, focusedControl);
}

const workbenchApi: WorkbenchApi = Object.freeze({
  app: Object.freeze({
    getVersion: () => invoke<string>(IPC_CHANNELS.app.getVersion),
  }),
  database: Object.freeze({
    getStatus: () => invoke<DatabaseStatus>(IPC_CHANNELS.database.getStatus),
    createBackup: () => invoke<DatabaseBackupInfo>(IPC_CHANNELS.database.createBackup),
    listBackups: () => invoke<DatabaseBackupInfo[]>(IPC_CHANNELS.database.listBackups),
    getManagementSnapshot: () =>
      invoke<DataManagementSnapshot>(IPC_CHANNELS.database.getManagementSnapshot),
    updateBackupPolicy: (input: BackupPolicyUpdateInput) =>
      invoke<DataManagementSnapshot>(IPC_CHANNELS.database.updateBackupPolicy, input),
    exportData: () => invoke<DataExportResult>(IPC_CHANNELS.database.exportData),
    chooseImport: () => invoke<DataImportSelection>(IPC_CHANNELS.database.chooseImport),
    commitImport: (input: DataImportCommitInput) =>
      invoke<DataImportCommitResult>(IPC_CHANNELS.database.commitImport, input),
    cancelImport: (input: DataImportTargetInput) =>
      invoke<void>(IPC_CHANNELS.database.cancelImport, input),
    onBackupStateChange: (listener: (snapshot: DataManagementSnapshot) => void) =>
      subscribe(IPC_CHANNELS.database.backupStateChanged, listener),
  }),
  search: Object.freeze({
    query: (input: SearchQueryInput) => invoke<SearchSnapshot>(IPC_CHANNELS.search.query, input),
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
  inbox: Object.freeze({
    getSnapshot: (input: WorkspaceTargetInput) =>
      invoke<InboxSnapshot>(IPC_CHANNELS.inbox.getSnapshot, input),
    create: (input: InboxCreateInput) => invoke<InboxSnapshot>(IPC_CHANNELS.inbox.create, input),
    categorize: (input: InboxCategorizeInput) =>
      invoke<InboxSnapshot>(IPC_CHANNELS.inbox.categorize, input),
    archive: (input: InboxTargetInput) =>
      invoke<InboxArchiveResult>(IPC_CHANNELS.inbox.archive, input),
    undoArchive: (input: InboxUndoInput) =>
      invoke<InboxSnapshot>(IPC_CHANNELS.inbox.undoArchive, input),
    onCaptureRequest: (listener: () => void) =>
      subscribe(IPC_CHANNELS.inbox.captureRequested, listener),
  }),
  task: Object.freeze({
    getSnapshot: (input: WorkspaceTargetInput) =>
      invoke<TaskSnapshot>(IPC_CHANNELS.task.getSnapshot, input),
    create: (input: TaskCreateInput) => invoke<TaskSnapshot>(IPC_CHANNELS.task.create, input),
    rename: (input: TaskRenameInput) => invoke<TaskSnapshot>(IPC_CHANNELS.task.rename, input),
    updateStatus: (input: TaskStatusInput) =>
      invoke<TaskSnapshot>(IPC_CHANNELS.task.updateStatus, input),
    updatePlanning: (input: TaskPlanningInput) =>
      invoke<TaskSnapshot>(IPC_CHANNELS.task.updatePlanning, input),
    convertInbox: (input: TaskConvertInboxInput) =>
      invoke<TaskConversionResult>(IPC_CHANNELS.task.convertInbox, input),
  }),
  note: Object.freeze({
    getSnapshot: (input: WorkspaceTargetInput) =>
      invoke<NoteSnapshot>(IPC_CHANNELS.note.getSnapshot, input),
    create: (input: NoteCreateInput) => invoke<NoteSnapshot>(IPC_CHANNELS.note.create, input),
    update: (input: NoteUpdateInput) => invoke<NoteSnapshot>(IPC_CHANNELS.note.update, input),
    archive: (input: NoteArchiveInput) => invoke<NoteSnapshot>(IPC_CHANNELS.note.archive, input),
    convertInbox: (input: NoteConvertInboxInput) =>
      invoke<NoteConversionResult>(IPC_CHANNELS.note.convertInbox, input),
  }),
  schedule: Object.freeze({
    getSnapshot: (input: WorkspaceTargetInput) =>
      invoke<ScheduleSnapshot>(IPC_CHANNELS.schedule.getSnapshot, input),
    create: (input: ScheduleCreateInput) =>
      invoke<ScheduleSnapshot>(IPC_CHANNELS.schedule.create, input),
    update: (input: ScheduleUpdateInput) =>
      invoke<ScheduleSnapshot>(IPC_CHANNELS.schedule.update, input),
    archive: (input: ScheduleTargetInput) =>
      invoke<ScheduleSnapshot>(IPC_CHANNELS.schedule.archive, input),
  }),
  window: Object.freeze({
    minimize: () => invoke<void>(IPC_CHANNELS.window.minimize),
    toggleMaximize: () => invoke<boolean>(IPC_CHANNELS.window.toggleMaximize),
    close: () => invoke<void>(IPC_CHANNELS.window.close),
    onCloseRequest: subscribeToCloseRequests,
  }),
  browser: Object.freeze({
    getSnapshot: (input: BrowserWorkspaceInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.getSnapshot, input),
    createTab: (input: BrowserCreateTabInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.createTab, input),
    activateTab: (input: BrowserTabTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.activateTab, input),
    closeTab: (input: BrowserTabTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.closeTab, input),
    navigate: (input: BrowserNavigateInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.navigate, input),
    back: (input: BrowserTabTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.back, input),
    forward: (input: BrowserTabTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.forward, input),
    reload: (input: BrowserTabTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.reload, input),
    stop: (input: BrowserTabTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.stop, input),
    toggleBookmark: (input: BrowserTabTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.toggleBookmark, input),
    removeBookmark: (input: BrowserBookmarkTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.removeBookmark, input),
    openBookmark: (input: BrowserOpenBookmarkInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.openBookmark, input),
    pauseDownload: (input: BrowserDownloadTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.pauseDownload, input),
    resumeDownload: (input: BrowserDownloadTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.resumeDownload, input),
    cancelDownload: (input: BrowserDownloadTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.cancelDownload, input),
    dismissDownload: (input: BrowserDownloadTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.dismissDownload, input),
    revealDownload: (input: BrowserDownloadTargetInput) =>
      invoke<BrowserSnapshot>(IPC_CHANNELS.browser.revealDownload, input),
    setBounds: (input: BrowserBoundsInput) => invoke<void>(IPC_CHANNELS.browser.setBounds, input),
    setVisible: (input: BrowserVisibilityInput) =>
      invoke<void>(IPC_CHANNELS.browser.setVisible, input),
    onStateChange: (listener: (snapshot: BrowserSnapshot) => void) =>
      subscribe(IPC_CHANNELS.browser.stateChanged, listener),
    onFocusAddressRequest: (listener: () => void) =>
      subscribe(IPC_CHANNELS.browser.focusAddressRequested, listener),
    onOpenUrlRequest: (listener: (request: BrowserOpenUrlRequest) => void) =>
      subscribe(IPC_CHANNELS.browser.openUrlRequested, listener),
  }),
  terminal: Object.freeze({
    getSnapshot: (input: TerminalWorkspaceInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.getSnapshot, input),
    create: (input: TerminalCreateInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.create, input),
    updateProfile: (input: TerminalProfilePreferenceInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.updateProfile, input),
    updateWslDistribution: (input: TerminalWslPreferenceInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.updateWslDistribution, input),
    chooseWorkingDirectory: (input: TerminalConfigurationRevisionInput) =>
      invoke<TerminalWorkingDirectorySelection>(
        IPC_CHANNELS.terminal.chooseWorkingDirectory,
        input,
      ),
    resetWorkingDirectory: (input: TerminalConfigurationRevisionInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.resetWorkingDirectory, input),
    refreshCapabilities: (input: TerminalWorkspaceInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.refreshCapabilities, input),
    activate: (input: TerminalSessionTargetInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.activate, input),
    restart: (input: TerminalSessionTargetInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.restart, input),
    write: (input: TerminalWriteInput) => invoke<void>(IPC_CHANNELS.terminal.write, input),
    resize: (input: TerminalResizeInput) => invoke<void>(IPC_CHANNELS.terminal.resize, input),
    clear: (input: TerminalSessionTargetInput) => invoke<void>(IPC_CHANNELS.terminal.clear, input),
    close: (input: TerminalSessionTargetInput) =>
      invoke<TerminalSnapshot>(IPC_CHANNELS.terminal.close, input),
    onData: (listener: (event: TerminalDataEvent) => void) =>
      subscribe(IPC_CHANNELS.terminal.data, listener),
    onExit: (listener: (event: TerminalExitEvent) => void) =>
      subscribe(IPC_CHANNELS.terminal.exit, listener),
    onStateChange: (listener: (snapshot: TerminalSnapshot) => void) =>
      subscribe(IPC_CHANNELS.terminal.stateChanged, listener),
  }),
});

contextBridge.exposeInMainWorld('workbench', workbenchApi);
