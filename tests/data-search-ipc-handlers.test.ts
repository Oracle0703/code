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
const IMPORT_ID = '22222222-2222-4222-8222-222222222222';
const BACKUP_ID = '33333333-3333-4333-8333-333333333333';
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

describe('data and search IPC handlers', () => {
  it('routes validated data operations and NFKC-normalized search input', async () => {
    const harness = await createHarness();
    unregister = harness.unregister;
    const policy = {
      enabled: true,
      cadence: 'weekly',
      localTimeMinute: 180,
      weekday: 4,
      retentionCount: 21,
      expectedRevision: 2,
    };
    const restore = {
      backupId: BACKUP_ID,
      expectedReason: 'scheduled' as const,
      expectedCreatedAt: '2026-07-24T07:12:34.567Z',
      expectedSizeBytes: 1_048_576,
      expectedSchemaVersion: 10,
    };

    harness.invoke(IPC_CHANNELS.database.createBackup);
    harness.invoke(IPC_CHANNELS.database.getManagementSnapshot);
    harness.invoke(IPC_CHANNELS.database.restoreBackup, restore);
    harness.invoke(IPC_CHANNELS.database.updateBackupPolicy, policy);
    harness.invoke(IPC_CHANNELS.database.exportData);
    harness.invoke(IPC_CHANNELS.database.chooseImport);
    harness.invoke(IPC_CHANNELS.database.commitImport, {
      importId: IMPORT_ID,
      previewDigest: 'a'.repeat(64),
    });
    harness.invoke(IPC_CHANNELS.database.cancelImport, { importId: IMPORT_ID });
    harness.invoke(IPC_CHANNELS.search.query, {
      workspaceId: WORKSPACE_ID,
      query: '  ＡPI\u3000搜索  ',
      scope: 'all',
    });

    expect(harness.data.createBackup).toHaveBeenCalledTimes(1);
    expect(harness.data.getManagementSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.data.restoreBackup).toHaveBeenCalledExactlyOnceWith(restore);
    expect(harness.data.updateBackupPolicy).toHaveBeenCalledExactlyOnceWith(policy);
    expect(harness.data.exportData).toHaveBeenCalledTimes(1);
    expect(harness.data.chooseImport).toHaveBeenCalledTimes(1);
    expect(harness.data.commitImport).toHaveBeenCalledExactlyOnceWith({
      importId: IMPORT_ID,
      previewDigest: 'a'.repeat(64),
    });
    expect(harness.data.cancelImport).toHaveBeenCalledExactlyOnceWith({ importId: IMPORT_ID });
    expect(harness.search.query).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_ID,
      query: 'API 搜索',
      scope: 'all',
    });
  });

  it('rejects surplus arguments, malformed digests, and unsupported scopes before dispatch', async () => {
    const harness = await createHarness();
    unregister = harness.unregister;

    expect(() => harness.invoke(IPC_CHANNELS.database.exportData, 'surplus')).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.database.commitImport, {
        importId: IMPORT_ID,
        previewDigest: '../unsafe',
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.database.restoreBackup, {
        backupId: BACKUP_ID,
        expectedReason: 'scheduled',
        expectedCreatedAt: '2026-07-24T07:12:34.567Z',
        expectedSizeBytes: 1_048_576,
        expectedSchemaVersion: 11,
        path: '/tmp/unsafe.sqlite3',
      }),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(
        IPC_CHANNELS.database.restoreBackup,
        {
          backupId: BACKUP_ID,
          expectedReason: 'scheduled',
          expectedCreatedAt: '2026-07-24T07:12:34.567Z',
          expectedSizeBytes: 1_048_576,
          expectedSchemaVersion: 11,
        },
        'surplus',
      ),
    ).toThrow(TypeError);
    expect(() =>
      harness.invoke(IPC_CHANNELS.search.query, {
        workspaceId: WORKSPACE_ID,
        query: 'valid',
        scope: 'archived',
      }),
    ).toThrow(TypeError);
    expect(harness.data.exportData).not.toHaveBeenCalled();
    expect(harness.data.commitImport).not.toHaveBeenCalled();
    expect(harness.data.restoreBackup).not.toHaveBeenCalled();
    expect(harness.search.query).not.toHaveBeenCalled();
  });
});

async function createHarness() {
  const { registerIpcHandlers } = await import('../src/main/ipc/register-handlers');
  const frame = { url: RENDERER_URL };
  const webContents = { mainFrame: frame };
  const data = {
    createBackup: vi.fn(),
    getManagementSnapshot: vi.fn(),
    restoreBackup: vi.fn(),
    updateBackupPolicy: vi.fn(),
    exportData: vi.fn(),
    chooseImport: vi.fn(),
    commitImport: vi.fn(),
    cancelImport: vi.fn(),
  };
  const search = { query: vi.fn() };
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
    data,
    search,
    workspace: {},
    inbox: {},
    task: {},
    note: {},
    schedule: {},
    terminal: {},
    trustedRendererLocation: { kind: 'packaged-file', url: RENDERER_URL },
  } as unknown as Parameters<typeof registerIpcHandlers>[0];
  const unregisterHandlers = registerIpcHandlers(dependencies);
  const event = { sender: webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return {
    data,
    search,
    unregister: unregisterHandlers,
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = electron.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler(event, ...args);
    },
  };
}
