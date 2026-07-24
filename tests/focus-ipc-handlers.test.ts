import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FocusSnapshot } from '../src/shared/contracts';

const RENDERER_URL = 'file:///app/renderer/index.html';
const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174000';
const TASK_ID = '423e4567-e89b-42d3-a456-426614174000';
const SESSION_ID = 'c23e4567-e89b-42d3-a456-426614174000';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  handle: vi.fn(
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler);
    },
  ),
  removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '0.1.0') },
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

beforeEach(() => {
  electron.handlers.clear();
  electron.handle.mockClear();
  electron.removeHandler.mockClear();
});

describe('focus IPC handlers', () => {
  it('registers the narrow workspace-bound focus operations', async () => {
    const harness = await createHarness();
    const target = {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      expectedRevision: 2,
    };

    await harness.invoke('focus:get-snapshot', { workspaceId: WORKSPACE_ID });
    await harness.invoke('focus:start', { workspaceId: WORKSPACE_ID });
    await harness.invoke('focus:start', { workspaceId: WORKSPACE_ID, taskId: TASK_ID });
    await harness.invoke('focus:pause', target);
    await harness.invoke('focus:resume', target);
    await harness.invoke('focus:cancel', target);

    expect(harness.focus.getSnapshot).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
    });
    expect(harness.focus.start).toHaveBeenNthCalledWith(1, { workspaceId: WORKSPACE_ID });
    expect(harness.focus.start).toHaveBeenNthCalledWith(2, {
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
    });
    expect(harness.focus.pause).toHaveBeenCalledExactlyOnceWith(target);
    expect(harness.focus.resume).toHaveBeenCalledExactlyOnceWith(target);
    expect(harness.focus.cancel).toHaveBeenCalledExactlyOnceWith(target);
    harness.unregister();
  });

  it('rejects renderer-owned duration, deadline, and state before calling the controller', async () => {
    const harness = await createHarness();
    await expect(
      harness.invoke('focus:start', {
        workspaceId: WORKSPACE_ID,
        taskId: TASK_ID,
        durationSeconds: 60,
        deadlineAt: '2026-07-23T12:01:00.000Z',
        state: 'completed',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(harness.focus.start).not.toHaveBeenCalled();
    harness.unregister();
  });

  it('rejects a remote or nested-frame sender', async () => {
    const harness = await createHarness();
    const handler = electron.handlers.get('focus:get-snapshot');
    if (!handler) throw new Error('Missing focus handler.');
    const remoteFrame = { url: 'https://example.com/' };
    await expect(
      Promise.resolve().then(() =>
        handler(
          {
            sender: harness.webContents,
            senderFrame: remoteFrame,
          } as unknown as IpcMainInvokeEvent,
          { workspaceId: WORKSPACE_ID },
        ),
      ),
    ).rejects.toThrow('Untrusted IPC sender');
    expect(harness.focus.getSnapshot).not.toHaveBeenCalled();
    harness.unregister();
  });
});

async function createHarness() {
  const { registerIpcHandlers } = await import('../src/main/ipc/register-handlers');
  const frame = { url: RENDERER_URL };
  const webContents = { mainFrame: frame };
  const snapshot: FocusSnapshot = {
    workspaceId: WORKSPACE_ID,
    todayDate: '2026-07-23',
    observedAt: '2026-07-23T12:00:00.000Z',
    session: null,
    todayCompletedCount: 0,
  };
  const focus = {
    getSnapshot: vi.fn(async () => snapshot),
    start: vi.fn(async () => snapshot),
    pause: vi.fn(async () => snapshot),
    resume: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => snapshot),
  };
  const dependencies = {
    window: {
      webContents,
      isDestroyed: () => false,
      isMaximized: () => false,
      minimize: vi.fn(),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn(),
    },
    windowLifecycle: {},
    browser: {},
    database: {},
    data: {},
    search: {},
    workspace: {},
    inbox: {},
    task: {},
    note: {},
    schedule: {},
    focus,
    automation: {},
    assistant: {},
    terminal: {},
    trustedRendererLocation: { kind: 'packaged-file', url: RENDERER_URL },
  } as unknown as Parameters<typeof registerIpcHandlers>[0];
  const unregister = registerIpcHandlers(dependencies);
  const event = {
    sender: webContents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return {
    focus,
    webContents,
    unregister,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = electron.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler(event, ...args);
    },
  };
}
