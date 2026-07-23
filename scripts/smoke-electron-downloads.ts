import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  type DownloadItem,
  type Event,
  session,
  type Session,
  type WebContents,
  WebContentsView,
} from 'electron';
import { DownloadManager } from '../src/main/downloads/download-manager';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const COMPLETE_DOWNLOAD_ID = '21111111-1111-4111-8111-111111111111';
const CANCELLED_DOWNLOAD_ID = '31111111-1111-4111-8111-111111111111';
const PAYLOAD_SIZE = 8 * 1024 * 1024;
const CHUNK_SIZE = 32 * 1024;
const CHUNK_DELAY_MS = 15;
const WAIT_TIMEOUT_MS = 20_000;
const HARNESS_TIMEOUT_MS = 60_000;
const LAST_MODIFIED = 'Wed, 22 Jul 2026 12:00:00 GMT';
const ETAG = '"daily-workbench-electron-download-smoke-v1"';
const DOWNLOAD_PATHS = {
  complete: '/downloads/complete.bin',
  cancelled: '/downloads/cancelled.bin',
  noGesture: '/downloads/no-gesture.bin',
  unmanaged: '/downloads/unmanaged.bin',
} as const;

type DownloadKind = keyof typeof DOWNLOAD_PATHS;

interface DownloadObservation {
  readonly url: string;
  readonly contents: WebContents;
  readonly hasUserGesture: boolean;
  readonly defaultPrevented: boolean;
  readonly item?: DownloadItem;
}

interface SmokeServer {
  readonly server: Server;
  readonly origin: string;
  readonly expectedHash: string;
}

interface SmokeViews {
  readonly hostWindow: BrowserWindow;
  readonly managedView: WebContentsView;
  readonly unmanagedView: WebContentsView;
}

const hardTimeout = setTimeout(() => {
  console.error(`Electron download smoke exceeded ${HARNESS_TIMEOUT_MS} ms.`);
  app.exit(1);
}, HARNESS_TIMEOUT_MS);

void app
  .whenReady()
  .then(runSmoke)
  .then(() => console.log('Electron DownloadManager smoke passed.'))
  .catch((error: unknown) => {
    process.exitCode = 1;
    console.error(error);
  })
  .finally(() => {
    clearTimeout(hardTimeout);
    app.quit();
  });

async function runSmoke(): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-download-smoke-'));
  const downloadsDirectory = join(temporaryDirectory, 'downloads');
  await mkdir(downloadsDirectory, { recursive: true });
  let smokeServer: SmokeServer | undefined;
  try {
    smokeServer = await startSmokeServer();
    await runDownloadAssertions(downloadsDirectory, smokeServer);
  } finally {
    try {
      if (smokeServer) {
        await stopSmokeServer(smokeServer.server);
      }
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }
}

