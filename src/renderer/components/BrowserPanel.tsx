import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  BookOpen,
  Download,
  FolderOpen,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { BrowserDownload, BrowserTab } from '../../shared/contracts';
import { getBrowserShortcutAction } from '../../shared/browser-shortcut';
import {
  type BrowserAddressNavigationAttempt,
  browserBookmarkForUrl,
  browserDownloadProgress,
  browserTabAtOffset,
  browserTabLabel,
  formatBrowserBytes,
  isBookmarkableBrowserUrl,
  resolveBrowserAddress,
  shouldRevertBrowserAddress,
} from '../browser-state';
import { isBrowserShortcutEventTarget } from '../browser-shortcut-target';
import { BrowserViewSyncCoordinator } from '../browser-view-sync';
import { useBrowserController } from '../hooks/useBrowserController';
import { IconButton } from './IconButton';

interface BrowserPanelProps {
  workspaceId: string;
  onClose: () => void;
  visible: boolean;
}

type AuxiliaryPanel = 'bookmarks' | 'downloads' | null;

const downloadStateLabels: Record<BrowserDownload['state'], string> = {
  progressing: '下载中',
  paused: '已暂停',
  interrupted: '已中断',
  completed: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

export function BrowserPanel({ workspaceId, onClose, visible }: BrowserPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousTabIdentityRef = useRef<string | null>(null);
  const addressDraftVersionRef = useRef(0);
  const pendingNavigationRef = useRef<BrowserAddressNavigationAttempt | null>(null);
  const addressContextRef = useRef<{
    workspaceId: string;
    tabId: string | null;
    committedUrl: string;
  }>({ workspaceId, tabId: null, committedUrl: '' });
  const viewSyncCoordinatorRef = useRef(new BrowserViewSyncCoordinator());
  const controller = useBrowserController(workspaceId);
  const controllerRef = useRef(controller);
  const shortcutStateRef = useRef({
    visible,
    snapshot: controller.snapshot,
    activeTab: controller.activeTab,
  });
  const setBrowserBounds = controller.setBounds;
  const setBrowserVisible = controller.setVisible;
  const [address, setAddress] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [auxiliaryState, setAuxiliaryState] = useState<{
    workspaceId: string;
    panel: AuxiliaryPanel;
  }>({ workspaceId, panel: null });
  const snapshot = controller.snapshot;
  const activeTab = controller.activeTab;
  const auxiliaryPanel = auxiliaryState.workspaceId === workspaceId ? auxiliaryState.panel : null;
  const setAuxiliaryPanel = (
    update: AuxiliaryPanel | ((current: AuxiliaryPanel) => AuxiliaryPanel),
  ) => {
    setAuxiliaryState((current) => {
      const currentPanel = current.workspaceId === workspaceId ? current.panel : null;
      return {
        workspaceId,
        panel: typeof update === 'function' ? update(currentPanel) : update,
      };
    });
  };
  const activeBookmark =
    activeTab && snapshot ? browserBookmarkForUrl(snapshot.bookmarks, activeTab.url) : null;
  const browserReady =
    controller.bridgeAvailable &&
    controller.status === 'ready' &&
    snapshot?.workspaceId === workspaceId &&
    activeTab !== null;
  const browserNotice = addressError ?? controller.operationError ?? controller.loadError;

  useLayoutEffect(() => {
    controllerRef.current = controller;
    shortcutStateRef.current = { visible, snapshot, activeTab };
    addressContextRef.current = {
      workspaceId,
      tabId: activeTab?.id ?? null,
      committedUrl: activeTab?.url ?? '',
    };
  }, [activeTab, controller, snapshot, visible, workspaceId]);

  useEffect(() => {
    const tabIdentity = `${workspaceId}:${activeTab?.id ?? ''}`;
    const tabChanged = previousTabIdentityRef.current !== tabIdentity;
    previousTabIdentityRef.current = tabIdentity;
    const pendingNavigation = pendingNavigationRef.current;
    const navigationCommitted =
      activeTab !== null &&
      pendingNavigation !== null &&
      pendingNavigation.workspaceId === workspaceId &&
      pendingNavigation.tabId === activeTab?.id &&
      activeTab.url === pendingNavigation.url;
    if (navigationCommitted) pendingNavigationRef.current = null;

    if (tabChanged) {
      pendingNavigationRef.current = null;
      addressDraftVersionRef.current += 1;
      setAddress(activeTab?.url ?? '');
      setAddressError(null);
    } else if (!addressFocused && pendingNavigationRef.current === null) {
      addressDraftVersionRef.current += 1;
      setAddress(activeTab?.url ?? '');
      setAddressError(null);
    }
  }, [activeTab, addressFocused, workspaceId]);

  useEffect(() => {
    if (!visible || controller.focusAddressRequest === 0) return;
    const frame = window.requestAnimationFrame(() => {
      addressRef.current?.focus();
      addressRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [controller.focusAddressRequest, visible]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isBrowserShortcutEventTarget(event.target)) return;
      const action = getBrowserShortcutAction({
        type: event.type,
        key: event.key,
        control: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
        repeat: event.repeat,
        composing: event.isComposing,
      });
      const current = shortcutStateRef.current;
      if (!action || !current.visible) return;
      const currentController = controllerRef.current;
      const currentTab = current.activeTab;
      if (action === 'stop' && !currentTab?.isLoading) return;

      event.preventDefault();
      switch (action) {
        case 'focus-address':
          currentController.requestAddressFocus();
          break;
        case 'create-tab':
          void currentController
            .createTab()
            .then(() => currentController.requestAddressFocus())
            .catch(() => undefined);
          break;
        case 'close-tab':
          if (currentTab) void currentController.closeTab(currentTab.id).catch(() => undefined);
          break;
        case 'reload':
          if (currentTab) void currentController.reload(currentTab.id).catch(() => undefined);
          break;
        case 'toggle-bookmark':
          if (currentTab && isBookmarkableBrowserUrl(currentTab.url)) {
            void currentController.toggleBookmark(currentTab.id).catch(() => undefined);
          }
          break;
        case 'next-tab':
        case 'previous-tab': {
          const target =
            current.snapshot && currentTab
              ? browserTabAtOffset(
                  current.snapshot.tabs,
                  currentTab.id,
                  action === 'next-tab' ? 1 : -1,
                )
              : null;
          if (target) void currentController.activateTab(target.id).catch(() => undefined);
          break;
        }
        case 'back':
          if (currentTab?.canGoBack) {
            void currentController.back(currentTab.id).catch(() => undefined);
          }
          break;
        case 'forward':
          if (currentTab?.canGoForward) {
            void currentController.forward(currentTab.id).catch(() => undefined);
          }
          break;
        case 'stop':
          if (currentTab) void currentController.stop(currentTab.id).catch(() => undefined);
          break;
      }
    };

    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const viewSyncCoordinator = viewSyncCoordinatorRef.current;
    if (!viewport) return;
    if (!browserReady || !visible) {
      void viewSyncCoordinator.hide(workspaceId, setBrowserVisible).catch(() => undefined);
      return;
    }

    let animationFrame = 0;
    let disposed = false;
    const syncBounds = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect();
        if (disposed || rect.width < 1 || rect.height < 1) return;
        void viewSyncCoordinator
          .synchronize({
            workspaceId,
            bounds: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            setBounds: setBrowserBounds,
            setVisible: setBrowserVisible,
          })
          .catch(() => undefined);
      });
    };

    const resizeObserver = new ResizeObserver(syncBounds);
    resizeObserver.observe(viewport);
    window.addEventListener('resize', syncBounds);
    syncBounds();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncBounds);
      void viewSyncCoordinator.hide(workspaceId, setBrowserVisible).catch(() => undefined);
    };
  }, [
    auxiliaryPanel,
    browserNotice,
    browserReady,
    setBrowserBounds,
    setBrowserVisible,
    visible,
    workspaceId,
  ]);

  const focusAddress = () => controller.requestAddressFocus();

  const createTab = () => {
    void controller
      .createTab()
      .then(() => focusAddress())
      .catch(() => undefined);
  };

  const invokeTab = (
    action: 'back' | 'forward' | 'reload' | 'stop',
    tab: BrowserTab | null = activeTab,
  ) => {
    if (!tab) return;
    void controller[action](tab.id).catch(() => undefined);
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    if (!activeTab) return;
    let nextAddress: string;
    try {
      nextAddress = resolveBrowserAddress(address);
    } catch (error) {
      setAddressError(error instanceof Error ? error.message : '请输入有效的网址或搜索内容。');
      return;
    }
    const attempt: BrowserAddressNavigationAttempt = {
      workspaceId,
      tabId: activeTab.id,
      draftVersion: ++addressDraftVersionRef.current,
      url: nextAddress,
    };
    pendingNavigationRef.current = attempt;
    setAddress(nextAddress);
    setAddressError(null);
    addressRef.current?.blur();
    void controller
      .navigate(activeTab.id, nextAddress)
      .then((nextSnapshot) => {
        const current = addressContextRef.current;
        if (
          pendingNavigationRef.current !== attempt ||
          !shouldRevertBrowserAddress(attempt, {
            workspaceId: current.workspaceId,
            tabId: current.tabId,
            draftVersion: addressDraftVersionRef.current,
          })
        ) {
          return;
        }
        pendingNavigationRef.current = null;
        addressDraftVersionRef.current += 1;
        setAddress(nextSnapshot.tabs.find(({ id }) => id === attempt.tabId)?.url ?? nextAddress);
      })
      .catch(() => {
        const current = addressContextRef.current;
        if (
          pendingNavigationRef.current !== attempt ||
          !shouldRevertBrowserAddress(attempt, {
            workspaceId: current.workspaceId,
            tabId: current.tabId,
            draftVersion: addressDraftVersionRef.current,
          })
        ) {
          return;
        }
        pendingNavigationRef.current = null;
        addressDraftVersionRef.current += 1;
        setAddress(current.committedUrl);
      });
  };

  const activateTab = (tabId: string, focusTab = false) => {
    void controller
      .activateTab(tabId)
      .then(() => {
        if (!focusTab) return;
        window.requestAnimationFrame(() => tabButtonRefs.current.get(tabId)?.focus());
      })
      .catch(() => undefined);
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: BrowserTab) => {
    if (!snapshot) return;
    let target: BrowserTab | undefined | null;
    if (event.key === 'ArrowLeft') target = browserTabAtOffset(snapshot.tabs, tab.id, -1);
    else if (event.key === 'ArrowRight') target = browserTabAtOffset(snapshot.tabs, tab.id, 1);
    else if (event.key === 'Home') target = snapshot.tabs[0];
    else if (event.key === 'End') target = snapshot.tabs.at(-1);
    else if (event.key === 'Delete') {
      event.preventDefault();
      void controller.closeTab(tab.id).catch(() => undefined);
      return;
    } else {
      return;
    }
    event.preventDefault();
    if (target) activateTab(target.id, true);
  };

  const openBookmark = (
    bookmarkId: string,
    newTab: boolean,
    event?: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    event?.preventDefault();
    const bookmark = snapshot?.bookmarks.find(({ id }) => id === bookmarkId);
    if (!bookmark) return;
    void controller.openBookmark(bookmark, newTab).catch(() => undefined);
  };

  return (
    <aside className="browser-panel" aria-label="内置浏览器">
      <div className="browser-tabs">
        <div className="browser-tab-list" role="tablist" aria-label="浏览器标签页">
          {snapshot?.tabs.map((tab) => {
            const active = tab.id === snapshot.activeTabId;
            const label = browserTabLabel(tab);
            const pending = controller.isPending(`tab:${tab.id}`);
            return (
              <div className={`browser-tab ${active ? 'is-active' : ''}`} key={tab.id}>
                <button
                  ref={(node) => {
                    if (node) tabButtonRefs.current.set(tab.id, node);
                    else tabButtonRefs.current.delete(tab.id);
                  }}
                  type="button"
                  className="browser-tab__target"
                  role="tab"
                  aria-selected={active}
                  aria-label={`${label}${tab.isLoading ? '，加载中' : ''}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => activateTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab)}
                >
                  {tab.isLoading ? (
                    <LoaderCircle className="spin" size={14} aria-hidden="true" />
                  ) : (
                    <Globe2 size={14} aria-hidden="true" />
                  )}
                  <span>{label}</span>
                </button>
                <IconButton
                  className="browser-tab__close"
                  label={`关闭“${label}”`}
                  tooltipSide="bottom"
                  disabled={pending}
                  tabIndex={active ? 0 : -1}
                  onClick={() => void controller.closeTab(tab.id).catch(() => undefined)}
                >
                  <X size={13} aria-hidden="true" />
                </IconButton>
              </div>
            );
          })}
        </div>
        <IconButton label="新建标签页" tooltipSide="bottom" onClick={createTab}>
          <Plus size={15} aria-hidden="true" />
        </IconButton>
        <IconButton label="关闭浏览器面板" tooltipSide="left" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="browser-toolbar">
        <IconButton
          label="后退"
          disabled={!activeTab?.canGoBack || controller.isPending(`tab:${activeTab.id}`)}
          onClick={() => invokeTab('back')}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="前进"
          disabled={!activeTab?.canGoForward || controller.isPending(`tab:${activeTab.id}`)}
          onClick={() => invokeTab('forward')}
        >
          <ArrowRight size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={activeTab?.isLoading ? '停止加载' : '刷新'}
          disabled={!activeTab || controller.isPending(`tab:${activeTab.id}`)}
          onClick={() => invokeTab(activeTab?.isLoading ? 'stop' : 'reload')}
        >
          {activeTab?.isLoading ? (
            <X size={15} aria-hidden="true" />
          ) : (
            <RefreshCw size={15} aria-hidden="true" />
          )}
        </IconButton>

        <form className="address-bar" onSubmit={navigate}>
          {activeTab?.url.startsWith('https:') ? (
            <LockKeyhole size={13} aria-label="安全连接" />
          ) : (
            <Search size={13} aria-hidden="true" />
          )}
          <label className="sr-only" htmlFor={`browser-address-${workspaceId}`}>
            网址或搜索内容
          </label>
          <input
            ref={addressRef}
            id={`browser-address-${workspaceId}`}
            value={address}
            aria-invalid={addressError ? true : undefined}
            placeholder="搜索或输入网址"
            onChange={(event) => {
              addressDraftVersionRef.current += 1;
              pendingNavigationRef.current = null;
              setAddress(event.target.value);
              setAddressError(null);
            }}
            onFocus={(event) => {
              setAddressFocused(true);
              event.currentTarget.select();
            }}
            onBlur={() => {
              setAddressFocused(false);
              if (addressError) return;
              const pendingNavigation = pendingNavigationRef.current;
              setAddress(
                pendingNavigation?.workspaceId === workspaceId &&
                  pendingNavigation.tabId === activeTab?.id
                  ? pendingNavigation.url
                  : (activeTab?.url ?? ''),
              );
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              addressDraftVersionRef.current += 1;
              pendingNavigationRef.current = null;
              setAddress(activeTab?.url ?? '');
              setAddressError(null);
              event.currentTarget.blur();
            }}
            spellCheck={false}
            autoComplete="off"
            disabled={!activeTab}
          />
        </form>

        <IconButton
          label={activeBookmark ? '取消收藏当前网页' : '收藏当前网页'}
          active={Boolean(activeBookmark)}
          disabled={
            !activeTab ||
            !isBookmarkableBrowserUrl(activeTab.url) ||
            controller.isPending(`tab:${activeTab.id}`)
          }
          onClick={() => {
            if (activeTab) void controller.toggleBookmark(activeTab.id).catch(() => undefined);
          }}
        >
          <Bookmark size={14} fill={activeBookmark ? 'currentColor' : 'none'} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="收藏夹"
          active={auxiliaryPanel === 'bookmarks'}
          onClick={() =>
            setAuxiliaryPanel((current) => (current === 'bookmarks' ? null : 'bookmarks'))
          }
        >
          <BookOpen size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          className="browser-download-button"
          label="下载"
          active={auxiliaryPanel === 'downloads'}
          onClick={() =>
            setAuxiliaryPanel((current) => (current === 'downloads' ? null : 'downloads'))
          }
        >
          <Download size={14} aria-hidden="true" />
          {snapshot && snapshot.downloads.length > 0 ? (
            <span className="browser-tool-badge" aria-hidden="true">
              {Math.min(snapshot.downloads.length, 9)}
            </span>
          ) : null}
        </IconButton>
      </div>

      {browserNotice ? (
        <div className="browser-notice" role="alert">
          <span>{browserNotice}</span>
          {controller.loadError ? (
            <button type="button" onClick={controller.retry}>
              重试
            </button>
          ) : (
            <IconButton
              label="关闭提示"
              onClick={() => {
                setAddressError(null);
                controller.clearOperationError();
              }}
            >
              <X size={12} aria-hidden="true" />
            </IconButton>
          )}
        </div>
      ) : null}

      {auxiliaryPanel === 'bookmarks' ? (
        <section className="browser-bookmarks-bar" aria-label="当前工作区收藏夹">
          {snapshot && snapshot.bookmarks.length > 0 ? (
            <div className="browser-bookmark-list">
              {snapshot.bookmarks.map((bookmark) => {
                const pending = controller.isPending(`bookmark:${bookmark.id}`);
                return (
                  <div className="browser-bookmark" key={bookmark.id}>
                    <button
                      type="button"
                      className="browser-bookmark__target"
                      title={`${bookmark.title}\n${bookmark.url}`}
                      disabled={pending}
                      onClick={(event) =>
                        openBookmark(bookmark.id, event.ctrlKey || event.metaKey, event)
                      }
                      onAuxClick={(event) => {
                        if (event.button === 1) openBookmark(bookmark.id, true, event);
                      }}
                    >
                      <Globe2 size={13} aria-hidden="true" />
                      <span>{bookmark.title || bookmark.url}</span>
                    </button>
                    <IconButton
                      label={`移除“${bookmark.title || bookmark.url}”`}
                      disabled={pending}
                      onClick={() =>
                        void controller.removeBookmark(bookmark).catch(() => undefined)
                      }
                    >
                      <X size={12} aria-hidden="true" />
                    </IconButton>
                  </div>
                );
              })}
            </div>
          ) : (
            <p>还没有收藏。打开网页后点击星标即可保存在这个工作区。</p>
          )}
        </section>
      ) : null}

      {auxiliaryPanel === 'downloads' ? (
        <section className="browser-downloads" aria-label="下载管理">
          <header>
            <strong>下载</strong>
            <span>仅显示当前工作区的下载记录</span>
          </header>
          {snapshot && snapshot.downloads.length > 0 ? (
            <div className="browser-download-list">
              {snapshot.downloads.map((download) => (
                <DownloadRow
                  key={download.id}
                  download={download}
                  pending={controller.isPending(`download:${download.id}`)}
                  onPause={() => void controller.pauseDownload(download).catch(() => undefined)}
                  onResume={() => void controller.resumeDownload(download).catch(() => undefined)}
                  onCancel={() => void controller.cancelDownload(download).catch(() => undefined)}
                  onDismiss={() => void controller.dismissDownload(download).catch(() => undefined)}
                  onReveal={() => void controller.revealDownload(download).catch(() => undefined)}
                />
              ))}
            </div>
          ) : (
            <p className="browser-downloads__empty">下载开始后，会在这里显示进度和操作。</p>
          )}
        </section>
      ) : null}

      <div ref={viewportRef} className="browser-viewport">
        {!controller.bridgeAvailable ? (
          <BrowserFallback title="安全浏览区域" detail="浏览器会在 Electron 桌面应用中启用。" />
        ) : controller.status === 'loading' ? (
          <BrowserFallback title="正在打开浏览器" detail="正在恢复当前工作区的标签页…" loading />
        ) : controller.status === 'error' ? (
          <BrowserFallback title="浏览器暂时无法打开" detail="请使用上方的重试操作。" />
        ) : (
          <div className="browser-surface-hint" aria-hidden="true">
            <Globe2 size={24} />
          </div>
        )}
      </div>
    </aside>
  );
}

interface DownloadRowProps {
  download: BrowserDownload;
  pending: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDismiss: () => void;
  onReveal: () => void;
}

function DownloadRow({
  download,
  pending,
  onPause,
  onResume,
  onCancel,
  onDismiss,
  onReveal,
}: DownloadRowProps) {
  const progress = browserDownloadProgress(download);
  const active =
    download.state === 'progressing' ||
    download.state === 'paused' ||
    download.state === 'interrupted';
  const terminal =
    download.state === 'completed' || download.state === 'cancelled' || download.state === 'failed';

  return (
    <article className={`browser-download is-${download.state}`}>
      <span className="browser-download__icon">
        {download.state === 'completed' ? (
          <FolderOpen size={15} aria-hidden="true" />
        ) : download.state === 'failed' || download.state === 'cancelled' ? (
          <XCircle size={15} aria-hidden="true" />
        ) : (
          <Download size={15} aria-hidden="true" />
        )}
      </span>
      <div className="browser-download__body">
        <strong title={download.fileName}>{download.fileName}</strong>
        <span>
          {downloadStateLabels[download.state]}
          {download.sourceHost ? ` · ${download.sourceHost}` : ''}
          {' · '}
          {formatBrowserBytes(download.receivedBytes)}
          {download.totalBytes > 0 ? ` / ${formatBrowserBytes(download.totalBytes)}` : ''}
        </span>
        {active ? (
          <span
            className={`browser-download__progress ${progress === null ? 'is-indeterminate' : ''}`}
            role="progressbar"
            aria-label={`${download.fileName}下载进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress === null ? undefined : Math.round(progress)}
          >
            <i style={progress === null ? undefined : { width: `${progress}%` }} />
          </span>
        ) : null}
      </div>
      <div className="browser-download__actions">
        {download.state === 'progressing' ? (
          <IconButton label="暂停下载" disabled={pending} onClick={onPause}>
            <Pause size={13} aria-hidden="true" />
          </IconButton>
        ) : download.canResume &&
          (download.state === 'paused' || download.state === 'interrupted') ? (
          <IconButton label="继续下载" disabled={pending} onClick={onResume}>
            <Play size={13} aria-hidden="true" />
          </IconButton>
        ) : null}
        {active ? (
          <IconButton label="取消下载" disabled={pending} onClick={onCancel}>
            <X size={13} aria-hidden="true" />
          </IconButton>
        ) : null}
        {download.state === 'completed' ? (
          <IconButton label="在文件夹中显示" disabled={pending} onClick={onReveal}>
            <FolderOpen size={13} aria-hidden="true" />
          </IconButton>
        ) : null}
        {terminal ? (
          <IconButton label="移除下载记录" disabled={pending} onClick={onDismiss}>
            <Trash2 size={13} aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
    </article>
  );
}

function BrowserFallback({
  title,
  detail,
  loading = false,
}: {
  title: string;
  detail: string;
  loading?: boolean;
}) {
  return (
    <div className="browser-fallback">
      <span>
        {loading ? (
          <LoaderCircle className="spin" size={22} aria-hidden="true" />
        ) : (
          <ShieldCheck size={22} aria-hidden="true" />
        )}
      </span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
