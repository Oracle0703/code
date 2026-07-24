import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AppWindow,
  Archive,
  Bot,
  CheckSquare2,
  Command,
  Download,
  FolderPlus,
  Globe2,
  Inbox,
  Layers3,
  LayoutDashboard,
  Minus,
  Moon,
  NotebookPen,
  PanelBottom,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  SquareTerminal,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_COLORS,
  type AssistantContextReference,
  type AutomationItem,
  type SearchResult,
} from '../shared/contracts';
import {
  ASSISTANT_API_KEY_MAX_LENGTH,
  ASSISTANT_API_KEY_MIN_LENGTH,
  ASSISTANT_PROMPT_MAX_LENGTH,
  ASSISTANT_SELECTED_TASK_MAX_COUNT,
} from '../shared/assistant-domain';
import { isQuickCaptureShortcut } from '../shared/quick-capture-shortcut';
import { findCurrentWorkspace } from '../shared/workspace-domain';
import { ActivityRail } from './components/ActivityRail';
import { AssistantPage } from './components/AssistantPage';
import { AutomationDialog, type AutomationDialogState } from './components/AutomationDialog';
import { AutomationPage } from './components/AutomationPage';
import { BrowserPanel } from './components/BrowserPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { DataImportDialog } from './components/DataImportDialog';
import { IconButton } from './components/IconButton';
import { InboxPage } from './components/InboxPage';
import { InboxUndoStack } from './components/InboxUndoStack';
import { NotePage } from './components/NotePage';
import { QuickCaptureDialog, type QuickCaptureTarget } from './components/QuickCaptureDialog';
import { ScheduleDialog, type ScheduleDialogState } from './components/ScheduleDialog';
import { SettingsPage, type SettingsSection } from './components/SettingsPage';
import { TaskDialog, type TaskDialogState } from './components/TaskDialog';
import { TaskPage } from './components/TaskPage';
import { TerminalPanel } from './components/TerminalPanel';
import { TodayDashboard } from './components/TodayDashboard';
import { WorkspaceDialog, type WorkspaceDialogState } from './components/WorkspaceDialog';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { useInboxController } from './hooks/useInboxController';
import { useAssistantController } from './hooks/useAssistantController';
import { useAutomationController } from './hooks/useAutomationController';
import { useDataManagementController } from './hooks/useDataManagementController';
import { useGlobalSearchController } from './hooks/useGlobalSearchController';
import { useNoteController } from './hooks/useNoteController';
import { useScheduleController } from './hooks/useScheduleController';
import { useTaskController } from './hooks/useTaskController';
import { useWorkspaceController } from './hooks/useWorkspaceController';
import { openBrowserUrlInWorkspace } from './browser-state';
import type { AppSurfaceId } from './model';
import { defaultScheduleRange } from './schedule-state';
import {
  SearchNavigationCoordinator,
  assertSearchTargetExists,
  searchNavigationError,
} from './search-navigation';
import { EMPTY_ASSISTANT_CONTEXT, assistantEntryContextForWorkspace } from './assistant-state';
import {
  evaluateWindowCloseProtection,
  shouldProtectWindowUnload,
  synchronizeDirtyDraft,
} from './window-close';

const viewLabels: Record<AppSurfaceId, string> = {
  today: '今日',
  inbox: '收件箱',
  tasks: '任务',
  notes: '笔记',
  automations: '自动化',
  assistant: 'AI 助手',
  settings: '设置',
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.matches('input, textarea, select') || target.isContentEditable)
  );
}

function isTerminalTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.xterm') !== null;
}