async function runDownloadAssertions(
  downloadsDirectory: string,
  smokeServer: SmokeServer,
): Promise<void> {
  const smokeSession = session.fromPartition(`download-smoke-${randomUUID()}`, {
    cache: false,
  });
  const views = createSmokeViews(smokeSession);
  const observations: DownloadObservation[] = [];
  const revealedPaths: string[] = [];
  const downloadIds = [COMPLETE_DOWNLOAD_ID, CANCELLED_DOWNLOAD_ID];
  const initialDownloadListenerCount = smokeSession.listenerCount('will-download');
  try {
    const manager = new DownloadManager({
      session: smokeSession,
      downloadsDirectory,
      resolveSource: (contents) =>
        contents === views.managedView.webContents ? { workspaceId: WORKSPACE_ID } : null,
      onChange: () => undefined,
      revealPath: (path) => revealedPaths.push(path),
      idFactory: () => downloadIds.shift() ?? 'invalid-exhausted-download-id',
    });

    const observeDownload = (event: Event, item: DownloadItem, contents: WebContents): void => {
      const url = item.getURL();
      const hasUserGesture = item.hasUserGesture();
      const defaultPrevented = event.defaultPrevented;
      if (!defaultPrevented) {
        const kind = getDownloadKind(url);
        item.setSavePath(join(downloadsDirectory, `${kind}.bin`));
        observations.push({ url, contents, hasUserGesture, defaultPrevented, item });
        return;
      }
      observations.push({ url, contents, hasUserGesture, defaultPrevented });
    };

    try {
      smokeSession.on('will-download', observeDownload);
      await Promise.all([
        views.managedView.webContents.loadURL(smokeServer.origin),
        views.unmanagedView.webContents.loadURL(smokeServer.origin),
      ]);

      await verifyRejectedDownload({
        manager,
        observations,
        contents: views.managedView.webContents,
        elementId: 'no-gesture',
        expectedPath: DOWNLOAD_PATHS.noGesture,
        expectedFilePath: join(downloadsDirectory, 'noGesture.bin'),
        userGesture: false,
        expectedGesture: false,
      });
      await verifyRejectedDownload({
        manager,
        observations,
        contents: views.unmanagedView.webContents,
        elementId: 'unmanaged',
        expectedPath: DOWNLOAD_PATHS.unmanaged,
        expectedFilePath: join(downloadsDirectory, 'unmanaged.bin'),
        userGesture: true,
        expectedGesture: true,
      });

      await verifyCompletedDownload({
        manager,
        observations,
        contents: views.managedView.webContents,
        expectedHash: smokeServer.expectedHash,
        downloadsDirectory,
        revealedPaths,
      });
      await verifyCancelledDownload({
        manager,
        observations,
        contents: views.managedView.webContents,
      });
    } finally {
      smokeSession.removeListener('will-download', observeDownload);
      manager.destroy();
      assert.equal(
        smokeSession.listenerCount('will-download'),
        initialDownloadListenerCount,
        'Download session listeners leaked after cleanup.',
      );
    }
  } finally {
    destroySmokeViews(views);
  }
}

async function verifyRejectedDownload(input: {
  readonly manager: DownloadManager;
  readonly observations: DownloadObservation[];
  readonly contents: WebContents;
  readonly elementId: string;
  readonly expectedPath: string;
  readonly expectedFilePath: string;
  readonly userGesture: boolean;
  readonly expectedGesture: boolean;
}): Promise<void> {
  const initialCount = input.observations.length;
  await clickDownloadLink(input.contents, input.elementId, input.userGesture);
  const observation = await waitForValue(`${input.elementId} will-download event`, () =>
    input.observations
      .slice(initialCount)
      .find(({ url }) => new URL(url).pathname === input.expectedPath),
  );
  assert.equal(observation.contents, input.contents);
  assert.equal(observation.hasUserGesture, input.expectedGesture);
  assert.equal(observation.defaultPrevented, true);
  assert.equal(observation.item, undefined);
  await delay(250);
  assert.deepEqual(input.manager.getDownloads(WORKSPACE_ID), []);
  await assertPathDoesNotExist(input.expectedFilePath);
}

async function verifyCompletedDownload(input: {
  readonly manager: DownloadManager;
  readonly observations: DownloadObservation[];
  readonly contents: WebContents;
  readonly expectedHash: string;
  readonly downloadsDirectory: string;
  readonly revealedPaths: string[];
}): Promise<void> {
  const initialCount = input.observations.length;
  await clickDownloadLink(input.contents, 'complete', true);
  const observation = await waitForValue('managed will-download event', () =>
    input.observations
      .slice(initialCount)
      .find(({ url }) => new URL(url).pathname === DOWNLOAD_PATHS.complete),
  );
  assert.equal(observation.hasUserGesture, true);
  assert.equal(observation.defaultPrevented, false);
  assert.ok(observation.item);
  const item = observation.item;

  const initialDownload = await waitForValue('managed DownloadManager entry', () =>
    input.manager.getDownloads(WORKSPACE_ID).find(({ id }) => id === COMPLETE_DOWNLOAD_ID),
  );
  assert.equal(initialDownload.fileName, 'complete.bin');
  assert.equal(initialDownload.sourceHost, '127.0.0.1');
  assert.equal(initialDownload.state, 'progressing');

  await waitForCondition(
    'download progress before pause',
    () => item.getReceivedBytes() >= 128_000,
  );
  input.manager.pause(WORKSPACE_ID, COMPLETE_DOWNLOAD_ID);
  assert.equal(item.isPaused(), true);
  assert.equal(input.manager.getDownloads(WORKSPACE_ID)[0]?.state, 'paused');
  await assertReceivedBytesStable(item);
  input.manager.resume(WORKSPACE_ID, COMPLETE_DOWNLOAD_ID);
  assert.equal(item.isPaused(), false);

  await waitForCondition('completed DownloadItem', () => item.getState() === 'completed');
  const completed = await waitForValue('completed DownloadManager entry', () => {
    const value = input.manager
      .getDownloads(WORKSPACE_ID)
      .find(({ id }) => id === COMPLETE_DOWNLOAD_ID);
    return value?.state === 'completed' ? value : undefined;
  });
  assert.equal(completed.receivedBytes, PAYLOAD_SIZE);
  assert.equal(completed.totalBytes, PAYLOAD_SIZE);

  const completedPath = join(input.downloadsDirectory, 'complete.bin');
  const actualHash = createHash('sha256')
    .update(await readFile(completedPath))
    .digest('hex');
  assert.equal(actualHash, input.expectedHash);
  assert.equal(
    JSON.stringify(completed).includes(temporaryPathFragment(input.downloadsDirectory)),
    false,
  );

  await input.manager.reveal(WORKSPACE_ID, COMPLETE_DOWNLOAD_ID);
  assert.deepEqual(input.revealedPaths, [completedPath]);
}

