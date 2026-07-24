import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { AssistantSnapshot } from '../src/shared/contracts';

const RENDERER_URL = 'file:///app/renderer/index.html';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const NOTE_ID = '33333333-3333-4333-8333-333333333333';
const API_KEY = `sk-proj-${'a'.repeat(48)}`;

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

describe('assistant IPC handlers', () => {
  it('exposes only Main-scoped credential and runtime operations', async () => {
    const harness = await createHarness();

    await harness.invoke('assistant:get-credential-status');
    await harness.invoke('assistant:configure-credential', { apiKey: API_KEY });
    await harness.invoke('assistant:remove-credential');
    await harness.invoke('assistant:get-snapshot');
    await harness.invoke('assistant:start', {
      prompt: '  梳理下一步  ',
      context: { kind: 'tasks', taskIds: [TASK_ID] },
    });
    await harness.invoke('assistant:start', {
      prompt: '阅读保存的笔记',
      context: { kind: 'note', noteId: NOTE_ID, revision: 3 },
    });
    await harness.invoke('assistant:cancel', { runId: RUN_ID });

    expect(harness.assistant.getCredentialStatus).toHaveBeenCalledTimes(1);
    expect(harness.assistant.configureCredential).toHaveBeenCalledExactlyOnceWith({
      apiKey: API_KEY,
    });
    expect(harness.assistant.removeCredential).toHaveBeenCalledTimes(1);
    expect(harness.assistant.getSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.assistant.start).toHaveBeenNthCalledWith(1, {
      prompt: '梳理下一步',
      context: { kind: 'tasks', taskIds: [TASK_ID] },
    });
    expect(harness.assistant.start).toHaveBeenNthCalledWith(2, {
      prompt: '阅读保存的笔记',
      context: { kind: 'note', noteId: NOTE_ID, revision: 3 },
    });
    expect(harness.assistant.cancel).toHaveBeenCalledExactlyOnceWith({ runId: RUN_ID });
    harness.unregister();
  });

  it.each([
    {
      prompt: '问题',
      context: { kind: 'none' },
      workspaceId: '44444444-4444-4444-8444-444444444444',
    },
    { prompt: '问题', context: { kind: 'none' }, model: 'attacker-model' },
    { prompt: '问题', context: { kind: 'none' }, endpoint: 'https://example.com/' },
    { prompt: '问题', context: { kind: 'note', noteId: NOTE_ID, revision: 1, body: '伪造' } },
    { prompt: '问题', context: { kind: 'tasks', taskIds: [TASK_ID], command: 'whoami' } },
  ])('rejects forged provider, workspace, or raw-context capabilities', async (input) => {
    const harness = await createHarness();

    await expect(harness.invoke('assistant:start', input)).rejects.toBeInstanceOf(TypeError);
    expect(harness.assistant.start).not.toHaveBeenCalled();
    harness.unregister();
  });

  it('rejects extra arguments and untrusted senders before controller access', async () => {
    const harness = await createHarness();
    await expect(
      harness.invoke('assistant:get-snapshot', { workspaceId: 'forged' }),
    ).rejects.toThrow(TypeError);

    const handler = electron.handlers.get('assistant:start');
    if (!handler) throw new Error('Missing assistant handler.');
    await expect(
      Promise.resolve().then(() =>
        handler(
          {
            sender: harness.webContents,
            senderFrame: { url: 'https://example.com/' },
          } as unknown as IpcMainInvokeEvent,
          { prompt: '问题', context: { kind: 'none' } },
        ),
      ),
    ).rejects.toThrow('Untrusted IPC sender');
    expect(harness.assistant.start).not.toHaveBeenCalled();
    harness.unregister();
  });
});

async function createHarness() {
  const { registerIpcHandlers } = await import('../src/main/ipc/register-handlers');
  const frame = { url: RENDERER_URL };
  const webContents = { mainFrame: frame };
  const snapshot: AssistantSnapshot = {
    sequence: 1,
    workspaceId: '44444444-4444-4444-8444-444444444444',
    phase: 'idle',
    runId: null,
    prompt: '',
    context: { kind: 'none' },
    contextSummary: {
      kind: 'none',
      label: '不附加工作区内容',
      includedCount: 0,
      totalCount: 0,
      truncated: false,
    },
    response: '',
    startedAt: null,
    completedAt: null,
    error: null,
  };
  const credentialStatus = {
    availability: 'available' as const,
    configured: true,
    removable: true,
    provider: 'OpenAI' as const,
    model: 'gpt-5.6' as const,
    reason: null,
  };
  const assistant = {
    getCredentialStatus: vi.fn(async () => credentialStatus),
    configureCredential: vi.fn(async () => credentialStatus),
    removeCredential: vi.fn(async () => ({
      ...credentialStatus,
      configured: false,
      removable: false,
    })),
    getSnapshot: vi.fn(() => snapshot),
    start: vi.fn(async () => snapshot),
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
    automation: {},
    assistant,
    terminal: {},
    trustedRendererLocation: { kind: 'packaged-file', url: RENDERER_URL },
  } as unknown as Parameters<typeof registerIpcHandlers>[0];
  const unregister = registerIpcHandlers(dependencies);
  const event = {
    sender: webContents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return {
    assistant,
    webContents,
    unregister,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = electron.handlers.get(channel);
      if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
      return handler(event, ...args);
    },
  };
}
