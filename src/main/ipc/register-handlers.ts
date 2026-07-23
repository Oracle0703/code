import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
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
  type TaskConversionResult,
  type TaskConvertInboxInput,
  type TaskCreateInput,
  type TaskPlanningInput,
  type TaskRenameInput,
  type TaskSnapshot,
  type TaskStatusInput,
  type WorkspaceCreateInput,
  type WorkspacePreferences,
  type WorkspacePreferencesInput,
  type WorkspaceRenameInput,
  type WorkspaceSnapshot,
  type WorkspaceTargetInput,
} from '../../shared/contracts';
import type { BrowserController } from '../browser/browser-controller';
import { isTrustedRendererUrl, type TrustedRendererLocation } from '../security/trusted-renderer';
import type { TerminalManager } from '../terminal/terminal-manager';
import {
  assertNoArguments,
  parseBoolean,
  parseBrowserBounds,
  parseBrowserUrl,
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
  parseTaskConvertInboxInput,
  parseTaskCreateInput,
  parseTaskPlanningInput,
  parseTaskRenameInput,
  parseTaskStatusInput,
  parseSessionId,
  parseTerminalCreateOptions,
  parseTerminalData,
  parseTerminalSize,
  parseWorkspaceCreateInput,
  parseWorkspacePreferencesInput,
  parseWorkspaceRenameInput,
  parseWorkspaceTargetInput,
} from './validation';

interface IpcDependencies {
  window: BrowserWindow;
  browser: BrowserController;
  database: {
    getStatus(): Promise<DatabaseStatus>;
    createBackup(): Promise<DatabaseBackupInfo>;
    listBackups(): Promise<DatabaseBackupInfo[]>;
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
  terminal: TerminalManager;
  trustedRendererLocation: TrustedRendererLocation;
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

export function registerIpcHandlers({
  window,
  browser,
  database,
  workspace,
  inbox,
  task,
  note,
  schedule,
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