async function verifyCancelledDownload(input: {
  readonly manager: DownloadManager;
  readonly observations: DownloadObservation[];
  readonly contents: WebContents;
}): Promise<void> {
  const initialCount = input.observations.length;
  await clickDownloadLink(input.contents, 'cancelled', true);
  const observation = await waitForValue('cancel will-download event', () =>
    input.observations
      .slice(initialCount)
      .find(({ url }) => new URL(url).pathname === DOWNLOAD_PATHS.cancelled),
  );
  assert.equal(observation.hasUserGesture, true);
  assert.equal(observation.defaultPrevented, false);
  assert.ok(observation.item);
  const item = observation.item;

  await waitForCondition(
    'download progress before cancel',
    () => item.getReceivedBytes() >= 128_000,
  );
  const receivedBeforeCancel = item.getReceivedBytes();
  input.manager.cancel(WORKSPACE_ID, CANCELLED_DOWNLOAD_ID);
  await waitForCondition('cancelled DownloadItem', () => item.getState() === 'cancelled');
  const cancelled = await waitForValue('cancelled DownloadManager entry', () => {
    const value = input.manager
      .getDownloads(WORKSPACE_ID)
      .find(({ id }) => id === CANCELLED_DOWNLOAD_ID);
    return value?.state === 'cancelled' ? value : undefined;
  });
  assert.ok(receivedBeforeCancel > 0);
  assert.ok(cancelled.receivedBytes < PAYLOAD_SIZE);
  assert.equal(cancelled.canResume, false);
}

async function clickDownloadLink(
  contents: WebContents,
  elementId: string,
  userGesture: boolean,
): Promise<void> {
  const clicked = await contents.executeJavaScript(
    `(() => {
      const element = document.getElementById(${JSON.stringify(elementId)});
      if (!(element instanceof HTMLAnchorElement)) return false;
      element.click();
      return true;
    })()`,
    userGesture,
  );
  assert.equal(clicked, true, `Could not click download link: ${elementId}`);
}

function createSmokeViews(smokeSession: Session): SmokeViews {
  const hostWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
  });
  const webPreferences = {
    session: smokeSession,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  } as const;
  const managedView = new WebContentsView({ webPreferences });
  const unmanagedView = new WebContentsView({ webPreferences });
  hostWindow.contentView.addChildView(managedView);
  hostWindow.contentView.addChildView(unmanagedView);
  managedView.setBounds({ x: 0, y: 0, width: 450, height: 700 });
  unmanagedView.setBounds({ x: 450, y: 0, width: 450, height: 700 });
  return { hostWindow, managedView, unmanagedView };
}

function destroySmokeViews(views: SmokeViews): void {
  views.hostWindow.contentView.removeChildView(views.managedView);
  views.hostWindow.contentView.removeChildView(views.unmanagedView);
  if (!views.managedView.webContents.isDestroyed()) {
    views.managedView.webContents.close();
  }
  if (!views.unmanagedView.webContents.isDestroyed()) {
    views.unmanagedView.webContents.close();
  }
  if (!views.hostWindow.isDestroyed()) {
    views.hostWindow.destroy();
  }
}

