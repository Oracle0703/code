import { EventEmitter } from 'node:events';
import type { DownloadItem, Event, Session, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { DownloadManager } from '../src/main/downloads/download-manager';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const DOWNLOAD_IDS = [
  '21111111-1111-4111-8111-111111111111',
  '31111111-1111-4111-8111-111111111111',
  '41111111-1111-4111-8111-111111111111',
  '51111111-1111-4111-8111-111111111111',
  '61111111-1111-4111-8111-111111111111',
  '71111111-1111-4111-8111-111111111111',
];

class FakeDownloadItem extends EventEmitter {
  userGesture = true;
  paused = false;
  resumable = true;
  receivedBytes = 0;
  totalBytes = 100;
  savePath = '/tmp/downloads/report.txt';
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly resume = vi.fn(() => {
    this.paused = false;
  });
  readonly cancel = vi.fn();
  readonly setSaveDialogOptions = vi.fn();

  hasUserGesture() {
    return this.userGesture;
  }
  getFilename() {
    return '../../report.txt';
  }
  getURLChain() {
    return ['https://example.com/file?secret=yes'];
  }
  getMimeType() {
    return 'text/plain\u202e.exe';
  }
  getReceivedBytes() {
    return this.receivedBytes;
  }
  getTotalBytes() {
    return this.totalBytes;
  }
  isPaused() {
    return this.paused;
  }
  canResume() {
    return this.resumable;
  }
  getSavePath() {
    return this.savePath;
  }
}

function createHarness(options?: {
  ids?: string[];
  now?: () => Date;
  source?: object;
  statPath?: () => Promise<{
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  revealPath?: (path: string) => void;
}) {
  const session = new EventEmitter();
  const source = options?.source ?? {};
  const ids = [...(options?.ids ?? DOWNLOAD_IDS)];
  const changes: string[] = [];
  const snapshotSizes: number[] = [];
  const revealPath = vi.fn(options?.revealPath);
  const manager: DownloadManager = new DownloadManager({
    session: session as unknown as Pick<Session, 'on' | 'removeListener'>,
    downloadsDirectory: '/tmp/downloads',
    resolveSource: (contents) =>
      contents === (source as WebContents) ? { workspaceId: WORKSPACE_ID } : null,
    onChange: (workspaceId) => {
      changes.push(workspaceId);
      snapshotSizes.push(manager.getDownloads(workspaceId).length);
    },
    revealPath,
    idFactory: () => ids.shift() ?? DOWNLOAD_IDS[0],
    now: options?.now,
    statPath: vi.fn(
      options?.statPath ??
        (async () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
        })),
    ) as never,
  });
  return {
    manager,
    session,
    source: source as WebContents,
    changes,
    snapshotSizes,
    revealPath,
  };
}

function beginDownload(session: EventEmitter, source: WebContents, item = new FakeDownloadItem()) {
  const preventDefault = vi.fn();
  session.emit(
    'will-download',
    { preventDefault } as unknown as Event,
    item as unknown as DownloadItem,
    source,
  );
  return { item, preventDefault };
}

