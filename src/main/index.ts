import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, powerMonitor, safeStorage, type WebContents } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { IPC_CHANNELS, type WindowCloseReason } from '../shared/contracts';
import { isQuickCaptureShortcut } from '../shared/quick-capture-shortcut';
import {
  AssistantContextBuilder,
  AssistantController,
  OpenAIResponsesProvider,
  SafeStorageCredentialStore,
} from './assistant';
import { AutomationController } from './automations';
import { BrowserController } from './browser/browser-controller';
import {
  AtomicImportStager,
  DatabaseImportStagingDriver,
  ImportQuarantine,
  ReplacementMarkerStore,
} from './data-portability';
import {
  cleanupAbandonedImportArtifacts,
  DatabaseReplacementRecovery,
  DataManagementController,
  DataPortabilityController,
  FileReplacementMarkerPersistence,
} from './data-management';
import { DatabaseError, DatabaseService } from './database';
import { FocusController } from './focus';
import { registerIpcHandlers } from './ipc/register-handlers';
import { isAllowedBrowserUrl } from './security/browser-url';
import {
  finishApprovedCloseSurfaces,
  prepareApprovedCloseSurfaces,
  runAfterCloseApproval,
  settleShutdownsBefore,
} from './shutdown-coordinator';
import { AsyncSingleFlight, settleStartupStage } from './startup-coordinator';
import { createTrustedRendererLocation } from './security/trusted-renderer';
import { TerminalConfigurationService } from './terminal/terminal-configuration-service';
import { TerminalManager } from './terminal/terminal-manager';
import { WindowCloseCoordinator } from './window-close-coordinator';
import { createWorkspaceIpcAdapter } from './workspace-ipc-adapter';

let mainWindow: BrowserWindow | null = null;
const mainWindowCreation = new AsyncSingleFlight<boolean>();
let databaseService: DatabaseService | null = null;
let dataManagementController: DataManagementController | null = null;
let automationController: AutomationController | null = null;
let focusController: FocusController | null = null;
let assistantController: AssistantController | null = null;
let databaseShutdownPromise: Promise<void> | null = null;
let replacementPreparationPromise: Promise<void> | null = null;
let replacementRestartPromise: Promise<void> | null = null;
let allowQuit = false;
let applicationQuitRequested = false;
let startupFailureShown = false;
const runtimeShutdowns = new Set<() => Promise<void>>();
const replacementRuntimePreparations = new Set<() => Promise<void>>();
const closeApprovalRequests = new Set<(reason: WindowCloseReason) => Promise<boolean>>();
const approvedCloseSurfaces = new Set<BrowserWindow>();
let quitApprovalPromise: Promise<void> | null = null;

interface StartupRuntimeIdentity {
  readonly database: DatabaseService;
  readonly data?: DataManagementController;
  readonly automation?: AutomationController;
  readonly focus?: FocusController;
  readonly assistant?: AssistantController;
}

if (squirrelStartup) {
  app.quit();
}

function startupCanContinue(expected: StartupRuntimeIdentity): boolean {
  return (
    !applicationQuitRequested &&
    !databaseShutdownPromise &&
    !replacementPreparationPromise &&
    !replacementRestartPromise &&
    databaseService === expected.database &&
    (expected.data === undefined || dataManagementController === expected.data) &&
    (expected.automation === undefined || automationController === expected.automation) &&
    (expected.focus === undefined || focusController === expected.focus) &&
    (expected.assistant === undefined || assistantController === expected.assistant)
  );
}

