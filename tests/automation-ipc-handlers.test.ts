import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  AutomationCreateResult,
  AutomationRunNowResult,
  AutomationSnapshot,
} from '../src/shared/contracts';

const RENDERER_URL = 'file:///app/renderer/index.html';

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

describe('automation IPC handlers', () => {
  it('registers only narrow automation operations and validates their inputs', async () => {
    const harness = await createHarness();
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const automationId = 'b23e4567-e89b-42d3-a456-426614174000';
    const schedule = { cadence: 'daily' as const, localTimeMinute: 510, weekday: null };
    const action = { kind: 'create-today-task' as const, title: '检查今日计划' };

    await harness.invoke('automation:get-snapshot', { workspaceId });
    await expect(
      harness.invoke('automation:create', {
        workspaceId,
        name: '每日准备',
        schedule,
        action,
      }),
    ).resolves.toBe(harness.createResult);
    await harness.invoke('automation:update', {
      workspaceId,
      automationId,
      expectedRevision: 1,
      name: '每日检查',
      schedule,
      action,
    });
    await harness.invoke('automation:set-enabled', {
      workspaceId,
      automationId,
      expectedRevision: 2,
      enabled: true,
    });
    await harness.invoke('automation:run-now', {
      workspaceId,
      automationId,
      expectedRevision: 3,
    });
    await harness.invoke('automation:archive', {
      workspaceId,
      automationId,
      expectedRevision: 4,
    });

    expect(
      electron.handle.mock.calls
        .map(([channel]) => channel)
        .filter((channel) => channel.startsWith('automation:'))
        .sort(),
    ).toEqual([
      'automation:archive',
      'automation:create',
      'automation:get-snapshot',
      'automation:run-now',
      'automation:set-enabled',
      'automation:update',
    ]);
    expect(harness.automation.getSnapshot).toHaveBeenCalledExactlyOnceWith({ workspaceId });
    expect(harness.automation.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      name: '每日准备',
      schedule,
      action,
    });
    expect(harness.automation.update).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      automationId,
      expectedRevision: 1,
      name: '每日检查',
      schedule,
      action,
    });
    expect(harness.automation.setEnabled).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      automationId,
      expectedRevision: 2,
      enabled: true,
    });
    expect(harness.automation.runNow).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      automationId,
      expectedRevision: 3,
    });
    expect(harness.automation.archive).toHaveBeenCalledExactlyOnceWith({
      workspaceId,
      automationId,
      expectedRevision: 4,
    });
    harness.unregister();
  });

  it('rejects forged action capabilities before calling the controller', async () => {
    const harness = await createHarness();
    await expect(
      harness.invoke('automation:create', {
        workspaceId: '123e4567-e89b-42d3-a456-426614174000',
        name: 'unsafe',
        schedule: { cadence: 'daily', localTimeMinute: 510, weekday: null },
        action: { kind: 'run-command', executable: 'powershell.exe', argv: ['whoami'] },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(harness.automation.create).not.toHaveBeenCalled();
    harness.unregister();
  });

  it('rejects surplus run-now fields and extra arguments before calling the controller', async () => {
    const harness = await createHarness();
    const target = {
      workspaceId: '123e4567-e89b-42d3-a456-426614174000',
      automationId: 'b23e4567-e89b-42d3-a456-426614174000',
      expectedRevision: 3,
    };

    await expect(
      harness.invoke('automation:run-now', {
        ...target,
        occurrenceBucket: 'manual:2026-07-24T08:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      harness.invoke('automation:run-now', target, { requestedAt: Date.now() }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(harness.automation.runNow).not.toHaveBeenCalled();
    harness.unregister();
  });

  it('rejects a remote or nested-frame sender', async () => {
    const harness = await createHarness();
    const handler = electron.handlers.get('automation:get-snapshot');
    if (!handler) throw new Error('Missing automation handler.');
    const remoteFrame = { url: 'https://example.com/' };
    await expect(
      Promise.resolve().then(() =>
        handler(
          {
            sender: harness.webContents,
            senderFrame: remoteFrame,
          } as unknown as IpcMainInvokeEvent,
          { workspaceId: '123e4567-e89b-42d3-a456-426614174000' },
        ),
      ),
    ).rejects.toThrow('Untrusted IPC sender');
    expect(harness.automation.getSnapshot).not.toHaveBeenCalled();
    harness.unregister();
  });
});

async function createHarness() {
  const { registerIpcHandlers } = await import('../src/main/ipc/register-handlers');
  const frame = { url: RENDERER_URL };
  const webContents = { mainFrame: frame };
  const snapshot: AutomationSnapshot = {
    workspaceId: '123e4567-e89b-42d3-a456-426614174000',
    items: [],
  };
  const createResult: AutomationCreateResult = {
    automationSnapshot: snapshot,
    createdAutomationId: 'b23e4567-e89b-42d3-a456-426614174000',
  };
  const runNowResult: AutomationRunNowResult = {
    workspaceId: '123e4567-e89b-42d3-a456-426614174000',
    automationId: 'b23e4567-e89b-42d3-a456-426614174000',
    outputKind: 'task',
    outputId: 'c23e4567-e89b-42d3-a456-426614174000',
  };
  const automation = {
    getSnapshot: vi.fn(async () => snapshot),
    create: vi.fn(async () => createResult),
    update: vi.fn(async () => snapshot),
    setEnabled: vi.fn(async () => snapshot),
    runNow: vi.fn(async () => runNowResult),
    archive: vi.fn(async () => snapshot),
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
    automation,
    terminal: {},
    trustedRendererLocation: { kind: 'packaged-file', url: RENDERER_URL },
  } as unknown as Parameters<typeof registerIpcHandlers>[0];
  const unregister = registerIpcHandlers(dependencies);
  const event = {
    sender: webContents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return {
    automation,
    createResult,
    webContents,
    unregister,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = electron.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler(event, ...args);
    },
  };
}
