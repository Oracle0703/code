import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { DownloadItem, Event, Session, WebContents } from 'electron';
import type { BrowserDownload } from '../../shared/contracts';
import { normalizeBrowserId } from '../../shared/browser-domain';
import {
  createDownloadDefaultPath,
  getDownloadSourceHost,
  getSafeDownloadFileName,
  sanitizeDownloadDisplayText,
  sanitizeDownloadFileName,
} from './download-security';
import {
  deriveDoneDownloadState,
  deriveUpdatedDownloadState,
  isTerminalDownloadState,
  normalizeDownloadByteCount,
  type DownloadDoneState,
  type DownloadUpdatedState,
} from './download-state';

const MAX_ACTIVE_DOWNLOADS = 5;
const MAX_DOWNLOAD_HISTORY = 100;
const PROGRESS_NOTIFICATION_INTERVAL_MS = 100;

export interface ManagedDownloadSource {
  readonly workspaceId: string;
}

export interface DownloadManagerOptions {
  readonly session: Pick<Session, 'on' | 'removeListener'>;
  readonly downloadsDirectory: string;
  readonly resolveSource: (contents: WebContents) => ManagedDownloadSource | null;
  readonly onChange: (workspaceId: string) => void;
  readonly revealPath: (path: string) => void;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly statPath?: typeof lstat;
}

interface ManagedDownload {
  readonly id: string;
  readonly workspaceId: string;
  readonly item: DownloadItem;
  readonly updatedListener: (event: Event, state: DownloadUpdatedState) => void;
  readonly doneListener: (event: Event, state: DownloadDoneState) => void;
  publicValue: BrowserDownload;
  savePath: string;
  sequence: number;
  notificationTimer: ReturnType<typeof setTimeout> | undefined;
}

export class DownloadManager {
  readonly #session;
  readonly #downloadsDirectory;
  readonly #resolveSource;
  readonly #onChange;
  readonly #revealPath;
  readonly #idFactory;
  readonly #now;
  readonly #statPath;
  readonly #downloads = new Map<string, ManagedDownload>();
  #nextSequence = 0;
  #destroyed = false;

  readonly #handleDownload = (event: Event, item: DownloadItem, contents: WebContents): void => {
    const source = this.#resolveSource(contents);
    if (
      this.#destroyed ||
      !source ||
      !item.hasUserGesture() ||
      this.#activeDownloadCount() >= MAX_ACTIVE_DOWNLOADS
    ) {
      event.preventDefault();
      return;
    }