async function stopDiscardedStartupRuntime(name: string, stop: () => Promise<void>): Promise<void> {
  try {
    await stop();
  } catch (error) {
    console.error(`Daily Workbench failed to stop a cancelled ${name} startup.`, error);
  }
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

async function createMainWindow(
  database: DatabaseService,
  data: DataManagementController,
  automation: AutomationController,
  focus: FocusController,
  assistant: AssistantController,
  canContinue: () => boolean = () => true,
): Promise<boolean> {
  const snapshotStage = await settleStartupStage(database.getWorkspaceSnapshot(), canContinue);
  if (snapshotStage.status === 'cancelled') return false;
  const initialWorkspaceSnapshot = snapshotStage.value;
  let rendererWorkspaceId = initialWorkspaceSnapshot.currentWorkspaceId;
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
  approvedCloseSurfaces.add(window);

  window.webContents.on('before-input-event', (event, input) => {
    if (
      isQuickCaptureShortcut({
        type: input.type,
        key: input.key,
        control: input.control,
        meta: input.meta,
        alt: input.alt,
        shift: input.shift,
        repeat: input.isAutoRepeat,
        composing: input.isComposing,
      })
    ) {
      event.preventDefault();
      sendToRenderer(IPC_CHANNELS.inbox.captureRequested, undefined);
    }
  });

  const browser = new BrowserController(window, database, {
    onStateChange: (snapshot) => {
      sendToRenderer(IPC_CHANNELS.browser.stateChanged, snapshot);
    },
    onQuickCapture: () => {
      sendToRenderer(IPC_CHANNELS.inbox.captureRequested, undefined);
    },
    onFocusAddress: () => {
      sendToRenderer(IPC_CHANNELS.browser.focusAddressRequested, undefined);
    },
  });
  const closeCoordinator = new WindowCloseCoordinator({
    sendRequest: (request) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) {
        throw new Error('The window renderer is unavailable.');
      }
      window.webContents.send(IPC_CHANNELS.window.closeRequested, request);
    },
  });
  const requestCloseApproval = (reason: WindowCloseReason): Promise<boolean> =>
    closeCoordinator.requestApproval(reason);
  closeApprovalRequests.add(requestCloseApproval);
  const terminalConfiguration = new TerminalConfigurationService({
    store: database,
    chooseWorkingDirectory: async () => {
      if (window.isDestroyed()) {
        throw new Error('The terminal window is unavailable.');
      }
      const selection = await dialog.showOpenDialog(window, {
        title: '选择终端启动目录',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      if (selection.canceled) return null;
      const selectedPath = selection.filePaths[0];
      if (!selectedPath || selection.filePaths.length !== 1) {
        throw new Error('The terminal directory selection is invalid.');
      }
      return selectedPath;
    },
  });
  const terminal = new TerminalManager({
    initialWorkspaceId: initialWorkspaceSnapshot.currentWorkspaceId,
    configurationService: terminalConfiguration,
    eventSink: {
      data: (event) => sendToRenderer(IPC_CHANNELS.terminal.data, event),
      exit: (event) => sendToRenderer(IPC_CHANNELS.terminal.exit, event),
      stateChanged: (snapshot) => sendToRenderer(IPC_CHANNELS.terminal.stateChanged, snapshot),
    },
  });
  assistant.setActiveWorkspace(initialWorkspaceSnapshot.currentWorkspaceId);
  const workspaceForIpc = createWorkspaceIpcAdapter(
    database,
    browser,
    terminal,
    (snapshot) => {
      rendererWorkspaceId = snapshot.currentWorkspaceId;
      assistant.setActiveWorkspace(snapshot.currentWorkspaceId);
    },
    (workspaceId) => {
      assistant.discardWorkspace(workspaceId);
      void focus.handleExternalChange().catch((error: unknown) => {
        console.error(
          'Daily Workbench failed to reconcile focus after a workspace archive.',
          error,
        );
      });
    },
  );
  const unregisterIpc = registerIpcHandlers({
    window,
    windowLifecycle: {
      markCloseProtectionReady: () => closeCoordinator.markReady(),
      respondToCloseRequest: (response) => closeCoordinator.respond(response),
    },
    browser,
    database,
    data,
    search: { query: (input) => database.search(input) },
    workspace: workspaceForIpc,
    inbox: database,
    task: database,
    note: database,
    schedule: database,
    focus: {
      getSnapshot: (input) => focus.getSnapshot(input),
      start: (input) => focus.startSession(input),
      pause: (input) => focus.pauseSession(input),
      resume: (input) => focus.resumeSession(input),
      cancel: (input) => focus.cancelSession(input),
    },
    automation,
    assistant,
    terminal,
    trustedRendererLocation,
  });
  let ipcHandlersRegistered = true;
  const unregisterIpcOnce = (): void => {
    if (!ipcHandlersRegistered) return;
    ipcHandlersRegistered = false;
    unregisterIpc();
  };

  const rendererSession = window.webContents.session;
  rendererSession.setPermissionCheckHandler(() => false);
  rendererSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  const requestTrustedRendererUrl = (url: string): void => {
    if (!isAllowedBrowserUrl(url)) return;
    sendToRenderer(IPC_CHANNELS.browser.openUrlRequested, {
      workspaceId: rendererWorkspaceId,
      url,
    });
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    requestTrustedRendererUrl(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    requestTrustedRendererUrl(url);
  });
  window.webContents.on('render-process-gone', () => {
    closeCoordinator.markUnavailable();
    void assistant.cancelActive();
    void shutdownTerminal().catch((error: unknown) => {
      console.error('Daily Workbench failed to stop terminals after Renderer loss.', error);
    });
  });

  window.once('ready-to-show', () => {
    if (canContinue() && mainWindow === window && !window.isDestroyed()) window.show();
  });

  let cleanedUp = false;
  let closeFlowPromise: Promise<void> | null = null;
  let browserShutdownPromise: Promise<void> | null = null;
  let terminalShutdownPromise: Promise<void> | null = null;
  const shutdownBrowser = (): Promise<void> => {
    browserShutdownPromise ??= browser.shutdown();
    return browserShutdownPromise;
  };
  const shutdownTerminal = (): Promise<void> => {
    terminalShutdownPromise ??= terminal.shutdown();
    return terminalShutdownPromise;
  };
  const cancelAssistant = (): Promise<void> => {
    return assistant.cancelActive();
  };
  runtimeShutdowns.add(shutdownBrowser);
  runtimeShutdowns.add(shutdownTerminal);
  runtimeShutdowns.add(cancelAssistant);
  const prepareReplacementRuntime = async (): Promise<void> => {
    unregisterIpcOnce();
    await Promise.all([shutdownBrowser(), shutdownTerminal(), cancelAssistant()]);
  };
  replacementRuntimePreparations.add(prepareReplacementRuntime);
  const cleanUp = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    closeCoordinator.dispose();
    closeApprovalRequests.delete(requestCloseApproval);
    approvedCloseSurfaces.delete(window);
    replacementRuntimePreparations.delete(prepareReplacementRuntime);
    unregisterIpcOnce();
    void shutdownTerminal();
    browser.destroy();
    rendererSession.setPermissionCheckHandler(null);
    rendererSession.setPermissionRequestHandler(null);
  };

  window.on('close', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (closeFlowPromise) return;
    closeFlowPromise = runAfterCloseApproval([() => requestCloseApproval('window')], async () => {
      prepareApprovedCloseSurfaces([window], (error) => {
        console.error('Daily Workbench failed to disable its window before closing.', error);
      });
      try {
        await settleShutdownsBefore(
          [shutdownBrowser, shutdownTerminal, cancelAssistant],
          async () => undefined,
          (error) => {
            console.error(
              'Daily Workbench failed to stop a native workspace runtime before closing.',
              error,
            );
          },
        );
      } finally {
        // The approved window is already disabled and hidden, so force-close it without
        // reopening a second Renderer beforeunload decision after the asynchronous flush.
        finishApprovedCloseSurfaces([window], (error) => {
          console.error('Daily Workbench failed to destroy its approved window.', error);
        });
      }
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        console.error('Daily Workbench could not complete the approved window close.', error);
      })
      .finally(() => {
        closeFlowPromise = null;
      });
  });

  window.once('closed', () => {
    runtimeShutdowns.delete(shutdownBrowser);
    runtimeShutdowns.delete(shutdownTerminal);
    runtimeShutdowns.delete(cancelAssistant);
    replacementRuntimePreparations.delete(prepareReplacementRuntime);
    closeApprovalRequests.delete(requestCloseApproval);
    approvedCloseSurfaces.delete(window);
    cleanUp();
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const loadStage = await settleStartupStage(
      window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL),
      canContinue,
    );
    return loadStage.status === 'ready';
  } else {
    const loadStage = await settleStartupStage(window.loadFile(rendererHtmlPath), canContinue);
    return loadStage.status === 'ready';
  }
}