export function App() {
  const workspaceController = useWorkspaceController();
  const {
    state: dataState,
    load: loadData,
    createBackup,
    updateBackupPolicy,
    exportData,
    chooseImport,
    commitImport,
    cancelImport,
    currentImportPreview,
    isImportCommitInFlight,
  } = useDataManagementController();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogState | null>(null);
  const [quickCaptureTarget, setQuickCaptureTarget] = useState<QuickCaptureTarget | null>(null);
  const [taskDialog, setTaskDialog] = useState<TaskDialogState | null>(null);
  const [scheduleDialog, setScheduleDialog] = useState<ScheduleDialogState | null>(null);
  const [automationDialog, setAutomationDialog] = useState<AutomationDialogState | null>(null);
  const [noteDraftDirty, setNoteDraftDirty] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [assistantSurfaceOpen, setAssistantSurfaceOpen] = useState(false);
  const [assistantEntry, setAssistantEntry] = useState<{
    readonly workspaceId: string | null;
    readonly context: AssistantContextReference;
    readonly generation: number;
  }>({ workspaceId: null, context: EMPTY_ASSISTANT_CONTEXT, generation: 0 });
  const [requestedNoteId, setRequestedNoteId] = useState<string | null>(null);
  const [notePageGeneration, setNotePageGeneration] = useState(0);
  const [inboxReveal, setInboxReveal] = useState<{
    readonly workspaceId: string;
    readonly entryId: string;
    readonly generation: number;
    readonly handled: boolean;
  } | null>(null);
  const [searchNavigation] = useState(() => new SearchNavigationCoordinator());
  const [maximized, setMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const activeResizeFinishRef = useRef<(() => void) | null>(null);
  const currentWorkspaceIdRef = useRef<string | null>(null);
  const noteDraftDirtyRef = useRef(false);
  const dataReplacementApprovedRef = useRef(false);
  const dataReplacementNoteDiscardApprovedRef = useRef(false);
  const snapshot = workspaceController.snapshot;
  useEffect(() => {
    currentWorkspaceIdRef.current = snapshot?.currentWorkspaceId ?? null;
  }, [snapshot?.currentWorkspaceId]);
  useEffect(() => {
    const workspaceId = snapshot?.currentWorkspaceId;
    if (!workspaceId) return;
    queueMicrotask(() => {
      if (currentWorkspaceIdRef.current !== workspaceId) return;
      setAssistantEntry((current) => ({
        workspaceId,
        context: EMPTY_ASSISTANT_CONTEXT,
        generation: current.generation + 1,
      }));
    });
  }, [snapshot?.currentWorkspaceId]);
  const inboxController = useInboxController(snapshot?.currentWorkspaceId ?? null);
  const taskController = useTaskController(snapshot?.currentWorkspaceId ?? null);
  const noteController = useNoteController(snapshot?.currentWorkspaceId ?? null);
  const scheduleController = useScheduleController(snapshot?.currentWorkspaceId ?? null);
  const automationController = useAutomationController(snapshot?.currentWorkspaceId ?? null, {
    onRunOutput: ({ workspaceId, outputKind }) => {
      if (currentWorkspaceIdRef.current !== workspaceId) return;
      if (outputKind === 'task') {
        void taskController.refresh().catch(() => undefined);
      } else {
        void noteController.refresh().catch(() => undefined);
      }
    },
  });
  const assistantController = useAssistantController(snapshot?.currentWorkspaceId ?? null);
  const searchController = useGlobalSearchController({
    open: paletteOpen,
    workspaceId: snapshot?.currentWorkspaceId ?? null,
  });
  const activeWorkspace = snapshot ? findCurrentWorkspace(snapshot) : null;
  const assistantInitialContext = assistantEntryContextForWorkspace(
    snapshot?.currentWorkspaceId ?? null,
    assistantEntry.workspaceId,
    assistantEntry.context,
  );
  const visibleUndoNotices = useMemo(
    () =>
      activeWorkspace
        ? inboxController.undoNotices.filter(
            ({ workspaceId }) => workspaceId === activeWorkspace.id,
          )
        : [],
    [activeWorkspace, inboxController.undoNotices],
  );
  const preferences = snapshot?.preferences ?? DEFAULT_WORKSPACE_PREFERENCES;
  const {
    activeView,
    browserOpen,
    browserWidth,
    sidebarCollapsed,
    terminalHeight,
    terminalOpen,
    theme,
  } = preferences;
  const activeSurface: AppSurfaceId = assistantSurfaceOpen ? 'assistant' : activeView;
  const overlayOpen =
    paletteOpen ||
    workspaceDialog !== null ||
    quickCaptureTarget !== null ||
    taskDialog !== null ||
    scheduleDialog !== null ||
    automationDialog !== null ||
    dataState.importPreview !== null;
  const terminalMaximum = Math.min(2160, Math.max(180, viewportHeight - 180));
  const effectiveTerminalHeight = clamp(terminalHeight, 180, terminalMaximum);

  const updateNoteDraftDirty = useCallback(
    (dirty: boolean) => synchronizeDirtyDraft(noteDraftDirtyRef, setNoteDraftDirty, dirty),
    [],
  );
  const handleRequestedInboxEntry = useCallback(() => {
    const expectedGeneration = inboxReveal?.generation;
    if (expectedGeneration === undefined) return;
    setInboxReveal((current) =>
      current?.generation === expectedGeneration && !current.handled
        ? { ...current, handled: true }
        : current,
    );
  }, [inboxReveal?.generation]);

  const updatePreferences = workspaceController.updatePreferences;
  const openUrlInWorkspace = useCallback(
    (workspaceId: string, url: string) => {
      if (currentWorkspaceIdRef.current !== workspaceId) return;
      updatePreferences({ browserOpen: true }, true, workspaceId);
      void openBrowserUrlInWorkspace(
        window.workbench.browser,
        workspaceId,
        url,
        () => currentWorkspaceIdRef.current === workspaceId,
      ).catch(() => undefined);
    },
    [updatePreferences],
  );
  const confirmLeaveNoteDraft = useCallback(
    () =>
      !noteDraftDirtyRef.current ||
      window.confirm('当前笔记有尚未保存的更改。要放弃这些更改并继续吗？'),
    [],
  );
  const requestActiveView = useCallback(
    (view: AppSurfaceId) => {
      if (view === activeSurface || !confirmLeaveNoteDraft()) return;
      if (view === 'assistant') {
        setAssistantSurfaceOpen(true);
      } else {
        setAssistantSurfaceOpen(false);
      }
      if (view !== 'assistant' && view !== activeView) {
        updatePreferences({ activeView: view });
      }
    },
    [activeSurface, activeView, confirmLeaveNoteDraft, updatePreferences],
  );
  const openAssistant = useCallback(
    (context: AssistantContextReference) => {
      if (!activeWorkspace || !confirmLeaveNoteDraft()) return;
      setAssistantEntry((current) => ({
        workspaceId: activeWorkspace.id,
        context,
        generation: current.generation + 1,
      }));
      setAssistantSurfaceOpen(true);
    },
    [activeWorkspace, confirmLeaveNoteDraft],
  );
  const openTerminalSettings = useCallback(() => {
    setSettingsSection('terminal');
    requestActiveView('settings');
  }, [requestActiveView]);
  const openAssistantSettings = useCallback(() => {
    setSettingsSection('assistant');
    requestActiveView('settings');
  }, [requestActiveView]);
  const requestWorkspaceActivation = useCallback(
    (workspaceId: string) => {
      if (!confirmLeaveNoteDraft()) return;
      searchNavigation.invalidate();
      void workspaceController.activate(workspaceId).catch(() => undefined);
    },
    [confirmLeaveNoteDraft, searchNavigation, workspaceController],
  );
  const openQuickCapture = useCallback(() => {
    if (
      !activeWorkspace ||
      workspaceDialog !== null ||
      taskDialog !== null ||
      scheduleDialog !== null ||
      automationDialog !== null ||
      dataState.importPreview !== null ||
      workspaceController.pendingOperation !== null
    ) {
      return;
    }
    setPaletteOpen(false);
    setQuickCaptureTarget(
      (current) =>
        current ?? { workspaceId: activeWorkspace.id, workspaceName: activeWorkspace.name },
    );
  }, [
    activeWorkspace,
    automationDialog,
    scheduleDialog,
    dataState.importPreview,
    taskDialog,
    workspaceController.pendingOperation,
    workspaceDialog,
  ]);

  const openTaskCreate = useCallback(
    (planning: 'today' | 'none') => {
      if (
        !activeWorkspace ||
        workspaceDialog !== null ||
        quickCaptureTarget !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null
      ) {
        return;
      }
      setPaletteOpen(false);
      setTaskDialog({
        mode: 'create',
        workspaceId: activeWorkspace.id,
        workspaceName: activeWorkspace.name,
        planning,
      });
    },
    [
      activeWorkspace,
      automationDialog,
      quickCaptureTarget,
      scheduleDialog,
      dataState.importPreview,
      workspaceController.pendingOperation,
      workspaceDialog,
    ],
  );

  const openScheduleCreate = useCallback(() => {
    if (
      !activeWorkspace ||
      !scheduleController.snapshot ||
      workspaceDialog !== null ||
      quickCaptureTarget !== null ||
      taskDialog !== null ||
      scheduleDialog !== null ||
      automationDialog !== null ||
      dataState.importPreview !== null ||
      workspaceController.pendingOperation !== null
    ) {
      return;
    }
    const defaults = defaultScheduleRange(new Date());
    setPaletteOpen(false);
    setScheduleDialog({
      mode: 'create',
      workspaceId: activeWorkspace.id,
      workspaceName: activeWorkspace.name,
      expectedDate: scheduleController.snapshot.todayDate,
      startMinute: defaults.startMinute,
      endMinute: defaults.endMinute,
    });
  }, [
    activeWorkspace,
    automationDialog,
    quickCaptureTarget,
    scheduleController.snapshot,
    scheduleDialog,
    dataState.importPreview,
    taskDialog,
    workspaceController.pendingOperation,
    workspaceDialog,
  ]);

  const openAutomationCreate = useCallback(() => {
    if (
      !activeWorkspace ||
      workspaceDialog !== null ||
      quickCaptureTarget !== null ||
      taskDialog !== null ||
      scheduleDialog !== null ||
      automationDialog !== null ||
      dataState.importPreview !== null ||
      workspaceController.pendingOperation !== null
    ) {
      return;
    }
    setPaletteOpen(false);
    setAutomationDialog({
      mode: 'create',
      workspaceId: activeWorkspace.id,
      workspaceName: activeWorkspace.name,
    });
  }, [
    activeWorkspace,
    automationDialog,
    dataState.importPreview,
    quickCaptureTarget,
    scheduleDialog,
    taskDialog,
    workspaceController.pendingOperation,
    workspaceDialog,
  ]);

  const openAutomationEdit = useCallback(
    (item: AutomationItem) => {
      if (
        !activeWorkspace ||
        workspaceDialog !== null ||
        quickCaptureTarget !== null ||
        taskDialog !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null
      ) {
        return;
      }
      setPaletteOpen(false);
      setAutomationDialog({
        mode: 'edit',
        workspaceId: activeWorkspace.id,
        workspaceName: activeWorkspace.name,
        item,
      });
    },
    [
      activeWorkspace,
      automationDialog,
      dataState.importPreview,
      quickCaptureTarget,
      scheduleDialog,
      taskDialog,
      workspaceController.pendingOperation,
      workspaceDialog,
    ],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    void window.workbench?.app
      .getVersion()
      .then(setAppVersion)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (activeSurface === 'settings') void loadData();
  }, [activeSurface, loadData]);

  useEffect(() => window.workbench.inbox.onCaptureRequest(openQuickCapture), [openQuickCapture]);

  useEffect(
    () =>
      window.workbench.browser.onOpenUrlRequest(({ workspaceId, url }) => {
        openUrlInWorkspace(workspaceId, url);
      }),
    [openUrlInWorkspace],
  );

  useEffect(
    () =>
      window.workbench.window.onCloseRequest(async (request) => {
        const importPreview = currentImportPreview();
        const decision = evaluateWindowCloseProtection(
          {
            reason: request.reason,
            hasUnsavedDraft: noteDraftDirtyRef.current,
            noteDiscardPreviouslyApproved: dataReplacementNoteDiscardApprovedRef.current,
            dataReplacementApproved: dataReplacementApprovedRef.current,
            importPreviewOpen: importPreview !== null,
            importCommitInFlight: isImportCommitInFlight(),
          },
          () => window.confirm('当前笔记有尚未保存的更改。要放弃这些更改并继续吗？'),
          () =>
            window.confirm(
              '导入预览尚未关闭。退出会安全取消本次导入，且不会修改本地数据。要继续吗？',
            ),
        );
        if (decision === 'reject') return false;
        if (decision === 'approve') return true;
        try {
          await cancelImport();
          return currentImportPreview() === null;
        } catch {
          return false;
        }
      }),
    [cancelImport, currentImportPreview, isImportCommitInFlight],
  );

  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (
        !shouldProtectWindowUnload(noteDraftDirtyRef.current || currentImportPreview() !== null)
      ) {
        return;
      }
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [currentImportPreview]);

  useEffect(() => {
    const updateViewport = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  useEffect(
    () => () => {
      activeResizeFinishRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!snapshot) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        workspaceDialog !== null ||
        taskDialog !== null ||
        scheduleDialog !== null ||
        automationDialog !== null ||
        dataState.importPreview !== null ||
        workspaceController.pendingOperation !== null
      ) {
        return;
      }
      const commandKey = event.ctrlKey || event.metaKey;
      if (
        isQuickCaptureShortcut({
          type: 'keyDown',
          key: event.key,
          control: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
          repeat: event.repeat,
          composing: event.isComposing,
        })
      ) {
        event.preventDefault();
        if (!quickCaptureTarget) openQuickCapture();
        return;
      }
      if (event.defaultPrevented || event.isComposing) return;
      if (quickCaptureTarget) return;
      if (commandKey && event.key.toLowerCase() === 'k' && !isTerminalTarget(event.target)) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (!commandKey) {
        if (event.key === 'Escape' && paletteOpen) setPaletteOpen(false);
        return;
      }

      if (paletteOpen && event.key.toLowerCase() !== 'k') return;

      if (event.key.toLowerCase() === 'b' && event.shiftKey) {
        event.preventDefault();
        updatePreferences({ browserOpen: !browserOpen });
      } else if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        updatePreferences({ sidebarCollapsed: !sidebarCollapsed });
      } else if (event.key.toLowerCase() === 'j' || event.code === 'Backquote') {
        event.preventDefault();
        updatePreferences({ terminalOpen: !terminalOpen });
      } else if (event.key === ',') {
        event.preventDefault();
        requestActiveView('settings');
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [
    browserOpen,
    automationDialog,
    dataState.importPreview,
    paletteOpen,
    quickCaptureTarget,
    sidebarCollapsed,
    snapshot,
    terminalOpen,
    updatePreferences,
    openQuickCapture,
    workspaceController.pendingOperation,
    workspaceDialog,
    taskDialog,
    scheduleDialog,
    requestActiveView,
  ]);

  const selectSearchResult = useCallback(
    async (selectedResult: SearchResult): Promise<void> => {
      if (!confirmLeaveNoteDraft()) {
        throw new Error('已取消打开搜索结果；当前笔记仍保留未保存的更改。');
      }
      const discardConfirmedNoteDraft = noteDraftDirtyRef.current;
      const intent = searchNavigation.begin(selectedResult);
      if (workspaceController.pendingOperation !== null) {
        throw new Error('工作区操作正在进行，请稍候再打开搜索结果。');
      }

      const { result } = intent;
      const assertCurrent = () => searchNavigation.assertCurrent(intent);
      const finishNavigation = () => {
        if (discardConfirmedNoteDraft) {
          setNotePageGeneration((generation) => generation + 1);
        }
      };
      try {
        if (currentWorkspaceIdRef.current !== result.workspaceId) {
          await workspaceController.activate(result.workspaceId);
          assertCurrent();
        }

        switch (result.kind) {
          case 'inbox': {
            const inboxSnapshot = await window.workbench.inbox.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              inboxSnapshot.entries.some(({ id }) => id === result.entityId),
            );
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'inbox' }, true, result.workspaceId);
            setRequestedNoteId(null);
            setInboxReveal({
              workspaceId: result.workspaceId,
              entryId: result.entityId,
              generation: intent.generation,
              handled: false,
            });
            return;
          }
          case 'task': {
            const taskSnapshot = await window.workbench.task.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            const task = taskSnapshot.tasks.find(({ id }) => id === result.entityId);
            assertSearchTargetExists(intent, task !== undefined);
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'tasks' }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
            setTaskDialog({
              mode: 'rename',
              workspaceId: result.workspaceId,
              workspaceName: result.workspaceName,
              task,
            });
            return;
          }
          case 'note': {
            const noteSnapshot = await window.workbench.note.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              noteSnapshot.notes.some(({ id }) => id === result.entityId),
            );
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'notes' }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(result.entityId);
            return;
          }
          case 'schedule': {
            const scheduleSnapshot = await window.workbench.schedule.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            const item = scheduleSnapshot.items.find(({ id }) => id === result.entityId);
            assertSearchTargetExists(intent, item !== undefined);
            finishNavigation();
            setAssistantSurfaceOpen(false);
            updatePreferences({ activeView: 'today' }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
            setScheduleDialog({
              mode: 'edit',
              workspaceId: result.workspaceId,
              workspaceName: result.workspaceName,
              expectedDate: scheduleSnapshot.todayDate,
              item,
            });
            return;
          }
          case 'browser-tab': {
            const browserSnapshot = await window.workbench.browser.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              browserSnapshot.tabs.some(({ id }) => id === result.entityId),
            );
            const activated = await window.workbench.browser.activateTab({
              workspaceId: result.workspaceId,
              tabId: result.entityId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              activated.activeTabId === result.entityId &&
                activated.tabs.some(({ id }) => id === result.entityId),
            );
            finishNavigation();
            updatePreferences({ browserOpen: true }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
            return;
          }
          case 'browser-bookmark': {
            const browserSnapshot = await window.workbench.browser.getSnapshot({
              workspaceId: result.workspaceId,
            });
            assertCurrent();
            assertSearchTargetExists(
              intent,
              browserSnapshot.bookmarks.some(({ id }) => id === result.entityId),
            );
            await window.workbench.browser.openBookmark({
              workspaceId: result.workspaceId,
              bookmarkId: result.entityId,
              newTab: false,
            });
            assertCurrent();
            finishNavigation();
            updatePreferences({ browserOpen: true }, true, result.workspaceId);
            setInboxReveal(null);
            setRequestedNoteId(null);
          }
        }
      } catch (error) {
        throw searchNavigationError(error);
      }
    },
    [confirmLeaveNoteDraft, searchNavigation, updatePreferences, workspaceController],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    if (!snapshot || !activeWorkspace) return [];
    const dataBusy = dataState.activeOperation !== null;
    const dataDisabled = dataBusy || dataState.importPreview !== null;
    const dataDisabledReason = dataBusy
      ? '另一项数据操作正在进行'
      : dataState.importPreview
        ? '请先处理当前导入预览'
        : undefined;
    const workspaceCommands: PaletteCommand[] = snapshot.workspaces
      .filter(({ id }) => id !== activeWorkspace.id)
      .map((workspace) => ({
        id: `workspace:activate:${workspace.id}`,
        label: `切换到 ${workspace.name}`,
        description: '恢复该工作区的页面与面板布局',
        group: '工作区',
        icon: Layers3,
        keywords: `工作区 切换 ${workspace.name}`,
        action: () => {
          requestWorkspaceActivation(workspace.id);
        },
      }));

    return [
      {
        id: 'capture',
        label: '快速记录',
        description: '把一个想法或任务加入收件箱',
        group: '操作',
        icon: Plus,
        shortcut: 'Ctrl N',
        keywords: '新建 添加 任务 笔记',
        action: () => {
          openQuickCapture();
        },
      },
      {
        id: 'task:create',
        label: '新建任务',
        description: '创建一项真实任务，稍后安排时间',
        group: '操作',
        icon: CheckSquare2,
        keywords: '任务 新建 创建 todo',
        action: () => openTaskCreate('none'),
      },
      {
        id: 'automation:create',
        label: '新建自动化',
        description: '按每日或每周计划创建任务或笔记',
        group: '操作',
        icon: Bot,
        keywords: '自动化 定时 每日 每周 任务 笔记',
        action: openAutomationCreate,
      },
      {
        id: 'data:backup',
        label: '立即备份数据',
        description: '创建一份一致性的本地 SQLite 备份',
        group: '数据',
        icon: Archive,
        keywords: '数据 备份 backup sqlite',
        disabled: dataDisabled,
        disabledReason: dataDisabledReason,
        action: createBackup,
      },
      {
        id: 'data:export',
        label: '导出数据',
        description: '保存经过校验的可移植数据文件',
        group: '数据',
        icon: Download,
        keywords: '数据 导出 export portable',
        disabled: dataDisabled,
        disabledReason: dataDisabledReason,
        action: exportData,
      },
      {
        id: 'data:import',
        label: '导入数据',
        description: '选择文件并在替换前查看完整预览',
        group: '数据',
        icon: Upload,
        keywords: '数据 导入 import restore',
        disabled: dataDisabled,
        disabledReason: dataDisabledReason,
        restoreFocus: false,
        action: chooseImport,
      },
      {
        id: 'workspace:create',
        label: '新建工作区',
        description: '创建一个独立的本地布局',
        group: '工作区',
        icon: FolderPlus,
        keywords: '工作区 新建 创建',
        action: () => {
          if (!confirmLeaveNoteDraft()) return;
          setWorkspaceDialog({
            mode: 'create',
            suggestedColor: WORKSPACE_COLORS[snapshot.workspaces.length % WORKSPACE_COLORS.length],
          });
        },
      },
      {
        id: 'workspace:rename',
        label: '重命名当前工作区',
        description: activeWorkspace.name,
        group: '工作区',
        icon: Pencil,
        action: () => setWorkspaceDialog({ mode: 'rename', workspace: activeWorkspace }),
      },
      ...workspaceCommands,
      ...(snapshot.workspaces.length > 1
        ? [
            {
              id: 'workspace:archive',
              label: '归档当前工作区',
              description: '保留数据并从活动列表隐藏',
              group: '工作区',
              icon: Archive,
              action: () => {
                if (!confirmLeaveNoteDraft()) return;
                setWorkspaceDialog({
                  mode: 'archive',
                  workspace: activeWorkspace,
                  switchesWorkspace: true,
                });
              },
            } satisfies PaletteCommand,
          ]
        : []),
      {
        id: 'toggle-browser',
        label: browserOpen ? '关闭右侧浏览器' : '打开右侧浏览器',
        description: '显示内置浏览器',
        group: '工具',
        icon: Globe2,
        shortcut: 'Ctrl ⇧ B',
        keywords: '网页 web panel',
        action: () => updatePreferences({ browserOpen: !browserOpen }),
      },
      {
        id: 'toggle-terminal',
        label: terminalOpen ? '关闭集成终端' : '打开集成终端',
        description: '显示集成 Shell',
        group: '工具',
        icon: SquareTerminal,
        shortcut: 'Ctrl J',
        keywords: '命令行 shell powershell',
        action: () => updatePreferences({ terminalOpen: !terminalOpen }),
      },
      {
        id: 'terminal:settings',
        label: '配置集成终端',
        description: '选择当前工作区的 Profile、启动目录与 WSL 发行版',
        group: '工具',
        icon: Settings2,
        keywords: '终端 profile shell cwd wsl 工作目录',
        action: openTerminalSettings,
      },
      {
        id: 'go-assistant',
        label: '打开 AI 助手',
        description: '选择上下文后手动发送问题',
        group: '页面',
        icon: Sparkles,
        keywords: 'AI OpenAI 助手 问答',
        action: () => requestActiveView('assistant'),
      },
      {
        id: 'go-today',
        label: '前往今日',
        group: '页面',
        icon: LayoutDashboard,
        action: () => requestActiveView('today'),
      },
      {
        id: 'go-inbox',
        label: '前往收件箱',
        group: '页面',
        icon: Inbox,
        action: () => requestActiveView('inbox'),
      },
      {
        id: 'go-tasks',
        label: '前往任务',
        group: '页面',
        icon: CheckSquare2,
        action: () => requestActiveView('tasks'),
      },
      {
        id: 'go-notes',
        label: '前往笔记',
        group: '页面',
        icon: NotebookPen,
        action: () => requestActiveView('notes'),
      },
      {
        id: 'go-automations',
        label: '前往自动化',
        group: '页面',
        icon: Bot,
        action: () => requestActiveView('automations'),
      },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? '切换为浅色主题' : '切换为深色主题',
        group: '设置',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: '外观 颜色 dark light',
        action: () => updatePreferences({ theme: theme === 'dark' ? 'light' : 'dark' }),
      },
      {
        id: 'open-settings',
        label: '打开设置',
        group: '设置',
        icon: Settings2,
        shortcut: 'Ctrl ,',
        action: () => requestActiveView('settings'),
      },
    ];
  }, [
    activeWorkspace,
    browserOpen,
    chooseImport,
    createBackup,
    dataState.activeOperation,
    dataState.importPreview,
    exportData,
    openAutomationCreate,
    openQuickCapture,
    openTerminalSettings,
    openTaskCreate,
    confirmLeaveNoteDraft,
    requestActiveView,
    requestWorkspaceActivation,
    snapshot,
    terminalOpen,
    theme,
    updatePreferences,
  ]);

  const beginBrowserResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!snapshot) return;
    event.preventDefault();
    activeResizeFinishRef.current?.();
    const workspaceId = snapshot.currentWorkspaceId;
    const pointerId = event.pointerId;
    const resizeHandle = event.currentTarget;
    resizeHandle.setPointerCapture(pointerId);
    const startX = event.clientX;
    const startWidth = browserWidth;
    let latestWidth = startWidth;
    document.body.classList.add('is-resizing-horizontal');
    let finished = false;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const maximum = Math.min(720, window.innerWidth - 560);
      latestWidth = clamp(startWidth + startX - moveEvent.clientX, 340, Math.max(340, maximum));
      updatePreferences({ browserWidth: latestWidth }, false, workspaceId);
    };
    const cleanup = () => {
      document.body.classList.remove('is-resizing-horizontal');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      if (activeResizeFinishRef.current === finish) activeResizeFinishRef.current = null;
    };
    const finish = (finishEvent?: Event) => {
      if (finishEvent instanceof PointerEvent && finishEvent.pointerId !== pointerId) return;
      if (finished) return;
      finished = true;
      cleanup();
      updatePreferences({ browserWidth: latestWidth }, true, workspaceId);
    };
    activeResizeFinishRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };

  const beginTerminalResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!snapshot) return;
    event.preventDefault();
    activeResizeFinishRef.current?.();
    const workspaceId = snapshot.currentWorkspaceId;
    const pointerId = event.pointerId;
    const resizeHandle = event.currentTarget;
    resizeHandle.setPointerCapture(pointerId);
    const startY = event.clientY;
    const startHeight = effectiveTerminalHeight;
    let latestHeight = startHeight;
    document.body.classList.add('is-resizing-vertical');
    let finished = false;

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const maximum = Math.min(2160, Math.max(180, window.innerHeight - 180));
      latestHeight = clamp(startHeight + startY - moveEvent.clientY, 180, maximum);
      updatePreferences({ terminalHeight: latestHeight }, false, workspaceId);
    };
    const cleanup = () => {
      document.body.classList.remove('is-resizing-vertical');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      if (resizeHandle.hasPointerCapture(pointerId)) resizeHandle.releasePointerCapture(pointerId);
      if (activeResizeFinishRef.current === finish) activeResizeFinishRef.current = null;
    };
    const finish = (finishEvent?: Event) => {
      if (finishEvent instanceof PointerEvent && finishEvent.pointerId !== pointerId) return;
      if (finished) return;
      finished = true;
      cleanup();
      updatePreferences({ terminalHeight: latestHeight }, true, workspaceId);
    };
    activeResizeFinishRef.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  };

  const toggleWindowMaximize = () => {
    void window.workbench?.window
      .toggleMaximize()
      .then(setMaximized)
      .catch(() => undefined);
  };

  if (!snapshot || !activeWorkspace) {
    return (
      <StartupShell
        status={workspaceController.status}
        error={workspaceController.loadError}
        canRetry={workspaceController.canRetry}
        onRetry={workspaceController.retry}
        maximized={maximized}
        onToggleMaximize={toggleWindowMaximize}
      />
    );
  }

  return (
    <div className="app-shell">
      <header
        className="titlebar"
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest('button')) toggleWindowMaximize();
        }}
      >
        <div className="titlebar__identity">
          <span className="titlebar__logo">
            <Sparkles size={15} />
          </span>
          <strong>Daily Workbench</strong>
          <span className="titlebar__separator" />
          <span>{activeWorkspace.name}</span>
        </div>

        <button type="button" className="titlebar-command" onClick={() => setPaletteOpen(true)}>
          <Search size={14} aria-hidden="true" />
          <span>搜索或运行命令</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="titlebar__tools">
          <IconButton
            label={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}
            active={!sidebarCollapsed}
            onClick={() => updatePreferences({ sidebarCollapsed: !sidebarCollapsed })}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
          <IconButton
            label="内置浏览器"
            active={browserOpen}
            onClick={() => updatePreferences({ browserOpen: !browserOpen })}
          >
            <PanelRight size={16} />
          </IconButton>
          <IconButton
            label="集成终端"
            active={terminalOpen}
            onClick={() => updatePreferences({ terminalOpen: !terminalOpen })}
          >
            <PanelBottom size={16} />
          </IconButton>
          <IconButton
            label={theme === 'dark' ? '使用浅色主题' : '使用深色主题'}
            onClick={() => updatePreferences({ theme: theme === 'dark' ? 'light' : 'dark' })}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </IconButton>
        </div>

        <WindowControls
          maximized={maximized}
          onToggleMaximize={toggleWindowMaximize}
          onClose={() => void window.workbench?.window.close()}
        />
      </header>

      <div className="workbench-shell">
        <ActivityRail
          activeView={activeSurface}
          inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
          taskCount={taskController.counts?.active ?? null}
          todayCount={taskController.counts?.today ?? null}
          onSelect={requestActiveView}
        />
        <div
          className={`sidebar-slot ${sidebarCollapsed ? 'is-collapsed' : ''}`}
          aria-hidden={sidebarCollapsed}
          inert={sidebarCollapsed}
        >
          <WorkspaceSidebar
            activeView={activeSurface}
            activeWorkspace={activeWorkspace}
            workspaces={snapshot.workspaces}
            busy={workspaceController.pendingOperation !== null}
            pendingWorkspaceId={workspaceController.pendingWorkspaceId}
            saveError={workspaceController.saveError}
            saveStatus={workspaceController.saveStatus}
            inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
            taskCount={taskController.counts?.active ?? null}
            todayCount={taskController.counts?.today ?? null}
            onRetrySave={workspaceController.retryPreferences}
            onSelectView={requestActiveView}
            onSelectWorkspace={requestWorkspaceActivation}
            onCreateWorkspace={() => {
              if (!confirmLeaveNoteDraft()) return;
              setWorkspaceDialog({
                mode: 'create',
                suggestedColor:
                  WORKSPACE_COLORS[snapshot.workspaces.length % WORKSPACE_COLORS.length],
              });
            }}
            onRenameWorkspace={(workspace) => setWorkspaceDialog({ mode: 'rename', workspace })}
            onArchiveWorkspace={(workspace) => {
              if (!confirmLeaveNoteDraft()) return;
              setWorkspaceDialog({
                mode: 'archive',
                workspace,
                switchesWorkspace: workspace.id === snapshot.currentWorkspaceId,
              });
            }}
          />
        </div>

        <div className="content-shell">
          <div className="horizontal-workspace">
            <main className="page-region" id="main-content">
              <div className="page-chrome">
                <div className="breadcrumbs">
                  <AppWindow size={14} />
                  <span>{activeWorkspace.name}</span>
                  <i>/</i>
                  <strong>{viewLabels[activeSurface]}</strong>
                </div>
                <div className="page-chrome__actions">
                  <IconButton label="打开命令中心" onClick={() => setPaletteOpen(true)}>
                    <Command size={15} />
                  </IconButton>
                  {!browserOpen ? (
                    <button
                      type="button"
                      className="subtle-action"
                      onClick={() => updatePreferences({ browserOpen: true })}
                    >
                      <Globe2 size={14} /> 浏览器
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="page-scroll">
                {activeSurface === 'today' ? (
                  <TodayDashboard
                    key={snapshot.currentWorkspaceId}
                    inboxStatus={inboxController.status}
                    inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
                    uncategorizedCount={
                      inboxController.snapshot ? inboxController.counts.uncategorized : null
                    }
                    capturePending={inboxController.pendingCapture}
                    taskSnapshot={taskController.snapshot}
                    taskStatus={taskController.status}
                    taskLoadError={taskController.loadError}
                    taskOperationError={taskController.operationError}
                    pendingTaskIds={taskController.pendingTaskIds}
                    taskCreatePending={taskController.pendingCreate}
                    onCapture={(content) =>
                      inboxController.create(snapshot.currentWorkspaceId, content, 'uncategorized')
                    }
                    scheduleSnapshot={scheduleController.snapshot}
                    scheduleItems={scheduleController.items}
                    scheduleStatus={scheduleController.status}
                    scheduleLoadError={scheduleController.loadError}
                    scheduleOperationError={scheduleController.operationError}
                    pendingScheduleItemIds={scheduleController.pendingItemIds}
                    scheduleCreatePending={scheduleController.pendingCreate}
                    onOpenInbox={() => requestActiveView('inbox')}
                    onOpenTasks={() => requestActiveView('tasks')}
                    onCreateToday={() => openTaskCreate('today')}
                    onOpenTask={(task) =>
                      setTaskDialog({
                        mode: 'rename',
                        workspaceId: snapshot.currentWorkspaceId,
                        workspaceName: activeWorkspace.name,
                        task,
                      })
                    }
                    onUpdateTaskStatus={taskController.updateStatus}
                    onRetrySchedule={scheduleController.retry}
                    onCreateSchedule={openScheduleCreate}
                    onOpenSchedule={(item) =>
                      setScheduleDialog({
                        mode: 'edit',
                        workspaceId: snapshot.currentWorkspaceId,
                        workspaceName: activeWorkspace.name,
                        expectedDate: scheduleController.snapshot?.todayDate ?? item.scheduledFor,
                        item,
                      })
                    }
                    onOpenAssistant={() => openAssistant({ kind: 'today' })}
                  />
                ) : activeSurface === 'inbox' ? (
                  <InboxPage
                    key={
                      inboxReveal?.workspaceId === snapshot.currentWorkspaceId
                        ? `${snapshot.currentWorkspaceId}:${inboxReveal.generation}`
                        : snapshot.currentWorkspaceId
                    }
                    entries={inboxController.entries}
                    status={inboxController.status}
                    loadError={inboxController.loadError}
                    operationError={inboxController.operationError}
                    pendingEntryIds={inboxController.pendingEntryIds}
                    pendingConversionEntryIds={taskController.pendingConversionEntryIds}
                    pendingNoteConversionEntryIds={noteController.pendingConversionEntryIds}
                    requestedEntryId={
                      inboxReveal?.workspaceId === snapshot.currentWorkspaceId &&
                      !inboxReveal.handled
                        ? inboxReveal.entryId
                        : null
                    }
                    onRequestedEntryHandled={handleRequestedInboxEntry}
                    onRetry={inboxController.retry}
                    onOpenCapture={openQuickCapture}
                    onCategorize={inboxController.categorize}
                    onArchive={inboxController.archive}
                    onOpenConvert={(entry) =>
                      setTaskDialog({
                        mode: 'convert',
                        workspaceId: snapshot.currentWorkspaceId,
                        workspaceName: activeWorkspace.name,
                        entry,
                        planning: 'today',
                      })
                    }
                    onConvertNote={async (entry) => {
                      const targetWorkspaceId = snapshot.currentWorkspaceId;
                      const sequence = inboxController.reserveSnapshotRequest(targetWorkspaceId);
                      const result = await noteController.convertInbox(entry.id);
                      inboxController.applyReservedSnapshot(result.inboxSnapshot, sequence);
                      const converted = result.noteSnapshot.notes.find(
                        ({ sourceInboxEntryId }) => sourceInboxEntryId === entry.id,
                      );
                      if (converted) setRequestedNoteId(converted.id);
                      requestActiveView('notes');
                    }}
                  />
                ) : activeSurface === 'tasks' ? (
                  <TaskPage
                    key={snapshot.currentWorkspaceId}
                    snapshot={taskController.snapshot}
                    tasks={taskController.tasks}
                    status={taskController.status}
                    loadError={taskController.loadError}
                    operationError={taskController.operationError}
                    pendingTaskIds={taskController.pendingTaskIds}
                    onRetry={taskController.retry}
                    onOpenCreate={() => openTaskCreate('none')}
                    onOpenRename={(task) =>
                      setTaskDialog({
                        mode: 'rename',
                        workspaceId: snapshot.currentWorkspaceId,
                        workspaceName: activeWorkspace.name,
                        task,
                      })
                    }
                    onUpdateStatus={taskController.updateStatus}
                    onUpdatePlanning={taskController.updatePlanning}
                    assistantTaskLimit={ASSISTANT_SELECTED_TASK_MAX_COUNT}
                    onOpenAssistant={(tasks) =>
                      openAssistant({
                        kind: 'tasks',
                        taskIds: tasks.map(({ id }) => id),
                      })
                    }
                  />
                ) : activeSurface === 'notes' ? (
                  <NotePage
                    key={`${snapshot.currentWorkspaceId}:${notePageGeneration}`}
                    workspaceName={activeWorkspace.name}
                    notes={noteController.notes}
                    status={noteController.status}
                    loadError={noteController.loadError}
                    operationError={noteController.operationError}
                    pendingNoteIds={noteController.pendingNoteIds}
                    pendingCreate={noteController.pendingCreate}
                    requestedNoteId={requestedNoteId}
                    onRequestedNoteHandled={() => setRequestedNoteId(null)}
                    onDirtyChange={updateNoteDraftDirty}
                    onRetry={noteController.retry}
                    onCreate={noteController.create}
                    onUpdate={noteController.update}
                    onArchive={noteController.archive}
                    onOpenLink={(url) => {
                      openUrlInWorkspace(snapshot.currentWorkspaceId, url);
                    }}
                    onOpenAssistant={(note) =>
                      openAssistant({
                        kind: 'note',
                        noteId: note.id,
                        revision: note.revision,
                      })
                    }
                  />
                ) : activeSurface === 'assistant' ? (
                  <AssistantPage
                    key={snapshot.currentWorkspaceId}
                    workspaceName={activeWorkspace.name}
                    credential={assistantController.credential}
                    credentialStatus={assistantController.credentialStatus}
                    credentialError={assistantController.credentialError}
                    runtimeStatus={assistantController.runtimeStatus}
                    runtimeError={assistantController.runtimeError}
                    runtime={assistantController.snapshot}
                    operation={
                      assistantController.operation === 'start' ||
                      assistantController.operation === 'cancel'
                        ? assistantController.operation
                        : null
                    }
                    notes={noteController.notes}
                    tasks={taskController.tasks}
                    initialContext={assistantInitialContext}
                    contextGeneration={assistantEntry.generation}
                    promptMaxLength={ASSISTANT_PROMPT_MAX_LENGTH}
                    onRetry={assistantController.retry}
                    onOpenSettings={openAssistantSettings}
                    onStart={assistantController.start}
                    onCancel={assistantController.cancel}
                    onSaveResponse={async (response) => {
                      await noteController.create(
                        `AI 助手回复 · ${new Intl.DateTimeFormat('zh-CN').format(new Date())}`,
                        response,
                      );
                    }}
                  />
                ) : activeSurface === 'settings' ? (
                  <SettingsPage
                    workspaceId={snapshot.currentWorkspaceId}
                    section={settingsSection}
                    onSectionChange={setSettingsSection}
                    onOpenBrowser={() => updatePreferences({ browserOpen: true })}
                    onOpenTerminal={() => updatePreferences({ terminalOpen: true })}
                    dataSnapshot={dataState.snapshot}
                    dataStatus={dataState.loadStatus}
                    dataOperation={dataState.activeOperation?.kind ?? null}
                    dataFeedback={dataState.feedback}
                    onRetryData={() => void loadData()}
                    onCreateBackup={createBackup}
                    onUpdateBackupPolicy={updateBackupPolicy}
                    onExportData={exportData}
                    onChooseImport={chooseImport}
                    assistant={{
                      credential: assistantController.credential,
                      credentialStatus: assistantController.credentialStatus,
                      credentialError: assistantController.credentialError,
                      credentialOperation:
                        assistantController.operation === 'configure' ||
                        assistantController.operation === 'remove'
                          ? assistantController.operation
                          : null,
                      apiKeyMinLength: ASSISTANT_API_KEY_MIN_LENGTH,
                      apiKeyMaxLength: ASSISTANT_API_KEY_MAX_LENGTH,
                      onRetryCredential: assistantController.retry,
                      onConfigureCredential: assistantController.configureCredential,
                      onRemoveCredential: assistantController.removeCredential,
                    }}
                  />
                ) : (
                  <AutomationPage
                    items={automationController.items}
                    status={automationController.status}
                    loadError={automationController.loadError}
                    operationError={automationController.operationError}
                    pendingItemIds={automationController.pendingItemIds}
                    pendingCreate={automationController.pendingCreate}
                    onRetry={automationController.retry}
                    onOpenCreate={openAutomationCreate}
                    onOpenEdit={openAutomationEdit}
                    onSetEnabled={automationController.setEnabled}
                  />
                )}
              </div>
            </main>

            {browserOpen ? (
              <>
                <button
                  className="browser-scrim"
                  type="button"
                  aria-label="关闭浏览器面板"
                  onClick={() => updatePreferences({ browserOpen: false })}
                />
                <div className="browser-region" style={{ width: browserWidth }}>
                  <div
                    className="panel-resizer panel-resizer--horizontal"
                    role="separator"
                    aria-label="调整浏览器宽度"
                    aria-orientation="vertical"
                    aria-valuemin={340}
                    aria-valuemax={720}
                    aria-valuenow={browserWidth}
                    tabIndex={0}
                    onPointerDown={beginBrowserResize}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        updatePreferences({
                          browserWidth: clamp(
                            browserWidth + (event.key === 'ArrowLeft' ? 16 : -16),
                            340,
                            720,
                          ),
                        });
                      }
                    }}
                  />
                  <BrowserPanel
                    workspaceId={snapshot.currentWorkspaceId}
                    visible={!overlayOpen}
                    onClose={() => updatePreferences({ browserOpen: false })}
                  />
                </div>
              </>
            ) : null}
          </div>

          <div
            className={`terminal-region ${terminalOpen ? '' : 'is-collapsed'}`}
            style={{ height: terminalOpen ? effectiveTerminalHeight : 0 }}
            aria-hidden={!terminalOpen}
            inert={!terminalOpen}
          >
            <div
              className="panel-resizer panel-resizer--vertical"
              role="separator"
              aria-label="调整终端高度"
              aria-orientation="horizontal"
              aria-valuemin={180}
              aria-valuemax={terminalMaximum}
              aria-valuenow={effectiveTerminalHeight}
              tabIndex={terminalOpen ? 0 : -1}
              onPointerDown={beginTerminalResize}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  updatePreferences({
                    terminalHeight: clamp(
                      effectiveTerminalHeight + (event.key === 'ArrowUp' ? 16 : -16),
                      180,
                      terminalMaximum,
                    ),
                  });
                }
              }}
            />
            <TerminalPanel
              theme={theme}
              visible={terminalOpen}
              workspaceId={snapshot.currentWorkspaceId}
              onClose={() => updatePreferences({ terminalOpen: false })}
              onOpenSettings={openTerminalSettings}
              onMaximize={() =>
                updatePreferences({
                  terminalHeight:
                    effectiveTerminalHeight > viewportHeight * 0.6 ? 260 : terminalMaximum,
                })
              }
            />
          </div>

          <footer className="statusbar">
            <div>
              <span className="status-dot" />
              <span
                role={
                  workspaceController.operationError ||
                  inboxController.operationError ||
                  taskController.operationError ||
                  noteController.operationError ||
                  scheduleController.operationError ||
                  automationController.operationError ||
                  assistantController.credentialError ||
                  assistantController.runtimeError ||
                  dataState.feedback?.tone === 'error'
                    ? 'alert'
                    : undefined
                }
              >
                {workspaceController.operationError ??
                  inboxController.operationError ??
                  taskController.operationError ??
                  noteController.operationError ??
                  scheduleController.operationError ??
                  automationController.operationError ??
                  assistantController.credentialError ??
                  assistantController.runtimeError ??
                  (dataState.feedback?.tone === 'error' ? dataState.feedback.message : null) ??
                  (noteDraftDirty ? '笔记有未保存的更改' : null) ??
                  '已就绪'}
              </span>
            </div>
            <div className="statusbar__context">
              <span>{activeWorkspace.name}</span>
              <span>本地数据</span>
            </div>
            <div>
              <button
                type="button"
                onClick={() => updatePreferences({ browserOpen: !browserOpen })}
              >
                <Globe2 size={12} /> 浏览器
              </button>
              <button
                type="button"
                onClick={() => updatePreferences({ terminalOpen: !terminalOpen })}
              >
                <SquareTerminal size={12} /> 终端
              </button>
              <span>v{appVersion}</span>
            </div>
          </footer>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        commands={commands}
        searchController={searchController}
        currentWorkspaceId={snapshot.currentWorkspaceId}
        onSelectSearchResult={selectSearchResult}
        onClose={() => setPaletteOpen(false)}
      />
      {workspaceDialog ? (
        <WorkspaceDialog
          state={workspaceDialog}
          onClose={() => setWorkspaceDialog(null)}
          onCreate={workspaceController.create}
          onRename={workspaceController.rename}
          onArchive={workspaceController.archive}
        />
      ) : null}
      {quickCaptureTarget ? (
        <QuickCaptureDialog
          target={quickCaptureTarget}
          onClose={() => setQuickCaptureTarget(null)}
          onSubmit={inboxController.create}
        />
      ) : null}
      {taskDialog ? (
        <TaskDialog
          state={taskDialog}
          onClose={() => setTaskDialog(null)}
          onCreate={async (title, planning) => {
            if (taskDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开任务窗口。');
            }
            await taskController.create(title, planning);
          }}
          onRename={async (taskId, title) => {
            if (taskDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开任务窗口。');
            }
            await taskController.rename(taskId, title);
          }}
          onConvert={async (entryId, planning) => {
            if (taskDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开任务窗口。');
            }
            const sequence = inboxController.reserveSnapshotRequest(taskDialog.workspaceId);
            const result = await taskController.convertInbox(entryId, planning);
            inboxController.applyReservedSnapshot(result.inboxSnapshot, sequence);
          }}
        />
      ) : null}
      {scheduleDialog ? (
        <ScheduleDialog
          state={scheduleDialog}
          onClose={() => setScheduleDialog(null)}
          onCreate={async (title, kind, startMinute, endMinute) => {
            if (scheduleDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开日程窗口。');
            }
            await scheduleController.create(
              scheduleDialog.expectedDate,
              title,
              kind,
              startMinute,
              endMinute,
            );
          }}
          onUpdate={async (item, title, kind, startMinute, endMinute) => {
            if (scheduleDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开日程窗口。');
            }
            await scheduleController.update(
              item,
              scheduleDialog.expectedDate,
              title,
              kind,
              startMinute,
              endMinute,
            );
          }}
          onArchive={async (item) => {
            if (scheduleDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开日程窗口。');
            }
            await scheduleController.archive(item, scheduleDialog.expectedDate);
          }}
        />
      ) : null}
      {automationDialog ? (
        <AutomationDialog
          state={automationDialog}
          onClose={() => setAutomationDialog(null)}
          onCreate={async (name, schedule, action) => {
            if (automationDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开自动化窗口。');
            }
            await automationController.create(name, schedule, action);
          }}
          onUpdate={async (item, name, schedule, action) => {
            if (automationDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开自动化窗口。');
            }
            await automationController.update(item, name, schedule, action);
          }}
          onArchive={async (item) => {
            if (automationDialog.workspaceId !== snapshot.currentWorkspaceId) {
              throw new Error('工作区已经切换，请重新打开自动化窗口。');
            }
            await automationController.archive(item);
          }}
        />
      ) : null}
      {dataState.importPreview ? (
        <DataImportDialog
          key={dataState.importPreview.importId}
          preview={dataState.importPreview}
          busy={dataState.activeOperation !== null}
          error={dataState.feedback?.tone === 'error' ? dataState.feedback.message : null}
          onCancel={cancelImport}
          onConfirm={async () => {
            if (!confirmLeaveNoteDraft()) return;
            dataReplacementApprovedRef.current = true;
            dataReplacementNoteDiscardApprovedRef.current = true;
            try {
              await commitImport();
            } catch (error) {
              dataReplacementApprovedRef.current = false;
              dataReplacementNoteDiscardApprovedRef.current = false;
              throw error;
            }
          }}
        />
      ) : null}
      <InboxUndoStack
        notices={visibleUndoNotices}
        pendingTokens={inboxController.pendingUndoTokens}
        onUndo={inboxController.undoArchive}
        onDismiss={inboxController.dismissUndo}
      />
    </div>
  );
}

