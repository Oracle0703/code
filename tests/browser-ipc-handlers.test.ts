import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../src/shared/contracts';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0-test' },
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const RENDERER_URL = 'file:///opt/daily-workbench/index.html';

let unregister: (() => void) | undefined;

beforeEach(() => {
  electron.handlers.clear();
  electron.handle.mockClear();
  electron.removeHandler.mockClear();
});

afterEach(() => {
  unregister?.();
  unregister = undefined;
});

describe('browser IPC promise propagation', () => {
  it.each([
    ['setBounds', IPC_CHANNELS.browser.setBounds],
    ['setVisible', IPC_CHANNELS.browser.setVisible],
  ] as const)('returns the %s promise to the trusted renderer', async (method, channel) => {
    const pending = deferred<void>();
    const harness = await createHarness({
      [method]: vi.fn(() => pending.promise),
    });
    unregister = harness.unregister;

    const result = harness.invoke(
      channel,
      method === 'setBounds'
        ? {
            workspaceId: WORKSPACE_ID,
            bounds: { x: 10, y: 20, width: 430, height: 640 },
          }
        : { workspaceId: WORKSPACE_ID, visible: true },
    );
    expect(result).toBe(pending.promise);
    pending.resolve();
    await expect(result).resolves.toBeUndefined();
  });

  it.each([
    ['setBounds', IPC_CHANNELS.browser.setBounds],
    ['setVisible', IPC_CHANNELS.browser.setVisible],
  ] as const)(
    'propagates a rejected %s promise to the trusted renderer',
    async (method, channel) => {
      const failure = new Error(`${method} failed`);
      const harness = await createHarness({
        [method]: vi.fn(() => Promise.reject(failure)),
      });
      unregister = harness.unregister;

      const result = harness.invoke(
        channel,
        method === 'setBounds'
          ? {
              workspaceId: WORKSPACE_ID,
              bounds: { x: 10, y: 20, width: 430, height: 640 },
            }
          : { workspaceId: WORKSPACE_ID, visible: true },
      );
      await expect(result).rejects.toBe(failure);
    },
  );

  it('routes the typed close-protection handshake through trusted IPC', async () => {
    const harness = await createHarness({});
    unregister = harness.unregister;
    const response = {
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      approved: false,
    };

    harness.invoke(IPC_CHANNELS.window.closeProtectionReady);
    harness.invoke(IPC_CHANNELS.window.respondCloseRequest, response);

    expect(harness.windowLifecycle.markCloseProtectionReady).toHaveBeenCalledTimes(1);
    expect(harness.windowLifecycle.respondToCloseRequest).toHaveBeenCalledExactlyOnceWith(response);
  });
});

async function createHarness(browserOverrides: Record<string, unknown>) {
  const { registerIpcHandlers } = await import('../src/main/ipc/register-handlers');
  const frame = { url: RENDERER_URL };
  const webContents = { mainFrame: frame };
  const window = {
    webContents,
    isDestroyed: () => false,
    isMaximized: () => false,
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  };
  const browser = {
    setBounds: vi.fn(async () => undefined),
    setVisible: vi.fn(async () => undefined),
    ...browserOverrides,
  };
  const windowLifecycle = {
    markCloseProtectionReady: vi.fn(),
    respondToCloseRequest: vi.fn(),
  };
  const dependencies = {
    window,
    windowLifecycle,
    browser,
    database: {},
    workspace: {},
    inbox: {},
    task: {},
    note: {},
    schedule: {},
    terminal: {},
    trustedRendererLocation: { kind: 'packaged-file', url: RENDERER_URL },
  } as unknown as Parameters<typeof registerIpcHandlers>[0];
  const unregisterHandlers = registerIpcHandlers(dependencies);
  const event = {
    sender: webContents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return {
    unregister: unregisterHandlers,
    windowLifecycle,
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = electron.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler(event, ...args);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
