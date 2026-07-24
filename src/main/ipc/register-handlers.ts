import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  type AssistantCancelInput,
  type AssistantCredentialInput,
  type AssistantCredentialStatus,
  type AssistantSnapshot,
  type AssistantStartInput,
  IPC_CHANNELS,
  type AutomationCreateInput,
  type AutomationSetEnabledInput,
  type AutomationSnapshot,
  type AutomationTargetInput,
  type AutomationUpdateInput,
  type BackupPolicyUpdateInput,
  type DataExportResult,
  type DataImportCommitInput,
  type DataImportCommitResult,
  type DataImportSelection,
  type DataImportTargetInput,
  type DataManagementSnapshot,
  type DatabaseBackupInfo,
  type DatabaseStatus,
  type FocusSnapshot,
  type FocusStartInput,
  type FocusTargetInput,
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
  type TerminalProfilePreferenceInput,
  type TerminalResizeInput,
  type TerminalSessionTargetInput,
  type TerminalSnapshot,
  type TerminalWorkspaceInput,
  type TerminalWorkingDirectorySelection,
  type TerminalWslPreferenceInput,
  type TerminalWriteInput,
  type WindowCloseResponse,
  type WorkspaceCreateInput,
  type WorkspacePreferences,
  type WorkspacePreferencesInput,
  type WorkspaceRenameInput,
  type WorkspaceSnapshot,
  type WorkspaceTargetInput,
} from '../../shared/contracts';
import type { BrowserController } from '../browser/browser-controller';
import { isTrustedRendererUrl, type TrustedRendererLocation } from '../security/trusted-renderer';
import {
  assertNoArguments,
  parseAssistantCancelInput,
  parseAssistantCredentialInput,
  parseAssistantStartInput,
  parseAutomationCreateInput,
  parseAutomationSetEnabledInput,
  parseAutomationTargetInput,
  parseAutomationUpdateInput,
  parseBackupPolicyUpdateInput,
  parseBrowserBookmarkTargetInput,
  parseBrowserBoundsInput,
  parseBrowserCreateTabInput,
  parseBrowserDownloadTargetInput,
  parseBrowserNavigateInput,
  parseBrowserOpenBookmarkInput,
  parseBrowserTabTargetInput,
  parseBrowserVisibilityInput,
  parseBrowserWorkspaceInput,
  parseDataImportCommitInput,
  parseDataImportTargetInput,
  parseFocusStartInput,
  parseFocusTargetInput,
  parseInboxCategorizeInput,
  parseInboxCreateInput,
  parseInboxTargetInput,
  parseInboxUndoInput,
  parseNoteArchiveInput,
  parseNoteConvertInboxInput,
  parseNoteCreateInput,
  parseNoteUpdateInput,
  parseScheduleCreateInput,
  parseScheduleTargetInput,
  parseScheduleUpdateInput,
  parseSearchQueryInput,
  parseTaskConvertInboxInput,
  parseTaskCreateInput,
  parseTaskPlanningInput,
  parseTaskRenameInput,
  parseTaskStatusInput,
  parseTerminalCreateInput,
  parseTerminalConfigurationRevisionInput,
  parseTerminalProfilePreferenceInput,
  parseTerminalResizeInput,
  parseTerminalSessionTargetInput,
  parseTerminalWorkspaceInput,
  parseTerminalWslPreferenceInput,
  parseTerminalWriteInput,
  parseWindowCloseResponse,
  parseWorkspaceCreateInput,
  parseWorkspacePreferencesInput,
  parseWorkspaceRenameInput,
  parseWorkspaceTargetInput,
} from './validation';