function ensureMainWindow(
  database: DatabaseService,
  data: DataManagementController,
  automation: AutomationController,
  focus: FocusController,
  assistant: AssistantController,
  canContinue: () => boolean,
): Promise<boolean> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve(true);
  return mainWindowCreation.run(() =>
    createMainWindow(database, data, automation, focus, assistant, canContinue),
  );
}

function currentWindowForDialog(): BrowserWindow {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    throw new Error('The application window is unavailable for data management.');
  }
  return window;
}

async function requestDataReplacementApproval(): Promise<boolean> {
  if (
    databaseShutdownPromise ||
    replacementPreparationPromise ||
    replacementRestartPromise ||
    quitApprovalPromise
  ) {
    return false;
  }
  return runAfterCloseApproval(
    [...closeApprovalRequests].map((requestApproval) => () => requestApproval('data-replacement')),
    async () => undefined,
  );
}

function prepareForDataReplacement(): Promise<void> {
  if (replacementPreparationPromise) return replacementPreparationPromise;
  const activeData = dataManagementController;
  const activeAutomation = automationController;
  const activeFocus = focusController;
  const activeAssistant = assistantController;
  prepareApprovedCloseSurfaces(approvedCloseSurfaces, (error) => {
    console.error('Daily Workbench failed to hide a window before data replacement.', error);
  });

  const preparations = [
    ...replacementRuntimePreparations,
    ...(activeAssistant ? [() => activeAssistant.stop()] : []),
    ...(activeAutomation ? [() => activeAutomation.stop()] : []),
    ...(activeFocus ? [() => activeFocus.stop()] : []),
    ...(activeData ? [() => activeData.stop()] : []),
  ];
  replacementPreparationPromise = (async () => {
    const results = await Promise.allSettled(
      preparations.map((prepare) => Promise.resolve().then(prepare)),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more runtime sources could not be frozen for data replacement.',
      );
    }
  })();
  return replacementPreparationPromise;
}