    let id: string;
    let createdAt: string;
    let suggestedName: string;
    let sourceHost: string;
    let mimeType: string;
    try {
      id = normalizeBrowserId(this.#idFactory());
      if (this.#downloads.has(id)) {
        throw new TypeError('The download id is already in use');
      }
      createdAt = this.#readTimestamp();
      suggestedName = sanitizeDownloadFileName(item.getFilename());
      sourceHost = getDownloadSourceHost(item.getURLChain());
      mimeType = normalizeMimeType(item.getMimeType());
      item.setSaveDialogOptions({
        defaultPath: createDownloadDefaultPath(this.#downloadsDirectory, suggestedName),
      });
    } catch {
      event.preventDefault();
      return;
    }

    const updatedListener = (_event: Event, state: DownloadUpdatedState): void => {
      this.#handleUpdated(id, state);
    };
    const doneListener = (_event: Event, state: DownloadDoneState): void => {
      this.#handleDone(id, state);
    };
    const managed: ManagedDownload = {
      id,
      workspaceId: source.workspaceId,
      item,
      updatedListener,
      doneListener,
      publicValue: {
        id,
        fileName: suggestedName,
        sourceHost,
        mimeType,
        receivedBytes: normalizeDownloadByteCount(item.getReceivedBytes()),
        totalBytes: normalizeDownloadByteCount(item.getTotalBytes()),
        state: 'progressing',
        canResume: false,
        createdAt,
        updatedAt: createdAt,
      },
      savePath: '',
      sequence: this.#takeSequence(),
      notificationTimer: undefined,
    };

    this.#downloads.set(id, managed);
    item.on('updated', updatedListener);
    item.once('done', doneListener);
    this.#notifyWorkspaceChanges(source.workspaceId, this.#pruneHistory());
  };

  public constructor(options: DownloadManagerOptions) {
    this.#session = options.session;
    this.#downloadsDirectory = options.downloadsDirectory;
    this.#resolveSource = options.resolveSource;
    this.#onChange = options.onChange;
    this.#revealPath = options.revealPath;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? (() => new Date());
    this.#statPath = options.statPath ?? lstat;
    this.#session.on('will-download', this.#handleDownload);
  }

  public getDownloads(workspaceId: string): readonly BrowserDownload[] {
    return [...this.#downloads.values()]
      .filter((download) => download.workspaceId === workspaceId)
      .sort((left, right) => {
        const byCreationTime = right.publicValue.createdAt.localeCompare(
          left.publicValue.createdAt,
        );
        return byCreationTime || right.sequence - left.sequence;
      })
      .map(({ publicValue }) => ({ ...publicValue }));
  }

  public clearWorkspace(workspaceId: string): void {
    for (const download of [...this.#downloads.values()]) {
      if (download.workspaceId !== workspaceId) continue;
      const shouldCancel = !isTerminalDownloadState(download.publicValue.state);
      this.#disposeDownload(download);
      this.#downloads.delete(download.id);
      if (shouldCancel) {
        try {
          download.item.cancel();
        } catch {
          // Continue releasing the unreachable runtime record.
        }
      }
    }
  }

  public pause(workspaceId: string, downloadId: string): void {
    const download = this.#getOwnedDownload(workspaceId, downloadId);
    if (download.publicValue.state !== 'progressing') {
      throw new Error('Only a progressing download can be paused');
    }
    download.item.pause();
    this.#updatePublicValue(download, { state: 'paused', canResume: download.item.canResume() });
    this.#notifyImmediately(download);
  }

  public resume(workspaceId: string, downloadId: string): void {
    const download = this.#getOwnedDownload(workspaceId, downloadId);
    if (
      (download.publicValue.state !== 'paused' && download.publicValue.state !== 'interrupted') ||
      !download.item.canResume()
    ) {
      throw new Error('The download cannot be resumed');
    }
    download.item.resume();
    this.#updatePublicValue(download, { state: 'progressing', canResume: false });
    this.#notifyImmediately(download);
  }

  public cancel(workspaceId: string, downloadId: string): void {
    const download = this.#getOwnedDownload(workspaceId, downloadId);
    if (isTerminalDownloadState(download.publicValue.state)) {
      return;
    }
    download.item.cancel();
    this.#updatePublicValue(download, { state: 'cancelled', canResume: false });
    this.#notifyImmediately(download);
  }

  public dismiss(workspaceId: string, downloadId: string): void {
    const download = this.#getOwnedDownload(workspaceId, downloadId);
    if (!isTerminalDownloadState(download.publicValue.state)) {
      throw new Error('An active download cannot be dismissed');
    }
    this.#disposeDownload(download);
    this.#downloads.delete(download.id);
    this.#onChange(workspaceId);
  }

  public async reveal(
    workspaceId: string,
    downloadId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<void> {
    const download = this.#getOwnedDownload(workspaceId, downloadId);
    if (
      download.publicValue.state !== 'completed' ||
      !isAbsolute(download.savePath) ||
      download.savePath.includes('\0')
    ) {
      throw new Error('Only a completed local download can be revealed');
    }

    let isRegularFile: boolean;
    try {
      const stats = await this.#statPath(download.savePath);
      isRegularFile = stats.isFile() && !stats.isSymbolicLink();
    } catch {
      throw new Error('The downloaded file is no longer available');
    }
    if (!isRegularFile) {
      throw new Error('The downloaded file is no longer a regular file');
    }
    assertCurrent();
    try {
      this.#revealPath(download.savePath);
    } catch {
      throw new Error('The downloaded file could not be revealed');
    }
    assertCurrent();
  }

  public destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    try {
      this.#session.removeListener('will-download', this.#handleDownload);
    } catch {
      // Continue releasing every native download even if the session is already tearing down.
    }
    for (const download of this.#downloads.values()) {
      if (!isTerminalDownloadState(download.publicValue.state)) {
        try {
          download.item.cancel();
        } catch {
          // A native DownloadItem can disappear during application shutdown.
        }
      }
      try {
        this.#disposeDownload(download);
      } catch {
        // Do not let one stale native listener prevent the remaining cleanup.
      }
    }
    this.#downloads.clear();
  }

  #handleUpdated(id: string, state: DownloadUpdatedState): void {
    const download = this.#downloads.get(id);
    if (!download || this.#destroyed || isTerminalDownloadState(download.publicValue.state)) {
      return;
    }

    this.#updatePublicValue(download, {
      ...deriveUpdatedDownloadState(state, download.item.isPaused(), download.item.canResume()),
      receivedBytes: normalizeDownloadByteCount(download.item.getReceivedBytes()),
      totalBytes: normalizeDownloadByteCount(download.item.getTotalBytes()),
    });
    this.#scheduleNotification(download);
  }