interface StartupShellProps {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  canRetry: boolean;
  maximized: boolean;
  onRetry: () => void;
  onToggleMaximize: () => void;
}

function StartupShell({
  status,
  error,
  canRetry,
  maximized,
  onRetry,
  onToggleMaximize,
}: StartupShellProps) {
  return (
    <div className="app-shell" aria-busy={status === 'loading'}>
      <header className="titlebar">
        <div className="titlebar__identity">
          <span className="titlebar__logo">
            <Sparkles size={15} />
          </span>
          <strong>Daily Workbench</strong>
        </div>
        <span />
        <span />
        <WindowControls
          maximized={maximized}
          onToggleMaximize={onToggleMaximize}
          onClose={() => void window.workbench?.window.close()}
        />
      </header>
      <main className="workspace-startup">
        <span className="workspace-startup__logo">
          <Layers3 size={24} aria-hidden="true" />
        </span>
        {status === 'error' ? (
          <>
            <h1>工作区暂时无法打开</h1>
            <p role="alert">{error ?? '本地工作区初始化失败。'}</p>
            {canRetry ? (
              <button type="button" onClick={onRetry}>
                重试
              </button>
            ) : null}
          </>
        ) : (
          <>
            <h1>正在打开工作区</h1>
            <p>正在读取本地 SQLite 数据与布局设置…</p>
            <span className="workspace-startup__progress" aria-hidden="true" />
          </>
        )}
      </main>
    </div>
  );
}

interface WindowControlsProps {
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
}

function WindowControls({ maximized, onToggleMaximize, onClose }: WindowControlsProps) {
  return (
    <div className="window-controls" aria-label="窗口控制">
      <button
        type="button"
        aria-label="最小化"
        onClick={() => void window.workbench?.window.minimize()}
      >
        <Minus size={15} />
      </button>
      <button type="button" aria-label={maximized ? '还原' : '最大化'} onClick={onToggleMaximize}>
        <Square size={12} />
      </button>
      <button type="button" className="window-controls__close" aria-label="关闭" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