function restartForDataReplacement(): Promise<void> {
  if (replacementRestartPromise) return replacementRestartPromise;
  const activeDatabase = databaseService;
  const activeData = dataManagementController;
  const activeAutomation = automationController;
  const activeFocus = focusController;
  const activeAssistant = assistantController;
  prepareApprovedCloseSurfaces(approvedCloseSurfaces, (error) => {
    console.error('Daily Workbench failed to hide a window before data replacement.', error);
  });

  replacementRestartPromise = (async () => {
    if (activeDatabase) {
      databaseShutdownPromise = settleShutdownsBefore(
        [
          ...runtimeShutdowns,
          ...(activeAssistant ? [() => activeAssistant.stop()] : []),
          ...(activeAutomation ? [() => activeAutomation.stop()] : []),
          ...(activeFocus ? [() => activeFocus.stop()] : []),
          ...(activeData ? [() => activeData.stop()] : []),
        ],
        () => activeDatabase.close(),
        (error) => {
          console.error('Daily Workbench failed to stop a runtime before data replacement.', error);
        },
      ).catch((error: unknown) => {
        console.error(
          'Daily Workbench failed to checkpoint its database before replacement.',
          error,
        );
      });
      await databaseShutdownPromise;
    }

    databaseService = null;
    dataManagementController = null;
    automationController = null;
    focusController = null;
    assistantController = null;
    allowQuit = true;
    finishApprovedCloseSurfaces(approvedCloseSurfaces, (error) => {
      console.error('Daily Workbench failed to destroy a window before restarting.', error);
    });
    try {
      app.relaunch();
    } finally {
      app.quit();
    }
  })();
  return replacementRestartPromise;
}

