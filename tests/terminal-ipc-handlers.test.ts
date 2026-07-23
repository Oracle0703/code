import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type TerminalSnapshot } from '../src/shared/contracts';

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

const WORKSPACE_ID = '123e4567-e89b-42d3-a456-426614174000';
const SESSION_ID = 'a23e4567-e89b-42d3-a456-426614174000';
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

describe('terminal IPC handlers', () => {
  it('routes exact workspace-bound inputs and preserves mutation results', async () => {
    const harness = await createHarness();
    unregister = harness.unregister;
    const target = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

    expect(harness.invoke(IPC_CHANNELS.terminal.getSnapshot, { workspaceId: WORKSPACE_ID })).toBe(
      harness.snapshot,
    );
    expect(
      harness.invoke(IPC_CHANNELS.terminal.create, {
        workspaceId: WORKSPACE_ID,
        configurationRevision: 1,
        profileId: 'powershell-7',
      }),
    ).toBe(harness.snapshot);
    expect(
      harness.invoke(IPC_CHANNELS.terminal.updateProfile, {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
        profileId: 'powershell-7',
      }),
    ).toBe(harness.snapshot);
    expect(
      harness.invoke(IPC_CHANNELS.terminal.updateWslDistribution, {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
        capabilityRevision: 2,
        distributionId: null,
      }),
    ).toBe(harness.snapshot);
    expect(
      harness.invoke(IPC_CHANNELS.terminal.chooseWorkingDirectory, {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
      }),
    ).toEqual({ status: 'cancelled', snapshot: harness.snapshot });
    expect(
      harness.invoke(IPC_CHANNELS.terminal.resetWorkingDirectory, {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
      }),
    ).toBe(harness.snapshot);
    expect(
      harness.invoke(IPC_CHANNELS.terminal.refreshCapabilities, {
        workspaceId: WORKSPACE_ID,
      }),
    ).toBe(harness.snapshot);
    expect(harness.invoke(IPC_CHANNELS.terminal.activate, target)).toBe(harness.snapshot);
    expect(harness.invoke(IPC_CHANNELS.terminal.restart, target)).toBe(harness.snapshot);
    expect(
      harness.invoke(IPC_CHANNELS.terminal.write, { ...target, data: '\u0003echo ok\r' }),
    ).toBeUndefined();
    expect(
      harness.invoke(IPC_CHANNELS.terminal.resize, { ...target, columns: 120, rows: 32 }),
    ).toBeUndefined();
    expect(harness.invoke(IPC_CHANNELS.terminal.clear, target)).toBeUndefined();
    expect(harness.invoke(IPC_CHANNELS.terminal.close, target)).toBe(harness.snapshot);

    expect(harness.terminal.getSnapshot).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
    });
    expect(harness.terminal.create).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      configurationRevision: 1,
      profileId: 'powershell-7',
    });
    expect(harness.terminal.updateProfile).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1,
      profileId: 'powershell-7',
    });
    expect(harness.terminal.updateWslDistribution).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1,
      capabilityRevision: 2,
      distributionId: null,
    });
    expect(harness.terminal.chooseWorkingDirectory).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1,
    });
    expect(harness.terminal.resetWorkingDirectory).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      expectedRevision: 1,
    });
    expect(harness.terminal.refreshCapabilities).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
    });
    expect(harness.terminal.activate).toHaveBeenCalledExactlyOnceWith(target);
    expect(harness.terminal.restart).toHaveBeenCalledExactlyOnceWith(target);
    expect(harness.terminal.write).toHaveBeenCalledExactlyOnceWith({
      ...target,
      data: '\u0003echo ok\r',
    });
    expect(harness.terminal.resize).toHaveBeenCalledExactlyOnceWith({
      ...target,
      columns: 120,
      rows: 32,
    });
    expect(harness.terminal.clear).toHaveBeenCalledExactlyOnceWith(target);
    expect(harness.terminal.close).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('returns asynchronous terminal operation promises to the trusted renderer', async () => {
    const pending = deferred<void>();
    const write = vi.fn(() => pending.promise);
    const harness = await createHarness({ write });
    unregister = harness.unregister;
    const result = harness.invoke(IPC_CHANNELS.terminal.write, {
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      data: 'echo pending\r',
    });

    expect(result).toBe(pending.promise);
    pending.resolve();
    await expect(result).resolves.toBeUndefined();
  });

  it('rejects forged profiles, uppercase session ids, surplus fields, and arguments', async () => {
    const harness = await createHarness();
    unregister = harness.unregister;

    expect(() =>
      harness.invoke(IPC_CHANNELS.terminal.create, {
        workspaceId: WORKSPACE_ID,
        configurationRevision: 1,
        profileId: 'custom-path',
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.terminal.activate, {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID.toUpperCase(),
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.terminal.write, {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        data: 'whoami\r',
        path: 'C:\\secret',
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.terminal.chooseWorkingDirectory, {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
        path: 'C:\\secret',
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.terminal.updateWslDistribution, {
        workspaceId: WORKSPACE_ID,
        expectedRevision: 1,
        capabilityRevision: 1,
        distributionId: null,
        distributionName: 'Ubuntu',
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.terminal.getSnapshot, { workspaceId: WORKSPACE_ID }, 'surplus'),
    ).toThrow(TypeError);

    expect(harness.terminal.create).not.toHaveBeenCalled();
    expect(harness.terminal.activate).not.toHaveBeenCalled();
    expect(harness.terminal.write).not.toHaveBeenCalled();
    expect(harness.terminal.getSnapshot).not.toHaveBeenCalled();
  });
});

async function createHarness(terminalOverrides: Record<string, unknown> = {}) {
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
  const snapshot: TerminalSnapshot = {
    workspaceId: WORKSPACE_ID,
    revision: 1,
    activeSessionId: SESSION_ID,
    sessions: [
      {
        id: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        profileId: 'powershell-7',
        label: 'PowerShell 7',
        status: 'running',
        createdAt: '2026-07-22T12:00:00.000Z',
      },
    ],
    profiles: [
      {
        id: 'powershell-7',
        label: 'PowerShell 7',
        kind: 'powershell',
        isDefault: true,
        available: true,
      },
    ],
    configuration: {
      revision: 1,
      preferredProfileId: 'powershell-7',
      workingDirectory: {
        mode: 'user-home',
        displayPath: 'C:\\Users\\test',
        available: true,
      },
      wsl: {
        status: 'no-distributions',
        capabilityRevision: 2,
        distributions: [],
        selectedDistributionId: null,
        selectedDistributionLabel: null,
        selectedDistributionAvailable: false,
      },
    },
  };
  const terminal = {
    getSnapshot: vi.fn(() => snapshot),
    create: vi.fn(() => snapshot),
    updateProfile: vi.fn(() => snapshot),
    updateWslDistribution: vi.fn(() => snapshot),
    chooseWorkingDirectory: vi.fn(() => ({ status: 'cancelled', snapshot })),
    resetWorkingDirectory: vi.fn(() => snapshot),
    refreshCapabilities: vi.fn(() => snapshot),
    activate: vi.fn(() => snapshot),
    restart: vi.fn(() => snapshot),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    close: vi.fn(() => snapshot),
    ...terminalOverrides,
  };
  const dependencies = {
    window,
    windowLifecycle: {},
    browser: {},
    database: {},
    workspace: {},
    inbox: {},
    task: {},
    note: {},
    schedule: {},
    terminal,
    trustedRendererLocation: { kind: 'packaged-file', url: RENDERER_URL },
  } as unknown as Parameters<typeof registerIpcHandlers>[0];
  const unregisterHandlers = registerIpcHandlers(dependencies);
  const event = {
    sender: webContents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;

  return {
    snapshot,
    terminal,
    unregister: unregisterHandlers,
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
