import { describe, expect, it, vi } from 'vitest';
import type { BrowserSnapshot, BrowserTab } from '../src/shared/contracts';
import {
  activeBrowserTab,
  browserBookmarkForUrl,
  browserDownloadProgress,
  browserTabAtOffset,
  browserTabLabel,
  formatBrowserBytes,
  isBookmarkableBrowserUrl,
  isBrowserRequestLatest,
  isBrowserRevisionCurrent,
  isBrowserWorkspaceCurrent,
  openBrowserUrlInWorkspace,
  resolveBrowserAddress,
  shouldRevertBrowserAddress,
} from '../src/renderer/browser-state';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const TAB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('browser renderer state', () => {
  it('resolves addresses, local hosts, and searches without accepting active schemes', () => {
    expect(resolveBrowserAddress(' example.com/docs ')).toBe('https://example.com/docs');
    expect(resolveBrowserAddress('localhost:4173/health')).toBe('http://localhost:4173/health');
    expect(resolveBrowserAddress('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(resolveBrowserAddress('发布 检查')).toBe(
      'https://www.google.com/search?q=%E5%8F%91%E5%B8%83%20%E6%A3%80%E6%9F%A5',
    );
    expect(resolveBrowserAddress('')).toBe('https://www.google.com/');
    expect(() => resolveBrowserAddress('javascript:alert(1)')).toThrow(TypeError);
    expect(() => resolveBrowserAddress('file:///tmp/private')).toThrow(TypeError);
  });

  it('applies successful revisions monotonically while failures must be latest', () => {
    expect(isBrowserRevisionCurrent(4, 5)).toBe(false);
    expect(isBrowserRevisionCurrent(5, 5)).toBe(true);
    expect(isBrowserRevisionCurrent(6, 5)).toBe(true);
    expect(isBrowserRevisionCurrent(4, 3)).toBe(true);

    expect(isBrowserRequestLatest(4, 5)).toBe(false);
    expect(isBrowserRequestLatest(5, 5)).toBe(true);
    expect(isBrowserRequestLatest(6, 5)).toBe(false);
  });

  it('rejects inactive workspace snapshots and accepts a higher A revision after A→B→A', () => {
    const revisions = new Map<string, number>();
    let activeWorkspaceId = WORKSPACE_A;
    const apply = (snapshot: BrowserSnapshot) => {
      if (!isBrowserWorkspaceCurrent(activeWorkspaceId, snapshot)) return false;
      const previous = revisions.get(snapshot.workspaceId) ?? -1;
      if (!isBrowserRevisionCurrent(snapshot.revision, previous)) return false;
      revisions.set(snapshot.workspaceId, snapshot.revision);
      return true;
    };

    expect(apply(snapshot(WORKSPACE_A, 5))).toBe(true);
    activeWorkspaceId = WORKSPACE_B;
    expect(apply(snapshot(WORKSPACE_A, 6))).toBe(false);
    expect(apply(snapshot(WORKSPACE_B, 2))).toBe(true);
    activeWorkspaceId = WORKSPACE_A;
    expect(apply(snapshot(WORKSPACE_A, 6))).toBe(true);
    expect(apply(snapshot(WORKSPACE_A, 4))).toBe(false);
  });

  it('reverts a failed address only for the unchanged workspace, tab, and draft', () => {
    const attempt = {
      workspaceId: WORKSPACE_A,
      tabId: TAB_A,
      draftVersion: 7,
      url: 'https://example.com/submitted',
    };

    expect(
      shouldRevertBrowserAddress(attempt, {
        workspaceId: WORKSPACE_A,
        tabId: TAB_A,
        draftVersion: 7,
      }),
    ).toBe(true);
    expect(
      shouldRevertBrowserAddress(attempt, {
        workspaceId: WORKSPACE_B,
        tabId: TAB_A,
        draftVersion: 7,
      }),
    ).toBe(false);
    expect(
      shouldRevertBrowserAddress(attempt, {
        workspaceId: WORKSPACE_A,
        tabId: TAB_B,
        draftVersion: 7,
      }),
    ).toBe(false);
    expect(
      shouldRevertBrowserAddress(attempt, {
        workspaceId: WORKSPACE_A,
        tabId: TAB_A,
        draftVersion: 8,
      }),
    ).toBe(false);
  });

  it('finds the active tab, produces safe labels, and cycles with wraparound', () => {
    const first = tab(TAB_A, 'New tab', 'https://www.google.com/');
    const second = tab(TAB_B, '', 'https://example.com/path');
    const value = {
      ...snapshot(WORKSPACE_A, 1),
      activeTabId: TAB_B,
      tabs: [first, second],
    };

    expect(activeBrowserTab(value)).toBe(second);
    expect(browserTabLabel(first)).toBe('新标签页');
    expect(browserTabLabel(second)).toBe('example.com');
    expect(browserTabAtOffset(value.tabs, TAB_A, -1)).toBe(second);
    expect(browserTabAtOffset(value.tabs, TAB_B, 1)).toBe(first);
  });

  it('matches bookmarks exactly and derives bounded download progress', () => {
    const bookmarks = [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        url: 'https://example.com/path',
        title: 'Example',
        createdAt: '2026-07-22T12:00:00.000Z',
      },
    ] as const;
    expect(browserBookmarkForUrl(bookmarks, 'https://example.com/path')).toBe(bookmarks[0]);
    expect(browserBookmarkForUrl(bookmarks, 'https://example.com/')).toBeNull();
    expect(isBookmarkableBrowserUrl('https://example.com')).toBe(true);
    expect(isBookmarkableBrowserUrl('about:blank')).toBe(false);
    expect(
      browserDownloadProgress({
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        fileName: 'artifact.zip',
        sourceHost: 'example.com',
        mimeType: 'application/zip',
        receivedBytes: 75,
        totalBytes: 100,
        state: 'progressing',
        canResume: true,
        createdAt: '2026-07-22T12:00:00.000Z',
        updatedAt: '2026-07-22T12:00:00.000Z',
      }),
    ).toBe(75);
    expect(formatBrowserBytes(1_572_864)).toBe('1.5 MB');
  });

  it('activates the target workspace before opening a link and aborts after a stale switch', async () => {
    const order: string[] = [];
    const getSnapshot = vi.fn(async () => {
      order.push('get');
      return snapshot(WORKSPACE_A, 1);
    });
    const createTab = vi.fn(async () => {
      order.push('create');
      return snapshot(WORKSPACE_A, 2);
    });

    await expect(
      openBrowserUrlInWorkspace(
        { getSnapshot, createTab },
        WORKSPACE_A,
        'https://example.com/',
        () => true,
      ),
    ).resolves.toMatchObject({ revision: 2 });
    expect(order).toEqual(['get', 'create']);
    expect(createTab).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A,
      url: 'https://example.com/',
    });

    createTab.mockClear();
    await expect(
      openBrowserUrlInWorkspace(
        { getSnapshot, createTab },
        WORKSPACE_A,
        'https://example.com/stale',
        () => false,
      ),
    ).resolves.toBeNull();
    expect(createTab).not.toHaveBeenCalled();
  });
});

function snapshot(workspaceId: string, revision: number): BrowserSnapshot {
  return {
    workspaceId,
    revision,
    activeTabId: TAB_A,
    tabs: [tab(TAB_A, 'New tab', 'https://www.google.com/')],
    bookmarks: [],
    downloads: [],
  };
}

function tab(id: string, title: string, url: string): BrowserTab {
  return {
    id,
    title,
    url,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  };
}
