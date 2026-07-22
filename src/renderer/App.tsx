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
  X,
} from 'lucide-react';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_COLORS,
  type WorkspaceViewId,
} from '../shared/contracts';
import { isQuickCaptureShortcut } from '../shared/quick-capture-shortcut';
import { findCurrentWorkspace } from '../shared/workspace-domain';
import { ActivityRail } from './components/ActivityRail';
import { BrowserPanel } from './components/BrowserPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { IconButton } from './components/IconButton';
import { InboxPage } from './components/InboxPage';
import { InboxUndoStack } from './components/InboxUndoStack';
import { QuickCaptureDialog, type QuickCaptureTarget } from './components/QuickCaptureDialog';
import { SectionPage } from './components/SectionPage';
import { TerminalPanel } from './components/TerminalPanel';
import { TodayDashboard } from './components/TodayDashboard';
import { WorkspaceDialog, type WorkspaceDialogState } from './components/WorkspaceDialog';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { useInboxController } from './hooks/useInboxController';
import { useWorkspaceController } from './hooks/useWorkspaceController';
import type { ViewId } from './model';

const viewLabels: Record<ViewId, string> = {
  today: '今日',
  inbox: '收件箱',
  tasks: '任务',
  notes: '笔记',
  automations: '自动化',
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState<WorkspaceDialogState | null>(null);
  const [quickCaptureTarget, setQuickCaptureTarget] = useState<QuickCaptureTarget | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const activeResizeFinishRef = useRef<(() => void) | null>(null);
  const snapshot = workspaceController.snapshot;
  const inboxController = useInboxController(snapshot?.currentWorkspaceId ?? null);
  const activeWorkspace = snapshot ? findCurrentWorkspace(snapshot) : null;
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
  const overlayOpen = paletteOpen || workspaceDialog !== null || quickCaptureTarget !== null;
  const terminalMaximum = Math.min(2160, Math.max(180, viewportHeight - 180));
  const effectiveTerminalHeight = clamp(terminalHeight, 180, terminalMaximum);

  const updatePreferences = workspaceController.updatePreferences;
  const openQuickCapture = useCallback(() => {
    if (
      !activeWorkspace ||
      workspaceDialog !== null ||
      workspaceController.pendingOperation !== null
    ) {
      return;
    }
    setPaletteOpen(false);
    setQuickCaptureTarget(
      (current) =>
        current ?? { workspaceId: activeWorkspace.id, workspaceName: activeWorkspace.name },
    );
  }, [activeWorkspace, workspaceController.pendingOperation, workspaceDialog]);

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

  useEffect(() => window.workbench.inbox.onCaptureRequest(openQuickCapture), [openQuickCapture]);

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
      if (workspaceDialog !== null || workspaceController.pendingOperation !== null) {
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
        updatePreferences({ activeView: 'settings' });
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [
    browserOpen,
    paletteOpen,
    quickCaptureTarget,
    sidebarCollapsed,
    snapshot,
    terminalOpen,
    updatePreferences,
    openQuickCapture,
    workspaceController.pendingOperation,
    workspaceDialog,
  ]);

  const commands = useMemo<PaletteCommand[]>(() => {
    if (!snapshot || !activeWorkspace) return [];
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
          void workspaceController.activate(workspace.id).catch(() => undefined);
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
        id: 'workspace:create',
        label: '新建工作区',
        description: '创建一个独立的本地布局',
        group: '工作区',
        icon: FolderPlus,
        keywords: '工作区 新建 创建',
        action: () =>
          setWorkspaceDialog({
            mode: 'create',
            suggestedColor: WORKSPACE_COLORS[snapshot.workspaces.length % WORKSPACE_COLORS.length],
          }),
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
              action: () =>
                setWorkspaceDialog({
                  mode: 'archive',
                  workspace: activeWorkspace,
                  switchesWorkspace: true,
                }),
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
        id: 'go-today',
        label: '前往今日',
        group: '页面',
        icon: LayoutDashboard,
        action: () => updatePreferences({ activeView: 'today' }),
      },
      {
        id: 'go-inbox',
        label: '前往收件箱',
        group: '页面',
        icon: Inbox,
        action: () => updatePreferences({ activeView: 'inbox' }),
      },
      {
        id: 'go-tasks',
        label: '前往任务',
        group: '页面',
        icon: CheckSquare2,
        action: () => updatePreferences({ activeView: 'tasks' }),
      },
      {
        id: 'go-notes',
        label: '前往笔记',
        group: '页面',
        icon: NotebookPen,
        action: () => updatePreferences({ activeView: 'notes' }),
      },
      {
        id: 'go-automations',
        label: '前往自动化',
        group: '页面',
        icon: Bot,
        action: () => updatePreferences({ activeView: 'automations' }),
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
        action: () => updatePreferences({ activeView: 'settings' }),
      },
    ];
  }, [
    activeWorkspace,
    browserOpen,
    openQuickCapture,
    snapshot,
    terminalOpen,
    theme,
    updatePreferences,
    workspaceController,
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

  const setActiveView = (view: WorkspaceViewId) => updatePreferences({ activeView: view });

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

        <WindowControls maximized={maximized} onToggleMaximize={toggleWindowMaximize} />
      </header>

      <div className="workbench-shell">
        <ActivityRail
          activeView={activeView}
          inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
          onSelect={setActiveView}
        />
        <div
          className={`sidebar-slot ${sidebarCollapsed ? 'is-collapsed' : ''}`}
          aria-hidden={sidebarCollapsed}
          inert={sidebarCollapsed}
        >
          <WorkspaceSidebar
            activeView={activeView}
            activeWorkspace={activeWorkspace}
            workspaces={snapshot.workspaces}
            busy={workspaceController.pendingOperation !== null}
            pendingWorkspaceId={workspaceController.pendingWorkspaceId}
            saveError={workspaceController.saveError}
            saveStatus={workspaceController.saveStatus}
            inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
            onRetrySave={workspaceController.retryPreferences}
            onSelectView={setActiveView}
            onSelectWorkspace={(workspaceId) => {
              void workspaceController.activate(workspaceId).catch(() => undefined);
            }}
            onCreateWorkspace={() =>
              setWorkspaceDialog({
                mode: 'create',
                suggestedColor:
                  WORKSPACE_COLORS[snapshot.workspaces.length % WORKSPACE_COLORS.length],
              })
            }
            onRenameWorkspace={(workspace) => setWorkspaceDialog({ mode: 'rename', workspace })}
            onArchiveWorkspace={(workspace) =>
              setWorkspaceDialog({
                mode: 'archive',
                workspace,
                switchesWorkspace: workspace.id === snapshot.currentWorkspaceId,
              })
            }
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
                  <strong>{viewLabels[activeView]}</strong>
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
                {activeView === 'today' ? (
                  <TodayDashboard
                    key={snapshot.currentWorkspaceId}
                    inboxStatus={inboxController.status}
                    inboxCount={inboxController.snapshot ? inboxController.counts.total : null}
                    uncategorizedCount={
                      inboxController.snapshot ? inboxController.counts.uncategorized : null
                    }
                    capturePending={inboxController.pendingCapture}
                    onCapture={(content) =>
                      inboxController.create(snapshot.currentWorkspaceId, content, 'uncategorized')
                    }
                    onOpenInbox={() => setActiveView('inbox')}
                    onOpenTasks={() => setActiveView('tasks')}
                    onOpenNotes={() => setActiveView('notes')}
                  />
                ) : activeView === 'inbox' ? (
                  <InboxPage
                    entries={inboxController.entries}
                    status={inboxController.status}
                    loadError={inboxController.loadError}
                    operationError={inboxController.operationError}
                    pendingEntryIds={inboxController.pendingEntryIds}
                    onRetry={inboxController.retry}
                    onOpenCapture={openQuickCapture}
                    onCategorize={inboxController.categorize}
                    onArchive={inboxController.archive}
                  />
                ) : (
                  <SectionPage
                    view={activeView}
                    onOpenBrowser={() => updatePreferences({ browserOpen: true })}
                    onOpenTerminal={() => updatePreferences({ terminalOpen: true })}
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
              onClose={() => updatePreferences({ terminalOpen: false })}
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
                  workspaceController.operationError || inboxController.operationError
                    ? 'alert'
                    : undefined
                }
              >
                {workspaceController.operationError ?? inboxController.operationError ?? '已就绪'}
              </span>
            </div>
            <div className="statusbar__context">
              <span>{activeWorkspace.name}</span>
              <span>本地模式</span>
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
        <WindowControls maximized={maximized} onToggleMaximize={onToggleMaximize} />
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
}

function WindowControls({ maximized, onToggleMaximize }: WindowControlsProps) {
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
      <button
        type="button"
        className="window-controls__close"
        aria-label="关闭"
        onClick={() => void window.workbench?.window.close()}
      >
        <X size={16} />
      </button>
    </div>
  );
}