  #handleDone(id: string, state: DownloadDoneState): void {
    const download = this.#downloads.get(id);
    if (!download || this.#destroyed) {
      return;
    }

    download.savePath = state === 'completed' ? download.item.getSavePath() : '';
    this.#updatePublicValue(download, {
      fileName:
        state === 'completed'
          ? getSafeDownloadFileName(download.savePath, download.publicValue.fileName)
          : download.publicValue.fileName,
      receivedBytes: normalizeDownloadByteCount(download.item.getReceivedBytes()),
      totalBytes: normalizeDownloadByteCount(download.item.getTotalBytes()),
      state: deriveDoneDownloadState(state),
      canResume: false,
    });
    this.#notifyImmediately(download, this.#pruneHistory());
  }

  #updatePublicValue(download: ManagedDownload, patch: Partial<BrowserDownload>): void {
    download.sequence = this.#takeSequence();
    download.publicValue = {
      ...download.publicValue,
      ...patch,
      id: download.id,
      updatedAt: this.#readTimestamp(download.publicValue.updatedAt),
    };
  }

  #readTimestamp(lowerBound?: string): string {
    const value = this.#now();
    const time = value.getTime();
    if (!Number.isFinite(time)) {
      if (lowerBound) return lowerBound;
      throw new TypeError('The download clock returned an invalid date');
    }
    const timestamp = value.toISOString();
    return lowerBound && timestamp < lowerBound ? lowerBound : timestamp;
  }

  #scheduleNotification(download: ManagedDownload): void {
    if (download.notificationTimer || this.#destroyed) {
      return;
    }
    download.notificationTimer = setTimeout(() => {
      download.notificationTimer = undefined;
      if (!this.#destroyed && this.#downloads.has(download.id)) {
        this.#onChange(download.workspaceId);
      }
    }, PROGRESS_NOTIFICATION_INTERVAL_MS);
  }

  #notifyImmediately(
    download: ManagedDownload,
    additionalWorkspaces: ReadonlySet<string> = new Set(),
  ): void {
    if (download.notificationTimer) {
      clearTimeout(download.notificationTimer);
      download.notificationTimer = undefined;
    }
    this.#notifyWorkspaceChanges(download.workspaceId, additionalWorkspaces);
  }

  #notifyWorkspaceChanges(
    primaryWorkspaceId: string,
    additionalWorkspaces: ReadonlySet<string>,
  ): void {
    if (this.#destroyed) return;
    this.#onChange(primaryWorkspaceId);
    for (const workspaceId of additionalWorkspaces) {
      if (workspaceId !== primaryWorkspaceId) this.#onChange(workspaceId);
    }
  }

  #getOwnedDownload(workspaceId: string, downloadId: string): ManagedDownload {
    const download = this.#downloads.get(downloadId);
    if (!download || download.workspaceId !== workspaceId) {
      throw new Error('Download was not found in this workspace');
    }
    return download;
  }

  #activeDownloadCount(): number {
    return [...this.#downloads.values()].filter(
      ({ publicValue }) => !isTerminalDownloadState(publicValue.state),
    ).length;
  }

  #pruneHistory(): ReadonlySet<string> {
    const terminal = [...this.#downloads.values()]
      .filter(({ publicValue }) => isTerminalDownloadState(publicValue.state))
      .sort((left, right) => {
        const byUpdateTime = right.publicValue.updatedAt.localeCompare(left.publicValue.updatedAt);
        return byUpdateTime || right.sequence - left.sequence;
      });
    const affectedWorkspaces = new Set<string>();
    for (const download of terminal.slice(MAX_DOWNLOAD_HISTORY)) {
      affectedWorkspaces.add(download.workspaceId);
      this.#disposeDownload(download);
      this.#downloads.delete(download.id);
    }
    return affectedWorkspaces;
  }

  #takeSequence(): number {
    this.#nextSequence += 1;
    return this.#nextSequence;
  }

  #disposeDownload(download: ManagedDownload): void {
    if (download.notificationTimer) {
      clearTimeout(download.notificationTimer);
      download.notificationTimer = undefined;
    }
    try {
      download.item.removeListener('updated', download.updatedListener);
    } catch {
      // Native download teardown is best-effort and must never block later records.
    }
    try {
      download.item.removeListener('done', download.doneListener);
    } catch {
      // Native download teardown is best-effort and must never block later records.
    }
  }
}

function normalizeMimeType(value: string): string {
  return sanitizeDownloadDisplayText(value.trim(), 256);
}
