import type {
  BrowserBookmark,
  BrowserDownload,
  BrowserSnapshot,
  BrowserTab,
  WorkbenchApi,
} from '../shared/contracts';

export const DEFAULT_BROWSER_URL = 'https://www.google.com/';

const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const LOCAL_HOST_PATTERN = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/.*)?$/iu;

export interface BrowserAddressNavigationAttempt {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly draftVersion: number;
  readonly url: string;
}

export function resolveBrowserAddress(input: string): string {
  const value = input.trim();
  if (!value) return DEFAULT_BROWSER_URL;

  if (LOCAL_HOST_PATTERN.test(value)) return `http://${value}`;

  if (EXPLICIT_SCHEME_PATTERN.test(value)) {
    if (!/^https?:/iu.test(value) && value.toLocaleLowerCase() !== 'about:blank') {
      throw new TypeError('只支持 HTTP 或 HTTPS 网址。');
    }
    return value;
  }

  if (value.includes('.') && !/\s/u.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

export function isBrowserRevisionCurrent(revision: number, lastAppliedRevision: number): boolean {
  return (
    Number.isSafeInteger(revision) &&
    revision >= 0 &&
    Number.isSafeInteger(lastAppliedRevision) &&
    revision >= lastAppliedRevision
  );
}

export function isBrowserRequestLatest(sequence: number, latestRequestedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function shouldRevertBrowserAddress(
  attempt: BrowserAddressNavigationAttempt,
  current: {
    readonly workspaceId: string;
    readonly tabId: string | null;
    readonly draftVersion: number;
  },
): boolean {
  return (
    attempt.workspaceId === current.workspaceId &&
    attempt.tabId === current.tabId &&
    attempt.draftVersion === current.draftVersion
  );
}

export function isBrowserWorkspaceCurrent(
  workspaceId: string | null,
  snapshot: BrowserSnapshot,
): boolean {
  return workspaceId !== null && snapshot.workspaceId === workspaceId;
}

export function activeBrowserTab(snapshot: BrowserSnapshot | null): BrowserTab | null {
  if (!snapshot) return null;
  return snapshot.tabs.find(({ id }) => id === snapshot.activeTabId) ?? null;
}

export function browserTabLabel(tab: Pick<BrowserTab, 'title' | 'url'>): string {
  const title = tab.title.trim();
  if (title.toLocaleLowerCase() === 'new tab') return '新标签页';
  if (title) return title;
  if (tab.url === 'about:blank') return '新标签页';
  try {
    return new URL(tab.url).hostname || '新标签页';
  } catch {
    return '新标签页';
  }
}

export function browserTabAtOffset(
  tabs: readonly BrowserTab[],
  activeTabId: string,
  offset: -1 | 1,
): BrowserTab | null {
  if (tabs.length === 0) return null;
  const activeIndex = tabs.findIndex(({ id }) => id === activeTabId);
  const index = activeIndex < 0 ? 0 : (activeIndex + offset + tabs.length) % tabs.length;
  return tabs[index] ?? null;
}

export function browserBookmarkForUrl(
  bookmarks: readonly BrowserBookmark[],
  url: string,
): BrowserBookmark | null {
  return bookmarks.find((bookmark) => bookmark.url === url) ?? null;
}

export function isBookmarkableBrowserUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function browserDownloadProgress(download: BrowserDownload): number | null {
  if (download.totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, (download.receivedBytes / download.totalBytes) * 100));
}

export function formatBrowserBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** unitIndex;
  return `${amount >= 10 || unitIndex === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unitIndex]}`;
}

export async function openBrowserUrlInWorkspace(
  browserApi: Pick<WorkbenchApi['browser'], 'getSnapshot' | 'createTab'>,
  workspaceId: string,
  url: string,
  isWorkspaceCurrent: () => boolean,
): Promise<BrowserSnapshot | null> {
  await browserApi.getSnapshot({ workspaceId });
  if (!isWorkspaceCurrent()) return null;
  return browserApi.createTab({ workspaceId, url });
}