async function openAndCloseDatabase(dataDirectory: string): Promise<void> {
  const database = new DatabaseService({ dataDirectory });
  try {
    await database.open();
  } finally {
    await database.close();
  }
}

async function validateExistingDatabase(dataDirectory: string): Promise<void> {
  await new DatabaseService({ dataDirectory }).validateExistingFile();
}

async function validatePreImportBackup(dataDirectory: string, backupId: string): Promise<void> {
  await new DatabaseService({ dataDirectory }).validateExistingBackup(backupId, 'pre-import');
}

async function validateRecoveryDatabase(dataDirectory: string, fileName: string): Promise<void> {
  await new DatabaseService({
    dataDirectory,
    databaseFileName: fileName,
  }).validateExistingFile();
}

async function recoverDatabaseReplacement(
  dataDirectory: string,
): Promise<'none' | 'committed' | 'rolled-back'> {
  const markerStore = new ReplacementMarkerStore(
    new FileReplacementMarkerPersistence({ dataDirectory }),
  );
  const recovery = new DatabaseReplacementRecovery({
    dataDirectory,
    markerStore,
    checkpointCurrentDatabase: () => openAndCloseDatabase(dataDirectory),
    validateInstalledDatabase: () => validateExistingDatabase(dataDirectory),
    validatePreImportBackup: (backupId) => validatePreImportBackup(dataDirectory, backupId),
    validateRecoveryDatabase: (fileName) => validateRecoveryDatabase(dataDirectory, fileName),
  });
  const result = await recovery.recover();
  await cleanupAbandonedImportArtifacts(dataDirectory);
  return result.outcome;
}

