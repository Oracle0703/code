import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AppWindow,
  Bot,
  CheckSquare2,
  Command,
  Globe2,
  Inbox,
  LayoutDashboard,
  Minus,
  Moon,
  NotebookPen,
  PanelBottom,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
  SquareTerminal,
  Sun,
  X,
} from 'lucide-react';
import { ActivityRail } from './components/ActivityRail';
import { BrowserPanel } from './components/BrowserPanel';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { IconButton } from './components/IconButton';
import { SectionPage } from './components/SectionPage';
import { TerminalPanel } from './components/TerminalPanel';
import { TodayDashboard } from './components/TodayDashboard';
import { WorkspaceSidebar } from './components/WorkspaceSidebar';
import { usePersistentState } from './hooks/usePersistentState';
import type { ThemeMode, ViewId, Workspace } from './model';

const workspaces: Workspace[] = [
  { id: 'personal', name: '我的工作台', shortName: 'DW', color: '#7b6ee8' },
  { id: 'work', name: '工作', shortName: 'WK', color: '#348bd4' },
  { id: 'learning', name: '学习与探索', shortName: 'LX', color: '#2da77e' },
];

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

export function App() {
  const [activeView, setActiveView] = usePersistentState<ViewId>('daily.navigation.view', 'today');
  const [workspaceId, setWorkspaceId] = usePersistentState('daily.workspace.current', 'personal');
  const [theme, setTheme] = usePersistentState<ThemeMode>('daily.appearance.theme', 'dark');
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState(
    'daily.layout.sidebar-collapsed',
    false,
  );
  const [browserOpen, setBrowserOpen] = usePersistentState('daily.layout.browser-open', true);
  const [terminalOpen, setTerminalOpen] = usePersistentState('daily.layout.terminal-open', true);
  const [browserWidth, setBrowserWidth] = usePersistentState('daily.layout.browser-width', 430);
  const [terminalHeight, setTerminalHeight] = usePersistentState(
    'daily.layout.terminal-height',
    260,
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const quickCaptureRef = useRef<HTMLInputElement>(null);

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId) ?? workspaces[0];

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
    const handleShortcut = (event: KeyboardEvent) => {
      const commandKey = event.ctrlKey || event.metaKey;
      if (!commandKey) {
        if (event.key === 'Escape' && paletteOpen) setPaletteOpen(false);
        return;
      }

      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key.toLowerCase() === 'b' && event.shiftKey) {
        event.preventDefault();
        setBrowserOpen((open) => !open);
      } else if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setSidebarCollapsed((collapsed) => !collapsed);
      } else if (event.key.toLowerCase() === 'j' || event.code === 'Backquote') {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setActiveView('today');
        window.requestAnimationFrame(() => quickCaptureRef.current?.focus());
      } else if (event.key === ',') {
        event.preventDefault();
        setActiveView('settings');
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [paletteOpen, setActiveView, setBrowserOpen, setSidebarCollapsed, setTerminalOpen]);

  const commands = useMemo<PaletteCommand[]>(
    () => [
      {
        id: 'capture',
        label: '快速记录',
        description: '把一个想法或任务加入收件箱',
        group: '操作',
        icon: Plus,
        shortcut: 'Ctrl N',
        keywords: '新建 添加 任务 笔记',
        action: () => {
          setActiveView('today');
          window.requestAnimationFrame(() => quickCaptureRef.current?.focus());
        },
      },
      {
        id: 'toggle-browser',
        label: browserOpen ? '关闭右侧浏览器' : '打开右侧浏览器',
        description: '在当前工作区浏览网页',
        group: '工具',
        icon: Globe2,
        shortcut: 'Ctrl ⇧ B',
        keywords: '网页 web panel',
        action: () => setBrowserOpen((open) => !open),
      },
      {
        id: 'toggle-terminal',
        label: terminalOpen ? '关闭集成终端' : '打开集成终端',
        description: '显示绑定当前工作区的 Shell',
        group: '工具',
        icon: SquareTerminal,
        shortcut: 'Ctrl J',
        keywords: '命令行 shell powershell',
        action: () => setTerminalOpen((open) => !open),
      },
      {
        id: 'go-today',
        label: '前往今日',
        group: '页面',
        icon: LayoutDashboard,
        action: () => setActiveView('today'),
      },
      {
        id: 'go-inbox',
        label: '前往收件箱',
        group: '页面',
        icon: Inbox,
        action: () => setActiveView('inbox'),
      },
      {
        id: 'go-tasks',
        label: '前往任务',
        group: '页面',
        icon: CheckSquare2,
        action: () => setActiveView('tasks'),
      },
      {
        id: 'go-notes',
        label: '前往笔记',
        group: '页面',
        icon: NotebookPen,
        action: () => setActiveView('notes'),
      },
      {
        id: 'go-automations',
        label: '前往自动化',
        group: '页面',
        icon: Bot,
        action: () => setActiveView('automations'),
      },
      {
        id: 'toggle-theme',
        label: theme === 'dark' ? '切换为浅色主题' : '切换为深色主题',
        group: '设置',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: '外观 颜色 dark light',
        action: () => setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark')),
      },
      {
        id: 'open-settings',
        label: '打开设置',
        group: '设置',
        icon: Settings2,
        shortcut: 'Ctrl ,',
        action: () => setActiveView('settings'),
      },
    ],
    [browserOpen, setActiveView, setBrowserOpen, setTerminalOpen, setTheme, terminalOpen, theme],
  );

  const beginBrowserResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = browserWidth;
    document.body.classList.add('is-resizing-horizontal');

    const move = (moveEvent: PointerEvent) => {
      const maximum = Math.min(720, window.innerWidth - 560);
      setBrowserWidth(clamp(startWidth + startX - moveEvent.clientX, 340, Math.max(340, maximum)));
    };
    const finish = () => {
      document.body.classList.remove('is-resizing-horizontal');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  };

  const beginTerminalResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = terminalHeight;
    document.body.classList.add('is-resizing-vertical');

    const move = (moveEvent: PointerEvent) => {
      const maximum = Math.max(260, window.innerHeight - 180);
      setTerminalHeight(clamp(startHeight + startY - moveEvent.clientY, 180, maximum));
    };
    const finish = () => {
      document.body.classList.remove('is-resizing-vertical');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  };

  const toggleWindowMaximize = () => {
    void window.workbench?.window
      .toggleMaximize()
      .then(setMaximized)
      .catch(() => undefined);
  };

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
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
          <IconButton
            label="内置浏览器"
            active={browserOpen}
            onClick={() => setBrowserOpen((open) => !open)}
          >
            <PanelRight size={16} />
          </IconButton>
          <IconButton
            label="集成终端"
            active={terminalOpen}
            onClick={() => setTerminalOpen((open) => !open)}
          >
            <PanelBottom size={16} />
          </IconButton>
          <IconButton
            label={theme === 'dark' ? '使用浅色主题' : '使用深色主题'}
            onClick={() => setTheme((currentTheme) => (currentTheme === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </IconButton>
        </div>

        <div className="window-controls" aria-label="窗口控制">
          <button
            type="button"
            aria-label="最小化"
            onClick={() => void window.workbench?.window.minimize()}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            aria-label={maximized ? '还原' : '最大化'}
            onClick={toggleWindowMaximize}
          >
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
      </header>

      <div className="workbench-shell">
        <ActivityRail activeView={activeView} onSelect={setActiveView} />
        <div
          className={`sidebar-slot ${sidebarCollapsed ? 'is-collapsed' : ''}`}
          aria-hidden={sidebarCollapsed}
        >
          <WorkspaceSidebar
            activeView={activeView}
            workspaceId={workspaceId}
            workspaces={workspaces}
            onSelectView={setActiveView}
            onSelectWorkspace={setWorkspaceId}
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
                      onClick={() => setBrowserOpen(true)}
                    >
                      <Globe2 size={14} /> 浏览器
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="page-scroll">
                {activeView === 'today' ? (
                  <TodayDashboard
                    quickCaptureRef={quickCaptureRef}
                    onOpenInbox={() => setActiveView('inbox')}
                    onOpenTasks={() => setActiveView('tasks')}
                    onOpenNotes={() => setActiveView('notes')}
                  />
                ) : (
                  <SectionPage
                    view={activeView}
                    onOpenBrowser={() => setBrowserOpen(true)}
                    onOpenTerminal={() => setTerminalOpen(true)}
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
                  onClick={() => setBrowserOpen(false)}
                />
                <div className="browser-region" style={{ width: browserWidth }}>
                  <div
                    className="panel-resizer panel-resizer--horizontal"
                    role="separator"
                    aria-label="调整浏览器宽度"
                    aria-orientation="vertical"
                    aria-valuenow={browserWidth}
                    tabIndex={0}
                    onPointerDown={beginBrowserResize}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                        event.preventDefault();
                        setBrowserWidth((width) =>
                          clamp(width + (event.key === 'ArrowLeft' ? 16 : -16), 340, 720),
                        );
                      }
                    }}
                  />
                  <BrowserPanel visible={!paletteOpen} onClose={() => setBrowserOpen(false)} />
                </div>
              </>
            ) : null}
          </div>

          <div
            className={`terminal-region ${terminalOpen ? '' : 'is-collapsed'}`}
            style={{ height: terminalOpen ? terminalHeight : 0 }}
          >
            <div
              className="panel-resizer panel-resizer--vertical"
              role="separator"
              aria-label="调整终端高度"
              aria-orientation="horizontal"
              aria-valuenow={terminalHeight}
              tabIndex={terminalOpen ? 0 : -1}
              onPointerDown={beginTerminalResize}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  setTerminalHeight((height) =>
                    clamp(
                      height + (event.key === 'ArrowUp' ? 16 : -16),
                      180,
                      window.innerHeight - 180,
                    ),
                  );
                }
              }}
            />
            <TerminalPanel
              theme={theme}
              visible={terminalOpen}
              onClose={() => setTerminalOpen(false)}
              onMaximize={() =>
                setTerminalHeight((height) =>
                  height > window.innerHeight * 0.6 ? 260 : window.innerHeight - 145,
                )
              }
            />
          </div>

          <footer className="statusbar">
            <div>
              <span className="status-dot" /> 已就绪
            </div>
            <div className="statusbar__context">
              <span>{activeWorkspace.name}</span>
              <span>本地模式</span>
            </div>
            <div>
              <button type="button" onClick={() => setBrowserOpen((open) => !open)}>
                <Globe2 size={12} /> 浏览器
              </button>
              <button type="button" onClick={() => setTerminalOpen((open) => !open)}>
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
    </div>
  );
}
