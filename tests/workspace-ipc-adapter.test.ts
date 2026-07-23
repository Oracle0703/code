import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceIpcAdapter,
  type WorkspaceIpcPersistence,
} from '../src/main/workspace-ipc-adapter';
import { DEFAULT_WORKSPACE_PREFERENCES, type WorkspaceSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('workspace IPC adapter', () => {
  it('tracks a successful archive snapshot and discards exactly the target workspace', async () => {
    const snapshot = workspaceSnapshot(WORKSPACE_B);
    const persistence = createPersistence();
    persistence.archiveWorkspace.mockResolvedValue(snapshot);
    const order: string[] = [];
    const browser = { discardWorkspace: vi.fn(() => order.push('discard')) };
    const onSnapshot = vi.fn(() => order.push('snapshot'));
    const adapter = createWorkspaceIpcAdapter(persistence, browser, onSnapshot);

    await expect(adapter.archiveWorkspace({ workspaceId: WORKSPACE_A })).resolves.toBe(snapshot);
    expect(persistence.archiveWorkspace).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_A,
    });
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(browser.discardWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(order).toEqual(['discard', 'snapshot']);
  });

  it('does not track or discard a workspace when archival fails', async () => {
    const failure = new Error('archive failed');
    const persistence = createPersistence();
    persistence.archiveWorkspace.mockRejectedValue(failure);
    const browser = { discardWorkspace: vi.fn() };
    const onSnapshot = vi.fn();
    const adapter = createWorkspaceIpcAdapter(persistence, browser, onSnapshot);

    await expect(adapter.archiveWorkspace({ workspaceId: WORKSPACE_A })).rejects.toBe(failure);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(browser.discardWorkspace).not.toHaveBeenCalled();
  });

  it('does not report a committed archive as failed when native cleanup throws', async () => {
    const snapshot = workspaceSnapshot(WORKSPACE_B);
    const persistence = createPersistence();
    persistence.archiveWorkspace.mockResolvedValue(snapshot);
    const browser = {
      discardWorkspace: vi.fn(() => {
        throw new Error('native view already disappeared');
      }),
    };
    const onSnapshot = vi.fn();
    const adapter = createWorkspaceIpcAdapter(persistence, browser, onSnapshot);

    await expect(adapter.archiveWorkspace({ workspaceId: WORKSPACE_A })).resolves.toBe(snapshot);
    expect(browser.discardWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it('preserves all non-archive workspace operations', async () => {
    const snapshot = workspaceSnapshot(WORKSPACE_A);
    const persistence = createPersistence(snapshot);
    const browser = { discardWorkspace: vi.fn() };
    const onSnapshot = vi.fn();
    const adapter = createWorkspaceIpcAdapter(persistence, browser, onSnapshot);

    await adapter.getWorkspaceSnapshot();
    await adapter.createWorkspace({ name: 'Research', color: '#348bd4' });
    await adapter.renameWorkspace({ workspaceId: WORKSPACE_A, name: 'Renamed' });
    await adapter.activateWorkspace({ workspaceId: WORKSPACE_B });
    await adapter.updateWorkspacePreferences({
      workspaceId: WORKSPACE_A,
      patch: { browserOpen: false },
    });

    expect(persistence.getWorkspaceSnapshot).toHaveBeenCalledTimes(1);
    expect(persistence.createWorkspace).toHaveBeenCalledExactlyOnceWith({
      name: 'Research',
      color: '#348bd4',
    });
    expect(persistence.renameWorkspace).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_A,
      name: 'Renamed',
    });
    expect(persistence.activateWorkspace).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_B,
    });
    expect(persistence.updateWorkspacePreferences).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_A,
      patch: { browserOpen: false },
    });
    expect(onSnapshot).toHaveBeenCalledTimes(4);
    expect(browser.discardWorkspace).not.toHaveBeenCalled();
  });
});

function createPersistence(snapshot = workspaceSnapshot(WORKSPACE_A)) {
  return {
    getWorkspaceSnapshot: vi.fn(async () => snapshot),
    createWorkspace: vi.fn(async () => snapshot),
    renameWorkspace: vi.fn(async () => snapshot),
    activateWorkspace: vi.fn(async () => snapshot),
    archiveWorkspace: vi.fn(async () => snapshot),
    updateWorkspacePreferences: vi.fn(async () => DEFAULT_WORKSPACE_PREFERENCES),
  } satisfies WorkspaceIpcPersistence;
}

function workspaceSnapshot(currentWorkspaceId: string): WorkspaceSnapshot {
  return {
    currentWorkspaceId,
    workspaces: [
      {
        id: currentWorkspaceId,
        name: 'Workspace',
        color: '#7b6ee8',
        createdAt: '2026-07-22T12:00:00.000Z',
        updatedAt: '2026-07-22T12:00:00.000Z',
      },
    ],
    preferences: DEFAULT_WORKSPACE_PREFERENCES,
  };
}
