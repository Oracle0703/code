import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  IPC_CHANNELS,
  type WorkspaceArchiveSnapshot,
  type WorkspaceRestoreResult,
  type WorkspaceSnapshot,
} from '../src/shared/contracts';

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn(
      (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    ),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
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

describe('workspace IPC handlers', () => {
  it('routes a parameterless archive read and the exact validated restore input', async () => {
    const harness = await createHarness();
    unregister = harness.unregister;
    const restoreInput = {
      workspaceId: WORKSPACE_ID,
      expectedRevision: 4,
      name: 'Restored workspace',
    };

    await expect(harness.invoke(IPC_CHANNELS.workspace.getArchiveSnapshot)).resolves.toBe(
      harness.archiveSnapshot,
    );
    await expect(harness.invoke(IPC_CHANNELS.workspace.restore, restoreInput)).resolves.toBe(
      harness.restoreResult,
    );

    expect(harness.workspace.getWorkspaceArchiveSnapshot).toHaveBeenCalledExactlyOnceWith();
    expect(harness.workspace.restoreWorkspace).toHaveBeenCalledExactlyOnceWith(restoreInput);
  });

  it('rejects archive arguments and forged restore fields before persistence dispatch', async () => {
    const harness = await createHarness();
    unregister = harness.unregister;
    const restoreInput = {
      workspaceId: WORKSPACE_ID,
      expectedRevision: 4,
      name: 'Restored workspace',
    };

    expect(() =>
      harness.invoke(IPC_CHANNELS.workspace.getArchiveSnapshot, {
        workspaceId: WORKSPACE_ID,
      }),
    ).toThrow(TypeError);
    expect(() => harness.invoke(IPC_CHANNELS.workspace.restore, restoreInput, 'surplus')).toThrow(
      TypeError,
    );
    expect(() =>
      harness.invoke(IPC_CHANNELS.workspace.restore, {
        ...restoreInput,
        expectedRevision: '4',
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.workspace.restore, {
        ...restoreInput,
        archivedAt: '2026-07-24T12:00:00.000Z',
      }),
    ).toThrow(TypeError);

    expect(harness.workspace.getWorkspaceArchiveSnapshot).not.toHaveBeenCalled();
    expect(harness.workspace.restoreWorkspace).not.toHaveBeenCalled();
  });
});

async function createHarness() {
  const { registerIpcHandlers } = await import('../src/main/ipc/register-handlers');
  const frame = { url: RENDERER_URL };
  const webContents = { mainFrame: frame };
  const workspaceSnapshot: WorkspaceSnapshot = {
    currentWorkspaceId: WORKSPACE_ID,
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: 'Workspace',
        color: '#7b6ee8',
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-24T12:00:00.000Z',
      },
    ],
    preferences: DEFAULT_WORKSPACE_PREFERENCES,
  };
  const archiveSnapshot: WorkspaceArchiveSnapshot = {
    archivedWorkspaces: [
      {
        ...workspaceSnapshot.workspaces[0]!,
        archivedAt: '2026-07-24T12:00:00.000Z',
        revision: 4,
      },
    ],
  };
  const restoreResult: WorkspaceRestoreResult = {
    workspaceSnapshot,
    archiveSnapshot: { archivedWorkspaces: [] },
  };
  const workspace = {
    getWorkspaceSnapshot: vi.fn(async () => workspaceSnapshot),
    getWorkspaceArchiveSnapshot: vi.fn(async () => archiveSnapshot),
    createWorkspace: vi.fn(async () => workspaceSnapshot),
    renameWorkspace: vi.fn(async () => workspaceSnapshot),
    activateWorkspace: vi.fn(async () => workspaceSnapshot),
    archiveWorkspace: vi.fn(async () => workspaceSnapshot),
    restoreWorkspace: vi.fn(async () => restoreResult),
    updateWorkspacePreferences: vi.fn(async () => DEFAULT_WORKSPACE_PREFERENCES),
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
    workspace,
    inbox: {},
    task: {},
    note: {},
    schedule: {},
    focus: {},
    automation: {},
    assistant: {},
    terminal: {},
    trustedRendererLocation: { kind: 'packaged-file', url: RENDERER_URL },
  } as unknown as Parameters<typeof registerIpcHandlers>[0];
  const unregisterHandlers = registerIpcHandlers(dependencies);
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;

  return {
    archiveSnapshot,
    restoreResult,
    workspace,
    unregister: unregisterHandlers,
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = electron.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler(event, ...args);
    },
  };
}