describe('DownloadManager', () => {
  it('accepts only a managed, user-initiated item and configures its native save dialog', () => {
    const { manager, session, source } = createHarness();
    const accepted = beginDownload(session, source);
    expect(accepted.preventDefault).not.toHaveBeenCalled();
    expect(accepted.item.setSaveDialogOptions).toHaveBeenCalledWith({
      defaultPath: '/tmp/downloads/report.txt',
    });
    expect(manager.getDownloads(WORKSPACE_ID)[0]).toMatchObject({
      id: DOWNLOAD_IDS[0],
      fileName: 'report.txt',
      sourceHost: 'example.com',
      mimeType: 'text/plain.exe',
      state: 'progressing',
    });

    const untrusted = beginDownload(session, {} as WebContents);
    expect(untrusted.preventDefault).toHaveBeenCalledTimes(1);
    const withoutGesture = new FakeDownloadItem();
    withoutGesture.userGesture = false;
    expect(beginDownload(session, source, withoutGesture).preventDefault).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it('rejects invalid or duplicate ids and an invalid initial clock', () => {
    const duplicate = createHarness({ ids: [DOWNLOAD_IDS[0], DOWNLOAD_IDS[0]] });
    expect(
      beginDownload(duplicate.session, duplicate.source).preventDefault,
    ).not.toHaveBeenCalled();
    expect(beginDownload(duplicate.session, duplicate.source).preventDefault).toHaveBeenCalled();
    duplicate.manager.destroy();

    const invalidId = createHarness({ ids: ['../../id'] });
    expect(beginDownload(invalidId.session, invalidId.source).preventDefault).toHaveBeenCalled();
    invalidId.manager.destroy();

    const invalidClock = createHarness({ now: () => new Date(Number.NaN) });
    expect(
      beginDownload(invalidClock.session, invalidClock.source).preventDefault,
    ).toHaveBeenCalled();
    invalidClock.manager.destroy();
  });

  it('enforces the active download limit', () => {
    const { manager, session, source } = createHarness();
    for (let index = 0; index < 5; index += 1) {
      expect(beginDownload(session, source).preventDefault).not.toHaveBeenCalled();
    }
    expect(beginDownload(session, source).preventDefault).toHaveBeenCalledTimes(1);
    manager.destroy();
  });

  it('controls pause, resume, completion, reveal and dismissal without exposing paths', async () => {
    const { manager, session, source, revealPath } = createHarness();
    const { item } = beginDownload(session, source);
    const id = DOWNLOAD_IDS[0];
    manager.pause(WORKSPACE_ID, id);
    expect(item.pause).toHaveBeenCalledTimes(1);
    expect(manager.getDownloads(WORKSPACE_ID)[0]?.state).toBe('paused');
    manager.resume(WORKSPACE_ID, id);
    expect(item.resume).toHaveBeenCalledTimes(1);
    item.receivedBytes = 100;
    item.emit('done', {} as Event, 'completed');
    expect(manager.getDownloads(WORKSPACE_ID)[0]).toMatchObject({
      state: 'completed',
      receivedBytes: 100,
      fileName: 'report.txt',
    });
    expect(JSON.stringify(manager.getDownloads(WORKSPACE_ID))).not.toContain('/tmp/downloads');
    await manager.reveal(WORKSPACE_ID, id);
    expect(revealPath).toHaveBeenCalledWith('/tmp/downloads/report.txt');
    manager.dismiss(WORKSPACE_ID, id);
    expect(manager.getDownloads(WORKSPACE_ID)).toEqual([]);
    manager.destroy();
  });

  it('keeps filesystem and shell error paths out of reveal rejections', async () => {
    const secretPath = '/home/alice/private/customer-report.txt';
    const statFailure = createHarness({
      statPath: async () => {
        throw new Error(`ENOENT: no such file or directory, lstat '${secretPath}'`);
      },
    });
    const statItem = beginDownload(statFailure.session, statFailure.source).item;
    statItem.savePath = secretPath;
    statItem.emit('done', {} as Event, 'completed');

    const statError = await statFailure.manager
      .reveal(WORKSPACE_ID, DOWNLOAD_IDS[0])
      .catch((error: unknown) => error);
    expect(statError).toBeInstanceOf(Error);
    expect((statError as Error).message).toBe('The downloaded file is no longer available');
    expect((statError as Error).message).not.toContain(secretPath);
    expect(statFailure.revealPath).not.toHaveBeenCalled();
    statFailure.manager.destroy();

    const shellFailure = createHarness({
      revealPath: (path) => {
        throw new Error(`Failed to reveal ${path}`);
      },
    });
    const shellItem = beginDownload(shellFailure.session, shellFailure.source).item;
    shellItem.savePath = secretPath;
    shellItem.emit('done', {} as Event, 'completed');

    const shellError = await shellFailure.manager
      .reveal(WORKSPACE_ID, DOWNLOAD_IDS[0])
      .catch((error: unknown) => error);
    expect(shellError).toBeInstanceOf(Error);
    expect((shellError as Error).message).toBe('The downloaded file could not be revealed');
    expect((shellError as Error).message).not.toContain(secretPath);
    shellFailure.manager.destroy();
  });

  it('rejects relative, symbolic-link, and cross-workspace reveal targets', async () => {
    const relative = createHarness();
    const relativeItem = beginDownload(relative.session, relative.source).item;
    relativeItem.savePath = 'relative/report.txt';
    relativeItem.emit('done', {} as Event, 'completed');
    await expect(relative.manager.reveal(WORKSPACE_ID, DOWNLOAD_IDS[0])).rejects.toThrow(
      /completed local download/u,
    );
    expect(relative.revealPath).not.toHaveBeenCalled();
    relative.manager.destroy();

    const symbolicLink = createHarness({
      statPath: async () => ({
        isFile: () => true,
        isSymbolicLink: () => true,
      }),
    });
    const linkItem = beginDownload(symbolicLink.session, symbolicLink.source).item;
    linkItem.emit('done', {} as Event, 'completed');
    await expect(symbolicLink.manager.reveal(WORKSPACE_ID, DOWNLOAD_IDS[0])).rejects.toThrow(
      /regular file/u,
    );
    expect(symbolicLink.revealPath).not.toHaveBeenCalled();

    await expect(
      symbolicLink.manager.reveal('22222222-2222-4222-8222-222222222222', DOWNLOAD_IDS[0]),
    ).rejects.toThrow(/not found in this workspace/u);
    expect(symbolicLink.revealPath).not.toHaveBeenCalled();
    symbolicLink.manager.destroy();
  });

  it('prunes before notifying and keeps the newest 100 terminal records under a frozen clock', () => {
    const ids = Array.from({ length: 101 }, (_, index) => generatedDownloadId(index));
    const harness = createHarness({
      ids,
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });

    for (let index = 0; index < ids.length; index += 1) {
      const item = beginDownload(harness.session, harness.source).item;
      item.savePath = `/tmp/downloads/report-${index}.txt`;
      item.emit('done', {} as Event, 'completed');
    }

    const downloads = harness.manager.getDownloads(WORKSPACE_ID);
    expect(downloads).toHaveLength(100);
    expect(downloads.map(({ id }) => id)).toContain(ids.at(-1));
    expect(downloads.map(({ id }) => id)).not.toContain(ids[0]);
    expect(harness.snapshotSizes.at(-1)).toBe(100);
    harness.manager.destroy();
  });

  it('notifies another workspace when global pruning removes one of its records', () => {
    const workspaceB = '22222222-2222-4222-8222-222222222222';
    const sourceA = {} as WebContents;
    const sourceB = {} as WebContents;
    const ids = Array.from({ length: 101 }, (_, index) => generatedDownloadId(index));
    const session = new EventEmitter();
    const changes: string[] = [];
    const manager = new DownloadManager({
      session: session as unknown as Pick<Session, 'on' | 'removeListener'>,
      downloadsDirectory: '/tmp/downloads',
      resolveSource: (contents) =>
        contents === sourceA
          ? { workspaceId: WORKSPACE_ID }
          : contents === sourceB
            ? { workspaceId: workspaceB }
            : null,
      onChange: (workspaceId) => changes.push(workspaceId),
      revealPath: vi.fn(),
      idFactory: () => ids.shift() ?? DOWNLOAD_IDS[0],
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });

    beginDownload(session, sourceB).item.emit('done', {} as Event, 'completed');
    for (let index = 0; index < 99; index += 1) {
      beginDownload(session, sourceA).item.emit('done', {} as Event, 'completed');
    }
    changes.length = 0;
    beginDownload(session, sourceA).item.emit('done', {} as Event, 'completed');

    expect(manager.getDownloads(workspaceB)).toEqual([]);
    expect(changes).toEqual([WORKSPACE_ID, WORKSPACE_ID, workspaceB]);
    manager.destroy();
  });

  it('clears an archived workspace and releases its active download slots', () => {
    const workspaceB = '22222222-2222-4222-8222-222222222222';
    const sourceA = {} as WebContents;
    const sourceB = {} as WebContents;
    const ids = Array.from({ length: 7 }, (_, index) => generatedDownloadId(index));
    const session = new EventEmitter();
    const manager = new DownloadManager({
      session: session as unknown as Pick<Session, 'on' | 'removeListener'>,
      downloadsDirectory: '/tmp/downloads',
      resolveSource: (contents) =>
        contents === sourceA
          ? { workspaceId: WORKSPACE_ID }
          : contents === sourceB
            ? { workspaceId: workspaceB }
            : null,
      onChange: vi.fn(),
      revealPath: vi.fn(),
      idFactory: () => ids.shift() ?? DOWNLOAD_IDS[0],
    });

    const terminal = beginDownload(session, sourceA).item;
    terminal.emit('done', {} as Event, 'completed');
    const active = Array.from({ length: 5 }, () => beginDownload(session, sourceA).item);
    expect(beginDownload(session, sourceB).preventDefault).toHaveBeenCalledTimes(1);

    manager.clearWorkspace(WORKSPACE_ID);

    expect(manager.getDownloads(WORKSPACE_ID)).toEqual([]);
    for (const item of active) expect(item.cancel).toHaveBeenCalledTimes(1);
    expect(terminal.cancel).not.toHaveBeenCalled();
    expect(beginDownload(session, sourceB).preventDefault).not.toHaveBeenCalled();
    manager.destroy();
  });

  it('continues native cleanup when one active download throws during cancellation', () => {
    const harness = createHarness();
    const first = beginDownload(harness.session, harness.source).item;
    const second = beginDownload(harness.session, harness.source).item;
    first.cancel.mockImplementationOnce(() => {
      throw new Error('native item disappeared');
    });

    expect(() => harness.manager.destroy()).not.toThrow();

    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(second.cancel).toHaveBeenCalledTimes(1);
    expect(first.listenerCount('updated')).toBe(0);
    expect(first.listenerCount('done')).toBe(0);
    expect(second.listenerCount('updated')).toBe(0);
    expect(second.listenerCount('done')).toBe(0);
    expect(harness.session.listenerCount('will-download')).toBe(0);
    expect(harness.manager.getDownloads(WORKSPACE_ID)).toEqual([]);
  });

  it('clamps clock rollback and cancels active items during cleanup', () => {
    const timestamps = [new Date('2026-07-22T12:00:00.000Z'), new Date('2026-07-22T11:00:00.000Z')];
    const { manager, session, source } = createHarness({
      now: () => timestamps.shift() ?? new Date('2026-07-22T11:00:00.000Z'),
    });
    const { item } = beginDownload(session, source);
    item.emit('updated', {} as Event, 'progressing');
    expect(manager.getDownloads(WORKSPACE_ID)[0]?.updatedAt).toBe('2026-07-22T12:00:00.000Z');
    manager.destroy();
    expect(item.cancel).toHaveBeenCalledTimes(1);
  });
});

function generatedDownloadId(index: number): string {
  return `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
}