interface IpcDependencies {
  window: BrowserWindow;
  windowLifecycle: {
    markCloseProtectionReady(): void;
    respondToCloseRequest(input: WindowCloseResponse): void;
  };
  browser: BrowserController;
  database: {
    getStatus(): Promise<DatabaseStatus>;
    createBackup(): Promise<DatabaseBackupInfo>;
    listBackups(): Promise<DatabaseBackupInfo[]>;
  };
  data: {
    getManagementSnapshot(): Promise<DataManagementSnapshot>;
    updateBackupPolicy(input: BackupPolicyUpdateInput): Promise<DataManagementSnapshot>;
    exportData(): Promise<DataExportResult>;
    chooseImport(): Promise<DataImportSelection>;
    commitImport(input: DataImportCommitInput): Promise<DataImportCommitResult>;
    cancelImport(input: DataImportTargetInput): Promise<void>;
  };
  search: {
    query(input: SearchQueryInput): Promise<SearchSnapshot>;
  };
  workspace: {
    getWorkspaceSnapshot(): Promise<WorkspaceSnapshot>;
    createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceSnapshot>;
    renameWorkspace(input: WorkspaceRenameInput): Promise<WorkspaceSnapshot>;
    activateWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot>;
    archiveWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot>;
    updateWorkspacePreferences(input: WorkspacePreferencesInput): Promise<WorkspacePreferences>;
  };
  inbox: {
    getInboxSnapshot(input: WorkspaceTargetInput): Promise<InboxSnapshot>;
    createInboxEntry(input: InboxCreateInput): Promise<InboxSnapshot>;
    categorizeInboxEntry(input: InboxCategorizeInput): Promise<InboxSnapshot>;
    archiveInboxEntry(input: InboxTargetInput): Promise<InboxArchiveResult>;
    undoInboxArchive(input: InboxUndoInput): Promise<InboxSnapshot>;
  };
  task: {
    getTaskSnapshot(input: WorkspaceTargetInput): Promise<TaskSnapshot>;
    createTask(input: TaskCreateInput): Promise<TaskSnapshot>;
    renameTask(input: TaskRenameInput): Promise<TaskSnapshot>;
    updateTaskStatus(input: TaskStatusInput): Promise<TaskSnapshot>;
    updateTaskPlanning(input: TaskPlanningInput): Promise<TaskSnapshot>;
    convertInboxToTask(input: TaskConvertInboxInput): Promise<TaskConversionResult>;
  };
  note: {
    getNoteSnapshot(input: WorkspaceTargetInput): Promise<NoteSnapshot>;
    createNote(input: NoteCreateInput): Promise<NoteSnapshot>;
    updateNote(input: NoteUpdateInput): Promise<NoteSnapshot>;
    archiveNote(input: NoteArchiveInput): Promise<NoteSnapshot>;
    convertInboxToNote(input: NoteConvertInboxInput): Promise<NoteConversionResult>;
  };
  schedule: {
    getScheduleSnapshot(input: WorkspaceTargetInput): Promise<ScheduleSnapshot>;
    createScheduleItem(input: ScheduleCreateInput): Promise<ScheduleSnapshot>;
    updateScheduleItem(input: ScheduleUpdateInput): Promise<ScheduleSnapshot>;
    archiveScheduleItem(input: ScheduleTargetInput): Promise<ScheduleSnapshot>;
  };
  focus: {
    getSnapshot(input: WorkspaceTargetInput): Promise<FocusSnapshot>;
    start(input: FocusStartInput): Promise<FocusSnapshot>;
    pause(input: FocusTargetInput): Promise<FocusSnapshot>;
    resume(input: FocusTargetInput): Promise<FocusSnapshot>;
    cancel(input: FocusTargetInput): Promise<FocusSnapshot>;
  };
  automation: {
    getSnapshot(input: WorkspaceTargetInput): Promise<AutomationSnapshot>;
    create(input: AutomationCreateInput): Promise<AutomationSnapshot>;
    update(input: AutomationUpdateInput): Promise<AutomationSnapshot>;
    setEnabled(input: AutomationSetEnabledInput): Promise<AutomationSnapshot>;
    archive(input: AutomationTargetInput): Promise<AutomationSnapshot>;
  };
  assistant: {
    getCredentialStatus(): Promise<AssistantCredentialStatus>;
    configureCredential(input: AssistantCredentialInput): Promise<AssistantCredentialStatus>;
    removeCredential(): Promise<AssistantCredentialStatus>;
    getSnapshot(): AssistantSnapshot | Promise<AssistantSnapshot>;
    start(input: AssistantStartInput): Promise<AssistantSnapshot>;
    cancel(input: AssistantCancelInput): Promise<AssistantSnapshot>;
  };
  terminal: {
    getSnapshot(input: TerminalWorkspaceInput): TerminalSnapshot | Promise<TerminalSnapshot>;
    create(input: TerminalCreateInput): TerminalSnapshot | Promise<TerminalSnapshot>;
    updateProfile(
      input: TerminalProfilePreferenceInput,
    ): TerminalSnapshot | Promise<TerminalSnapshot>;
    updateWslDistribution(
      input: TerminalWslPreferenceInput,
    ): TerminalSnapshot | Promise<TerminalSnapshot>;
    chooseWorkingDirectory(
      input: TerminalConfigurationRevisionInput,
    ): TerminalWorkingDirectorySelection | Promise<TerminalWorkingDirectorySelection>;
    resetWorkingDirectory(
      input: TerminalConfigurationRevisionInput,
    ): TerminalSnapshot | Promise<TerminalSnapshot>;
    refreshCapabilities(
      input: TerminalWorkspaceInput,
    ): TerminalSnapshot | Promise<TerminalSnapshot>;
    activate(input: TerminalSessionTargetInput): TerminalSnapshot | Promise<TerminalSnapshot>;
    restart(input: TerminalSessionTargetInput): TerminalSnapshot | Promise<TerminalSnapshot>;
    write(input: TerminalWriteInput): void | Promise<void>;
    resize(input: TerminalResizeInput): void | Promise<void>;
    clear(input: TerminalSessionTargetInput): void | Promise<void>;
    close(input: TerminalSessionTargetInput): TerminalSnapshot | Promise<TerminalSnapshot>;
  };
  trustedRendererLocation: TrustedRendererLocation;
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export function registerIpcHandlers({
  window,
  windowLifecycle,
  browser,
  database,
  data,
  search,
  workspace,
  inbox,
  task,
  note,
  schedule,
  focus,
  automation,
  assistant,
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
  register(IPC_CHANNELS.database.getManagementSnapshot, (_event, ...args) => {
    assertNoArguments(args, 'Getting data management state');
    return data.getManagementSnapshot();
  });
  register(IPC_CHANNELS.database.updateBackupPolicy, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating the backup policy');
    return data.updateBackupPolicy(parseBackupPolicyUpdateInput(input));
  });
  register(IPC_CHANNELS.database.exportData, (_event, ...args) => {
    assertNoArguments(args, 'Exporting application data');
    return data.exportData();
  });
  register(IPC_CHANNELS.database.chooseImport, (_event, ...args) => {
    assertNoArguments(args, 'Choosing application data to import');
    return data.chooseImport();
  });
  register(IPC_CHANNELS.database.commitImport, (_event, input, ...args) => {
    assertNoArguments(args, 'Committing an application data import');
    return data.commitImport(parseDataImportCommitInput(input));
  });
  register(IPC_CHANNELS.database.cancelImport, (_event, input, ...args) => {
    assertNoArguments(args, 'Cancelling an application data import');
    return data.cancelImport(parseDataImportTargetInput(input));
  });

  register(IPC_CHANNELS.search.query, (_event, input, ...args) => {
    assertNoArguments(args, 'Searching workspace data');
    return search.query(parseSearchQueryInput(input));
  });

  register(IPC_CHANNELS.workspace.getSnapshot, (_event, ...args) => {
    assertNoArguments(args, 'Getting the workspace snapshot');
    return workspace.getWorkspaceSnapshot();
  });
  register(IPC_CHANNELS.workspace.create, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating a workspace');
    return workspace.createWorkspace(parseWorkspaceCreateInput(input));
  });
  register(IPC_CHANNELS.workspace.rename, (_event, input, ...args) => {
    assertNoArguments(args, 'Renaming a workspace');
    return workspace.renameWorkspace(parseWorkspaceRenameInput(input));
  });
  register(IPC_CHANNELS.workspace.activate, (_event, input, ...args) => {
    assertNoArguments(args, 'Activating a workspace');
    return workspace.activateWorkspace(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.workspace.archive, (_event, input, ...args) => {
    assertNoArguments(args, 'Archiving a workspace');
    return workspace.archiveWorkspace(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.workspace.updatePreferences, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating workspace preferences');
    return workspace.updateWorkspacePreferences(parseWorkspacePreferencesInput(input));
  });

  register(IPC_CHANNELS.inbox.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the inbox snapshot');
    return inbox.getInboxSnapshot(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.inbox.create, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating an inbox entry');
    return inbox.createInboxEntry(parseInboxCreateInput(input));
  });
  register(IPC_CHANNELS.inbox.categorize, (_event, input, ...args) => {
    assertNoArguments(args, 'Categorizing an inbox entry');
    return inbox.categorizeInboxEntry(parseInboxCategorizeInput(input));
  });
  register(IPC_CHANNELS.inbox.archive, (_event, input, ...args) => {
    assertNoArguments(args, 'Archiving an inbox entry');
    return inbox.archiveInboxEntry(parseInboxTargetInput(input));
  });
  register(IPC_CHANNELS.inbox.undoArchive, (_event, input, ...args) => {
    assertNoArguments(args, 'Undoing an inbox archive');
    return inbox.undoInboxArchive(parseInboxUndoInput(input));
  });

  register(IPC_CHANNELS.task.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the task snapshot');
    return task.getTaskSnapshot(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.task.create, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating a task');
    return task.createTask(parseTaskCreateInput(input));
  });
  register(IPC_CHANNELS.task.rename, (_event, input, ...args) => {
    assertNoArguments(args, 'Renaming a task');
    return task.renameTask(parseTaskRenameInput(input));
  });
  register(IPC_CHANNELS.task.updateStatus, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating a task status');
    return task.updateTaskStatus(parseTaskStatusInput(input));
  });
  register(IPC_CHANNELS.task.updatePlanning, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating task planning');
    return task.updateTaskPlanning(parseTaskPlanningInput(input));
  });
  register(IPC_CHANNELS.task.convertInbox, (_event, input, ...args) => {
    assertNoArguments(args, 'Converting an inbox entry to a task');
    return task.convertInboxToTask(parseTaskConvertInboxInput(input));
  });

  register(IPC_CHANNELS.note.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the note snapshot');
    return note.getNoteSnapshot(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.note.create, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating a note');
    return note.createNote(parseNoteCreateInput(input));
  });
  register(IPC_CHANNELS.note.update, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating a note');
    return note.updateNote(parseNoteUpdateInput(input));
  });
  register(IPC_CHANNELS.note.archive, (_event, input, ...args) => {
    assertNoArguments(args, 'Archiving a note');
    return note.archiveNote(parseNoteArchiveInput(input));
  });
  register(IPC_CHANNELS.note.convertInbox, (_event, input, ...args) => {
    assertNoArguments(args, 'Converting an inbox entry to a note');
    return note.convertInboxToNote(parseNoteConvertInboxInput(input));
  });

