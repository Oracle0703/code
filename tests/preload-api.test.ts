import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchApi } from '../src/shared/contracts';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(() => Promise.resolve(undefined)),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

let api: WorkbenchApi;

beforeAll(async () => {
  await import('../src/preload/index');
  expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1);
  api = electron.exposeInMainWorld.mock.calls[0]?.[1] as WorkbenchApi;
});

beforeEach(() => {
  electron.invoke.mockClear();
  electron.on.mockClear();
  electron.removeListener.mockClear();
});

describe('preload inbox API', () => {
  it('exposes only the declared inbox methods and capture event', () => {
    expect(Object.keys(api.inbox).sort()).toEqual([
      'archive',
      'categorize',
      'create',
      'getSnapshot',
      'onCaptureRequest',
      'undoArchive',
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.inbox)).toBe(true);
  });

  it('forwards exact inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const entryId = '223e4567-e89b-42d3-a456-426614174000';
    const undoToken = '323e4567-e89b-42d3-a456-426614174000';

    await api.inbox.getSnapshot({ workspaceId });
    await api.inbox.create({ workspaceId, content: '记录', category: 'note' });
    await api.inbox.categorize({ workspaceId, entryId, category: 'task' });
    await api.inbox.archive({ workspaceId, entryId });
    await api.inbox.undoArchive({ workspaceId, undoToken });

    expect(electron.invoke.mock.calls).toEqual([
      ['inbox:get-snapshot', { workspaceId }],
      ['inbox:create', { workspaceId, content: '记录', category: 'note' }],
      ['inbox:categorize', { workspaceId, entryId, category: 'task' }],
      ['inbox:archive', { workspaceId, entryId }],
      ['inbox:undo-archive', { workspaceId, undoToken }],
    ]);
  });

  it('subscribes and removes the Main-triggered quick-capture listener', () => {
    const listener = vi.fn();
    const unsubscribe = api.inbox.onCaptureRequest(listener);
    expect(electron.on).toHaveBeenCalledWith('inbox:capture-requested', expect.any(Function));

    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    wrapped({}, undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith('inbox:capture-requested', wrapped);
  });
});
