import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrowserBookmark,
  BrowserBounds,
  BrowserDownload,
  BrowserSnapshot,
} from '../../shared/contracts';
import {
  activeBrowserTab,
  isBrowserRequestLatest,
  isBrowserRevisionCurrent,
  isBrowserWorkspaceCurrent,
} from '../browser-state';

type BrowserControllerStatus = 'loading' | 'ready' | 'error';

export function useBrowserController(workspaceId: string) {
  const browserApi = window.workbench?.browser;
  const [storedSnapshot, setStoredSnapshot] = useState<BrowserSnapshot | null>(null);
  const [status, setStatus] = useState<BrowserControllerStatus>(browserApi ? 'loading' : 'error');
  const [loadError, setLoadError] = useState<string | null>(
    browserApi ? null : '桌面浏览器桥接不可用，请重新启动应用。',
  );
  const [operationErrorState, setOperationErrorState] = useState<{
    readonly workspaceId: string;
    readonly message: string;
  } | null>(null);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [focusAddressRequest, setFocusAddressRequest] = useState(0);
  const activeWorkspaceRef = useRef(workspaceId);
  const requestSequenceRef = useRef(0);
  const latestRequestSequenceRef = useRef(new Map<string, number>());
  const appliedRevisionRef = useRef(new Map<string, number>());
  const pendingKeysRef = useRef(new Set<string>());

  const beginRequest = useCallback((targetWorkspaceId: string): number => {
    const sequence = ++requestSequenceRef.current;
    latestRequestSequenceRef.current.set(targetWorkspaceId, sequence);
    return sequence;
  }, []);

  const applySnapshot = useCallback((snapshot: BrowserSnapshot): boolean => {
    if (!isBrowserWorkspaceCurrent(activeWorkspaceRef.current, snapshot)) return false;
    const lastApplied = appliedRevisionRef.current.get(snapshot.workspaceId) ?? -1;
    if (!isBrowserRevisionCurrent(snapshot.revision, lastApplied)) return false;
    appliedRevisionRef.current.set(snapshot.workspaceId, snapshot.revision);
    setStoredSnapshot(snapshot);
    setStatus('ready');
    setLoadError(null);
    return true;
  }, []);

  const load = useCallback(
    async (targetWorkspaceId: string): Promise<void> => {
      if (!browserApi) return;
      const sequence = beginRequest(targetWorkspaceId);
      if (activeWorkspaceRef.current === targetWorkspaceId) {
        setStatus('loading');
        setLoadError(null);
      }
      try {
        applySnapshot(await browserApi.getSnapshot({ workspaceId: targetWorkspaceId }));
      } catch (error) {
        const latestRequested = latestRequestSequenceRef.current.get(targetWorkspaceId) ?? -1;
        if (
          isBrowserRequestLatest(sequence, latestRequested) &&
          activeWorkspaceRef.current === targetWorkspaceId
        ) {
          setStoredSnapshot(null);
          setStatus('error');
          setLoadError(toMessage(error, '浏览器状态暂时无法读取。'));
        }
      }
    },
    [applySnapshot, beginRequest, browserApi],
  );

  useEffect(() => {
    activeWorkspaceRef.current = workspaceId;
    void load(workspaceId);
  }, [load, workspaceId]);

  useEffect(() => {
    if (!browserApi) return;
    const unsubscribeState = browserApi.onStateChange(applySnapshot);
    const unsubscribeFocus = browserApi.onFocusAddressRequest(() => {
      setFocusAddressRequest((request) => request + 1);
    });
    return () => {
      unsubscribeState();
      unsubscribeFocus();
    };
  }, [applySnapshot, browserApi]);

  const beginPending = useCallback((key: string): boolean => {
    if (pendingKeysRef.current.has(key)) return false;
    pendingKeysRef.current = new Set(pendingKeysRef.current).add(key);
    setPendingKeys(pendingKeysRef.current);
    return true;
  }, []);

  const endPending = useCallback((key: string): void => {
    const next = new Set(pendingKeysRef.current);
    next.delete(key);
    pendingKeysRef.current = next;
    setPendingKeys(next);
  }, []);

  const runSnapshotAction = useCallback(
    async (
      key: string,
      fallback: string,
      action: (targetWorkspaceId: string) => Promise<BrowserSnapshot>,
    ): Promise<BrowserSnapshot> => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (!browserApi) throw new Error('桌面浏览器桥接不可用。');
      if (!beginPending(`${targetWorkspaceId}:${key}`)) {
        throw new Error('这项浏览器操作正在进行。');
      }
      const pendingKey = `${targetWorkspaceId}:${key}`;
      const sequence = beginRequest(targetWorkspaceId);
      setOperationErrorState(null);
      try {
        const snapshot = await action(targetWorkspaceId);
        applySnapshot(snapshot);
        return snapshot;
      } catch (error) {
        const message = toMessage(error, fallback);
        const latestRequested = latestRequestSequenceRef.current.get(targetWorkspaceId) ?? -1;
        if (
          isBrowserRequestLatest(sequence, latestRequested) &&
          activeWorkspaceRef.current === targetWorkspaceId
        ) {
          setOperationErrorState({ workspaceId: targetWorkspaceId, message });
        }
        throw new Error(message, { cause: error });
      } finally {
        endPending(pendingKey);
      }
    },
    [applySnapshot, beginPending, beginRequest, browserApi, endPending],
  );

  const snapshot = storedSnapshot?.workspaceId === workspaceId ? storedSnapshot : null;
  const activeTab = useMemo(() => activeBrowserTab(snapshot), [snapshot]);

  const tabAction = useCallback(
    (
      action:
        'activateTab' | 'closeTab' | 'back' | 'forward' | 'reload' | 'stop' | 'toggleBookmark',
      tabId: string,
      fallback: string,
    ) =>
      runSnapshotAction(`tab:${tabId}`, fallback, (targetWorkspaceId) =>
        browserApi![action]({ workspaceId: targetWorkspaceId, tabId }),
      ),
    [browserApi, runSnapshotAction],
  );

  const downloadAction = useCallback(
    (
      action:
        | 'pauseDownload'
        | 'resumeDownload'
        | 'cancelDownload'
        | 'dismissDownload'
        | 'revealDownload',
      downloadId: string,
      fallback: string,
    ) =>
      runSnapshotAction(`download:${downloadId}`, fallback, (targetWorkspaceId) =>
        browserApi![action]({ workspaceId: targetWorkspaceId, downloadId }),
      ),
    [browserApi, runSnapshotAction],
  );

  const reportViewFailure = useCallback(
    (error: unknown, fallback: string) => {
      const targetWorkspaceId = activeWorkspaceRef.current;
      if (targetWorkspaceId === workspaceId) {
        setOperationErrorState({
          workspaceId: targetWorkspaceId,
          message: toMessage(error, fallback),
        });
      }
    },
    [workspaceId],
  );

  const setBounds = useCallback(
    async (bounds: BrowserBounds): Promise<boolean> => {
      if (!browserApi) return false;
      try {
        await browserApi.setBounds({ workspaceId, bounds });
        return true;
      } catch (error) {
        reportViewFailure(error, '浏览器视图尺寸同步失败。');
        return false;
      }
    },
    [browserApi, reportViewFailure, workspaceId],
  );

  const setVisible = useCallback(
    async (visible: boolean): Promise<boolean> => {
      if (!browserApi) return false;
      try {
        await browserApi.setVisible({ workspaceId, visible });
        return true;
      } catch (error) {
        reportViewFailure(error, '浏览器视图显示状态同步失败。');
        return false;
      }
    },
    [browserApi, reportViewFailure, workspaceId],
  );

  return {
    bridgeAvailable: Boolean(browserApi),
    snapshot,
    activeTab,
    status: snapshot ? ('ready' as const) : status,
    loadError,
    operationError:
      operationErrorState?.workspaceId === workspaceId ? operationErrorState.message : null,
    pendingKeys,
    isPending: (key: string) => pendingKeys.has(`${workspaceId}:${key}`),
    focusAddressRequest,
    retry: () => void load(workspaceId),
    clearOperationError: () => setOperationErrorState(null),
    requestAddressFocus: () => setFocusAddressRequest((request) => request + 1),
    createTab: (url?: string) =>
      runSnapshotAction('create-tab', '无法新建标签页。', (targetWorkspaceId) =>
        browserApi!.createTab({
          workspaceId: targetWorkspaceId,
          ...(url ? { url } : {}),
        }),
      ),
    activateTab: (tabId: string) => tabAction('activateTab', tabId, '无法切换标签页。'),
    closeTab: (tabId: string) => tabAction('closeTab', tabId, '无法关闭标签页。'),
    navigate: (tabId: string, url: string) =>
      runSnapshotAction(`tab:${tabId}`, '网页暂时无法打开。', (targetWorkspaceId) =>
        browserApi!.navigate({ workspaceId: targetWorkspaceId, tabId, url }),
      ),
    back: (tabId: string) => tabAction('back', tabId, '无法后退。'),
    forward: (tabId: string) => tabAction('forward', tabId, '无法前进。'),
    reload: (tabId: string) => tabAction('reload', tabId, '无法刷新网页。'),
    stop: (tabId: string) => tabAction('stop', tabId, '无法停止加载。'),
    toggleBookmark: (tabId: string) => tabAction('toggleBookmark', tabId, '无法更新收藏。'),
    removeBookmark: (bookmark: Pick<BrowserBookmark, 'id'>) =>
      runSnapshotAction(`bookmark:${bookmark.id}`, '无法移除收藏。', (targetWorkspaceId) =>
        browserApi!.removeBookmark({
          workspaceId: targetWorkspaceId,
          bookmarkId: bookmark.id,
        }),
      ),
    openBookmark: (bookmark: Pick<BrowserBookmark, 'id'>, newTab: boolean) =>
      runSnapshotAction(`bookmark:${bookmark.id}`, '无法打开收藏。', (targetWorkspaceId) =>
        browserApi!.openBookmark({
          workspaceId: targetWorkspaceId,
          bookmarkId: bookmark.id,
          newTab,
        }),
      ),
    pauseDownload: (download: Pick<BrowserDownload, 'id'>) =>
      downloadAction('pauseDownload', download.id, '无法暂停下载。'),
    resumeDownload: (download: Pick<BrowserDownload, 'id'>) =>
      downloadAction('resumeDownload', download.id, '无法继续下载。'),
    cancelDownload: (download: Pick<BrowserDownload, 'id'>) =>
      downloadAction('cancelDownload', download.id, '无法取消下载。'),
    dismissDownload: (download: Pick<BrowserDownload, 'id'>) =>
      downloadAction('dismissDownload', download.id, '无法移除下载记录。'),
    revealDownload: (download: Pick<BrowserDownload, 'id'>) =>
      downloadAction('revealDownload', download.id, '无法在文件夹中显示下载。'),
    setBounds,
    setVisible,
  };
}

function toMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || error.message.trim().length === 0) return fallback;
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || fallback;
}