  register(IPC_CHANNELS.schedule.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the schedule snapshot');
    return schedule.getScheduleSnapshot(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.schedule.create, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating a schedule item');
    return schedule.createScheduleItem(parseScheduleCreateInput(input));
  });
  register(IPC_CHANNELS.schedule.update, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating a schedule item');
    return schedule.updateScheduleItem(parseScheduleUpdateInput(input));
  });
  register(IPC_CHANNELS.schedule.archive, (_event, input, ...args) => {
    assertNoArguments(args, 'Archiving a schedule item');
    return schedule.archiveScheduleItem(parseScheduleTargetInput(input));
  });

  register(IPC_CHANNELS.focus.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the focus snapshot');
    return focus.getSnapshot(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.focus.start, (_event, input, ...args) => {
    assertNoArguments(args, 'Starting a focus session');
    return focus.start(parseFocusStartInput(input));
  });
  register(IPC_CHANNELS.focus.pause, (_event, input, ...args) => {
    assertNoArguments(args, 'Pausing a focus session');
    return focus.pause(parseFocusTargetInput(input));
  });
  register(IPC_CHANNELS.focus.resume, (_event, input, ...args) => {
    assertNoArguments(args, 'Resuming a focus session');
    return focus.resume(parseFocusTargetInput(input));
  });
  register(IPC_CHANNELS.focus.cancel, (_event, input, ...args) => {
    assertNoArguments(args, 'Cancelling a focus session');
    return focus.cancel(parseFocusTargetInput(input));
  });

  register(IPC_CHANNELS.automation.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the automation snapshot');
    return automation.getSnapshot(parseWorkspaceTargetInput(input));
  });
  register(IPC_CHANNELS.automation.create, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating an automation');
    return automation.create(parseAutomationCreateInput(input));
  });
  register(IPC_CHANNELS.automation.update, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating an automation');
    return automation.update(parseAutomationUpdateInput(input));
  });
  register(IPC_CHANNELS.automation.setEnabled, (_event, input, ...args) => {
    assertNoArguments(args, 'Changing an automation state');
    return automation.setEnabled(parseAutomationSetEnabledInput(input));
  });
  register(IPC_CHANNELS.automation.archive, (_event, input, ...args) => {
    assertNoArguments(args, 'Archiving an automation');
    return automation.archive(parseAutomationTargetInput(input));
  });

  register(IPC_CHANNELS.assistant.getCredentialStatus, (_event, ...args) => {
    assertNoArguments(args, 'Getting assistant credential status');
    return assistant.getCredentialStatus();
  });
  register(IPC_CHANNELS.assistant.configureCredential, (_event, input, ...args) => {
    assertNoArguments(args, 'Configuring the assistant credential');
    return assistant.configureCredential(parseAssistantCredentialInput(input));
  });
  register(IPC_CHANNELS.assistant.removeCredential, (_event, ...args) => {
    assertNoArguments(args, 'Removing the assistant credential');
    return assistant.removeCredential();
  });
  register(IPC_CHANNELS.assistant.getSnapshot, (_event, ...args) => {
    assertNoArguments(args, 'Getting assistant state');
    return assistant.getSnapshot();
  });
  register(IPC_CHANNELS.assistant.start, (_event, input, ...args) => {
    assertNoArguments(args, 'Starting the assistant');
    return assistant.start(parseAssistantStartInput(input));
  });
  register(IPC_CHANNELS.assistant.cancel, (_event, input, ...args) => {
    assertNoArguments(args, 'Cancelling the assistant');
    return assistant.cancel(parseAssistantCancelInput(input));
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
  register(IPC_CHANNELS.window.closeProtectionReady, (_event, ...args) => {
    assertNoArguments(args, 'Enabling window close protection');
    windowLifecycle.markCloseProtectionReady();
  });
  register(IPC_CHANNELS.window.respondCloseRequest, (_event, input, ...args) => {
    assertNoArguments(args, 'Responding to a window close request');
    windowLifecycle.respondToCloseRequest(parseWindowCloseResponse(input));
  });

  register(IPC_CHANNELS.browser.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the browser snapshot');
    return browser.getSnapshot(parseBrowserWorkspaceInput(input));
  });
  register(IPC_CHANNELS.browser.createTab, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating a browser tab');
    return browser.createTab(parseBrowserCreateTabInput(input));
  });
  register(IPC_CHANNELS.browser.activateTab, (_event, input, ...args) => {
    assertNoArguments(args, 'Activating a browser tab');
    return browser.activateTab(parseBrowserTabTargetInput(input));
  });
  register(IPC_CHANNELS.browser.closeTab, (_event, input, ...args) => {
    assertNoArguments(args, 'Closing a browser tab');
    return browser.closeTab(parseBrowserTabTargetInput(input));
  });
  register(IPC_CHANNELS.browser.navigate, (_event, input, ...args) => {
    assertNoArguments(args, 'Navigating a browser tab');
    return browser.navigate(parseBrowserNavigateInput(input));
  });
  register(IPC_CHANNELS.browser.back, (_event, input, ...args) => {
    assertNoArguments(args, 'Navigating a browser tab backward');
    return browser.back(parseBrowserTabTargetInput(input));
  });
  register(IPC_CHANNELS.browser.forward, (_event, input, ...args) => {
    assertNoArguments(args, 'Navigating a browser tab forward');
    return browser.forward(parseBrowserTabTargetInput(input));
  });
  register(IPC_CHANNELS.browser.reload, (_event, input, ...args) => {
    assertNoArguments(args, 'Reloading a browser tab');
    return browser.reload(parseBrowserTabTargetInput(input));
  });
  register(IPC_CHANNELS.browser.stop, (_event, input, ...args) => {
    assertNoArguments(args, 'Stopping a browser tab');
    return browser.stop(parseBrowserTabTargetInput(input));
  });
  register(IPC_CHANNELS.browser.toggleBookmark, (_event, input, ...args) => {
    assertNoArguments(args, 'Toggling a browser bookmark');
    return browser.toggleBookmark(parseBrowserTabTargetInput(input));
  });
  register(IPC_CHANNELS.browser.removeBookmark, (_event, input, ...args) => {
    assertNoArguments(args, 'Removing a browser bookmark');
    return browser.removeBookmark(parseBrowserBookmarkTargetInput(input));
  });
  register(IPC_CHANNELS.browser.openBookmark, (_event, input, ...args) => {
    assertNoArguments(args, 'Opening a browser bookmark');
    return browser.openBookmark(parseBrowserOpenBookmarkInput(input));
  });
  register(IPC_CHANNELS.browser.pauseDownload, (_event, input, ...args) => {
    assertNoArguments(args, 'Pausing a browser download');
    return browser.pauseDownload(parseBrowserDownloadTargetInput(input));
  });
  register(IPC_CHANNELS.browser.resumeDownload, (_event, input, ...args) => {
    assertNoArguments(args, 'Resuming a browser download');
    return browser.resumeDownload(parseBrowserDownloadTargetInput(input));
  });
  register(IPC_CHANNELS.browser.cancelDownload, (_event, input, ...args) => {
    assertNoArguments(args, 'Cancelling a browser download');
    return browser.cancelDownload(parseBrowserDownloadTargetInput(input));
  });
  register(IPC_CHANNELS.browser.dismissDownload, (_event, input, ...args) => {
    assertNoArguments(args, 'Dismissing a browser download');
    return browser.dismissDownload(parseBrowserDownloadTargetInput(input));
  });
  register(IPC_CHANNELS.browser.revealDownload, (_event, input, ...args) => {
    assertNoArguments(args, 'Revealing a browser download');
    return browser.revealDownload(parseBrowserDownloadTargetInput(input));
  });
  register(IPC_CHANNELS.browser.setBounds, (_event, input, ...args) => {
    assertNoArguments(args, 'Setting browser bounds');
    return browser.setBounds(parseBrowserBoundsInput(input));
  });
  register(IPC_CHANNELS.browser.setVisible, (_event, input, ...args) => {
    assertNoArguments(args, 'Setting browser visibility');
    return browser.setVisible(parseBrowserVisibilityInput(input));
  });

  register(IPC_CHANNELS.terminal.getSnapshot, (_event, input, ...args) => {
    assertNoArguments(args, 'Getting the terminal snapshot');
    return terminal.getSnapshot(parseTerminalWorkspaceInput(input));
  });
  register(IPC_CHANNELS.terminal.create, (_event, input, ...args) => {
    assertNoArguments(args, 'Creating a terminal session');
    return terminal.create(parseTerminalCreateInput(input));
  });
  register(IPC_CHANNELS.terminal.updateProfile, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating the terminal profile');
    return terminal.updateProfile(parseTerminalProfilePreferenceInput(input));
  });
  register(IPC_CHANNELS.terminal.updateWslDistribution, (_event, input, ...args) => {
    assertNoArguments(args, 'Updating the terminal WSL distribution');
    return terminal.updateWslDistribution(parseTerminalWslPreferenceInput(input));
  });
  register(IPC_CHANNELS.terminal.chooseWorkingDirectory, (_event, input, ...args) => {
    assertNoArguments(args, 'Choosing the terminal working directory');
    return terminal.chooseWorkingDirectory(parseTerminalConfigurationRevisionInput(input));
  });
  register(IPC_CHANNELS.terminal.resetWorkingDirectory, (_event, input, ...args) => {
    assertNoArguments(args, 'Resetting the terminal working directory');
    return terminal.resetWorkingDirectory(parseTerminalConfigurationRevisionInput(input));
  });
  register(IPC_CHANNELS.terminal.refreshCapabilities, (_event, input, ...args) => {
    assertNoArguments(args, 'Refreshing terminal capabilities');
    return terminal.refreshCapabilities(parseTerminalWorkspaceInput(input));
  });
  register(IPC_CHANNELS.terminal.activate, (_event, input, ...args) => {
    assertNoArguments(args, 'Activating a terminal session');
    return terminal.activate(parseTerminalSessionTargetInput(input));
  });
  register(IPC_CHANNELS.terminal.restart, (_event, input, ...args) => {
    assertNoArguments(args, 'Restarting a terminal session');
    return terminal.restart(parseTerminalSessionTargetInput(input));
  });
  register(IPC_CHANNELS.terminal.write, (_event, input, ...args) => {
    assertNoArguments(args, 'Writing to a terminal session');
    return terminal.write(parseTerminalWriteInput(input));
  });
  register(IPC_CHANNELS.terminal.resize, (_event, input, ...args) => {
    assertNoArguments(args, 'Resizing a terminal session');
    return terminal.resize(parseTerminalResizeInput(input));
  });
  register(IPC_CHANNELS.terminal.clear, (_event, input, ...args) => {
    assertNoArguments(args, 'Clearing a terminal session');
    return terminal.clear(parseTerminalSessionTargetInput(input));
  });
  register(IPC_CHANNELS.terminal.close, (_event, input, ...args) => {
    assertNoArguments(args, 'Closing a terminal session');
    return terminal.close(parseTerminalSessionTargetInput(input));
  });

  return () => {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel);
    }
  };
}