async function createDataManagementController(
  database: DatabaseService,
  dataDirectory: string,
): Promise<DataManagementController> {
  const importDirectory = join(dataDirectory, 'imports');
  const markerStore = new ReplacementMarkerStore(
    new FileReplacementMarkerPersistence({ dataDirectory }),
  );
  const quarantine = new ImportQuarantine({
    directory: importDirectory,
    stager: {
      stage: async (context) => {
        const localBackupPolicy = (await database.getBackupSchedulerState()).policy;
        const stager = new AtomicImportStager({
          directory: importDirectory,
          driver: new DatabaseImportStagingDriver({ localBackupPolicy }),
        });
        await stager.stage(context);
      },
      validate: async (context) => {
        const localBackupPolicy = (await database.getBackupSchedulerState()).policy;
        const stager = new AtomicImportStager({
          directory: importDirectory,
          driver: new DatabaseImportStagingDriver({ localBackupPolicy }),
        });
        await stager.validate(context);
      },
    },
  });
  const portability = new DataPortabilityController({
    database,
    quarantine,
    markerStore,
    appVersion: app.getVersion(),
    dialogs: {
      chooseExportPath: async (defaultFileName) => {
        const result = await dialog.showSaveDialog(currentWindowForDialog(), {
          title: '导出 Daily Workbench 数据',
          defaultPath: join(app.getPath('documents'), defaultFileName),
          buttonLabel: '导出',
          filters: [{ name: 'Daily Workbench 数据包', extensions: ['dwbx'] }],
          properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
        });
        return result.canceled ? undefined : result.filePath;
      },
      chooseImportPath: async () => {
        const result = await dialog.showOpenDialog(currentWindowForDialog(), {
          title: '导入 Daily Workbench 数据',
          buttonLabel: '验证并预览',
          filters: [{ name: 'Daily Workbench 数据包', extensions: ['dwbx'] }],
          properties: ['openFile', 'dontAddToRecent'],
        });
        return result.canceled ? undefined : result.filePaths[0];
      },
    },
    requestDestructiveConfirmation: async ({ importId, previewDigest }) => {
      const result = await dialog.showMessageBox(currentWindowForDialog(), {
        type: 'warning',
        title: '确认替换本地数据',
        message: '这会用导入文件完整替换当前本地数据。',
        detail: `Daily Workbench 会先创建导入前备份，然后关闭当前工作区、替换数据库并重启。此操作不会合并两份数据。\n\n导入标识：${importId.slice(0, 8)} · ${previewDigest.slice(0, 12)}`,
        buttons: ['取消', '备份、替换并重启'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
    requestReplacementApproval: requestDataReplacementApproval,
    prepareReplacement: prepareForDataReplacement,
    scheduleRestart: restartForDataReplacement,
    onError: (error) => {
      console.error('Daily Workbench data portability failed.', error);
    },
  });
  return new DataManagementController({
    database,
    portability,
    onStateChange: (snapshot) => {
      sendToRenderer(IPC_CHANNELS.database.backupStateChanged, snapshot);
    },
    onError: (error) => {
      console.error('Daily Workbench automatic backup failed.', error);
    },
  });
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
    if (allowQuit) {
      return;
    }
    if (!databaseService) {
      applicationQuitRequested = true;
      return;
    }

    event.preventDefault();
    if (!databaseShutdownPromise && !quitApprovalPromise) {
      const activeDatabase = databaseService;
      const activeData = dataManagementController;
      const activeAutomation = automationController;
      const activeFocus = focusController;
      const activeAssistant = assistantController;
      quitApprovalPromise = runAfterCloseApproval(
        [...closeApprovalRequests].map((requestApproval) => () => requestApproval('application')),
        async () => {
          applicationQuitRequested = true;
          prepareApprovedCloseSurfaces(approvedCloseSurfaces, (error) => {
            console.error('Daily Workbench failed to disable a window before quitting.', error);
          });
          databaseShutdownPromise = settleShutdownsBefore(
            [
              ...runtimeShutdowns,
              ...(activeAssistant ? [() => activeAssistant.stop()] : []),
              ...(activeAutomation ? [() => activeAutomation.stop()] : []),
              ...(activeFocus ? [() => activeFocus.stop()] : []),
              ...(activeData ? [() => activeData.stop()] : []),
            ],
            () => activeDatabase.close(),
            (error) => {
              console.error(
                'Daily Workbench failed to stop a native workspace runtime before quitting.',
                error,
              );
            },
          )
            .catch((error: unknown) => {
              console.error('Daily Workbench failed to close its database cleanly.', error);
            })
            .finally(() => {
              databaseService = null;
              dataManagementController = null;
              automationController = null;
              focusController = null;
              assistantController = null;
              allowQuit = true;
              finishApprovedCloseSurfaces(approvedCloseSurfaces, (error) => {
                console.error('Daily Workbench failed to destroy an approved window.', error);
              });
              app.quit();
            });
          await databaseShutdownPromise;
        },
      )
        .then(() => undefined)
        .catch((error: unknown) => {
          console.error('Daily Workbench could not complete the approved application quit.', error);
        })
        .finally(() => {
          quitApprovalPromise = null;
        });
    }
  });

  void app
    .whenReady()
    .then(async () => {
      if (process.platform === 'win32') {
        app.setAppUserModelId('com.squirrel.DailyWorkbench.daily-workbench');
      }

      const dataDirectory = join(app.getPath('userData'), 'data');
      const recoveryStage = await settleStartupStage(
        recoverDatabaseReplacement(dataDirectory),
        () => !applicationQuitRequested,
      );
      if (recoveryStage.status === 'cancelled') return;
      const replacementOutcome = recoveryStage.value;
      if (replacementOutcome === 'rolled-back') {
        dialog.showErrorBox(
          'Daily Workbench restored your previous data',
          'The imported data could not be opened safely, so the original database was restored. The pre-import backup is still available in Settings.',
        );
      }
      const database = new DatabaseService({
        dataDirectory,
      });
      databaseService = database;
      const databaseStage = await settleStartupStage(database.open(), () =>
        startupCanContinue({ database }),
      );
      if (databaseStage.status === 'cancelled') return;

      const dataStage = await settleStartupStage(
        createDataManagementController(database, dataDirectory),
        () => startupCanContinue({ database }),
        (discarded) =>
          stopDiscardedStartupRuntime('data-management controller', () => discarded.stop()),
      );
      if (dataStage.status === 'cancelled') return;
      const data = dataStage.value;
      dataManagementController = data;
      const workspaceStage = await settleStartupStage(database.getWorkspaceSnapshot(), () =>
        startupCanContinue({ database, data }),
      );
      if (workspaceStage.status === 'cancelled') return;
      const workspaceSnapshot = workspaceStage.value;
      const assistant = new AssistantController({
        initialWorkspaceId: workspaceSnapshot.currentWorkspaceId,
        contextBuilder: new AssistantContextBuilder(database),
        credentialStore: new SafeStorageCredentialStore({
          directory: join(app.getPath('userData'), 'credentials'),
          safeStorage,
        }),
        provider: new OpenAIResponsesProvider(),
        onChanged: (snapshot) => {
          sendToRenderer(IPC_CHANNELS.assistant.changed, snapshot);
        },
      });
      assistantController = assistant;
      const automation = new AutomationController({
        database,
        onChanged: (event) => {
          sendToRenderer(IPC_CHANNELS.automation.changed, event);
        },
        onError: (error) => {
          console.error('Daily Workbench scheduled automation failed.', error);
        },
      });
      automationController = automation;
      const focus = new FocusController({
        database,
        onChanged: (event) => {
          sendToRenderer(IPC_CHANNELS.focus.changed, event);
        },
        onError: (error) => {
          console.error('Daily Workbench focus reconciliation failed.', error);
        },
      });
      focusController = focus;
      const runtimeIdentity = { database, data, automation, focus, assistant } as const;
      const focusStage = await settleStartupStage(
        focus.start(),
        () => startupCanContinue(runtimeIdentity),
        () => stopDiscardedStartupRuntime('focus controller', () => focus.stop()),
      );
      if (focusStage.status === 'cancelled') return;
      const automationStage = await settleStartupStage(
        automation.start(),
        () => startupCanContinue(runtimeIdentity),
        () => stopDiscardedStartupRuntime('automation controller', () => automation.stop()),
      );
      if (automationStage.status === 'cancelled') return;
      const windowCreated = await ensureMainWindow(
        database,
        data,
        automation,
        focus,
        assistant,
        () => startupCanContinue(runtimeIdentity),
      );
      if (!windowCreated || !startupCanContinue(runtimeIdentity)) return;
      const dataStartStage = await settleStartupStage(
        data.start(),
        () => startupCanContinue(runtimeIdentity),
        () => stopDiscardedStartupRuntime('data-management controller', () => data.stop()),
      );
      if (dataStartStage.status === 'cancelled') return;

      powerMonitor.on('resume', () => {
        const activeAutomation = automationController;
        if (activeAutomation && !databaseShutdownPromise) {
          void activeAutomation.evaluate().catch((error: unknown) => {
            console.error(
              'Daily Workbench failed to evaluate automations after system resume.',
              error,
            );
          });
        }
        const activeFocus = focusController;
        if (activeFocus && !databaseShutdownPromise) {
          void activeFocus.evaluate().catch((error: unknown) => {
            console.error('Daily Workbench failed to reconcile focus after system resume.', error);
          });
        }
      });

      app.on('activate', () => {
        const activeDatabase = databaseService;
        const activeAutomation = automationController;
        const activeFocus = focusController;
        const activeAssistant = assistantController;
        if (
          activeDatabase &&
          activeAutomation &&
          activeFocus &&
          activeAssistant &&
          !applicationQuitRequested &&
          !databaseShutdownPromise &&
          !replacementPreparationPromise &&
          !replacementRestartPromise &&
          BrowserWindow.getAllWindows().length === 0
        ) {
          const activeData = dataManagementController;
          if (activeData) {
            const runtimeIdentity = {
              database: activeDatabase,
              data: activeData,
              automation: activeAutomation,
              focus: activeFocus,
              assistant: activeAssistant,
            } as const;
            void ensureMainWindow(
              activeDatabase,
              activeData,
              activeAutomation,
              activeFocus,
              activeAssistant,
              () => startupCanContinue(runtimeIdentity),
            ).catch(quitAfterStartupFailure);
          }
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