async function startSmokeServer(): Promise<SmokeServer> {
  const payload = createPayload();
  const expectedHash = createHash('sha256').update(payload).digest('hex');
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(createDownloadPage());
      return;
    }
    const kind = findDownloadKind(requestUrl.pathname);
    if (!kind) {
      response.writeHead(404);
      response.end();
      return;
    }
    serveDownload(response, request.headers.range, payload, kind);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}/`,
    expectedHash,
  };
}

function serveDownload(
  response: ServerResponse,
  rangeHeader: string | undefined,
  payload: Buffer,
  kind: DownloadKind,
): void {
  response.on('error', () => undefined);
  let start = 0;
  let end = payload.length - 1;
  let status = 200;
  if (rangeHeader) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (!match) {
      response.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
      response.end();
      return;
    }
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
      response.end();
      return;
    }
    status = 206;
  }

  const headers: Record<string, string | number> = {
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `attachment; filename="${kind}.bin"`,
    'Content-Length': end - start + 1,
    'Content-Type': 'application/octet-stream',
    ETag: ETAG,
    'Last-Modified': LAST_MODIFIED,
  };
  if (status === 206) {
    headers['Content-Range'] = `bytes ${start}-${end}/${payload.length}`;
  }
  response.writeHead(status, headers);
  streamPayload(response, payload, start, end);
}

function streamPayload(
  response: ServerResponse,
  payload: Buffer,
  start: number,
  end: number,
): void {
  let offset = start;
  const writeNext = (): void => {
    if (response.destroyed || response.writableEnded) return;
    const nextOffset = Math.min(offset + CHUNK_SIZE, end + 1);
    const canContinue = response.write(payload.subarray(offset, nextOffset));
    offset = nextOffset;
    if (offset > end) {
      response.end();
      return;
    }
    if (canContinue) {
      setTimeout(writeNext, CHUNK_DELAY_MS);
    } else {
      response.once('drain', () => setTimeout(writeNext, CHUNK_DELAY_MS));
    }
  };
  writeNext();
}

function createPayload(): Buffer {
  const payload = Buffer.allocUnsafe(PAYLOAD_SIZE);
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 31 + 17) & 0xff;
  }
  return payload;
}

function createDownloadPage(): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Electron download smoke</title></head>
  <body>
    <a id="complete" href="${DOWNLOAD_PATHS.complete}">Complete download</a>
    <a id="cancelled" href="${DOWNLOAD_PATHS.cancelled}">Cancel download</a>
    <a id="no-gesture" href="${DOWNLOAD_PATHS.noGesture}">No gesture download</a>
    <a id="unmanaged" href="${DOWNLOAD_PATHS.unmanaged}">Unmanaged download</a>
  </body>
</html>`;
}

function getDownloadKind(url: string): DownloadKind {
  const path = new URL(url).pathname;
  const kind = findDownloadKind(path);
  if (!kind) {
    throw new Error(`Unexpected smoke download URL: ${url}`);
  }
  return kind;
}

function findDownloadKind(path: string): DownloadKind | undefined {
  const entry = Object.entries(DOWNLOAD_PATHS).find(([, value]) => value === path);
  return entry?.[0] as DownloadKind | undefined;
}

async function assertReceivedBytesStable(item: DownloadItem): Promise<void> {
  let previous = item.getReceivedBytes();
  let stableReadings = 0;
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    await delay(150);
    const current = item.getReceivedBytes();
    if (current === previous) {
      stableReadings += 1;
      if (stableReadings >= 3) {
        assert.ok(current > 0);
        assert.ok(current < item.getTotalBytes());
        return;
      }
    } else {
      stableReadings = 0;
      previous = current;
    }
  }
  throw new Error('Paused download bytes did not become stable.');
}

async function waitForValue<T>(
  description: string,
  read: () => T | undefined,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForCondition(
  description: string,
  read: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  await waitForValue(description, () => (read() ? true : undefined), timeoutMs);
}

async function stopSmokeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function assertPathDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Rejected download unexpectedly wrote a file: ${path}`);
}

function temporaryPathFragment(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
