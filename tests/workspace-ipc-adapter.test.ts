import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceIpcAdapter,
  type WorkspaceIpcPersistence,
} from '../src/main/workspace-ipc-adapter';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  type WorkspaceArchiveSnapshot,
  type WorkspaceRestoreResult,
  type WorkspaceSnapshot,
} from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('workspace IPC adapter', () => {
  it('tracks a successful archive snapshot and discards exactly the target workspace', async () => {
    const snapshot = workspaceSnapshot(WORKSPACE_B);
    const persistence = createPersistence();
    persistence.archiveWorkspace.mockResolvedValue(snapshot);
    const order: string[] = [];
    const browser = { discardWorkspace: vi.fn(() => order.push('discard')) };
    const terminal = {
      setActiveWorkspace: vi.fn(() => order.push('activate-terminal')),
      discardWorkspace: vi.fn(() => order.push('discard-terminal')),
    };
    const onSnapshot = vi.fn(() => order.push('snapshot'));
    const onWorkspaceArchived = vi.fn(() => order.push('discard-assistant'));
    const adapter = createWorkspaceIpcAdapter(
      persistence,
      browser,
      terminal,
      onSnapshot,
      onWorkspaceArchived,
    );

    await expect(adapter.archiveWorkspace({ workspaceId: WORKSPACE_A })).resolves.toBe(snapshot);
    expect(persistence.archiveWorkspace).toHaveBeenCalledExactlyOnceWith({
      workspaceId: WORKSPACE_A,
    });
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(browser.discardWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(terminal.setActiveWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_B);
    expect(terminal.discardWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(onWorkspaceArchived).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(order).toEqual([
      'activate-terminal',
      'discard',
      'discard-terminal',
      'discard-assistant',
      'snapshot',
    ]);
  });

  it('does not track or discard a workspace when archival fails', async () => {
    const failure = new Error('archive failed');
    const persistence = createPersistence();
    persistence.archiveWorkspace.mockRejectedValue(failure);
    const browser = { discardWorkspace: vi.fn() };
    const terminal = { setActiveWorkspace: vi.fn(), discardWorkspace: vi.fn() };
    const onSnapshot = vi.fn();
    const onWorkspaceArchived = vi.fn();
    const adapter = createWorkspaceIpcAdapter(
      persistence,
      browser,
      terminal,
      onSnapshot,
      onWorkspaceArchived,
    );

    await expect(adapter.archiveWorkspace({ workspaceId: WORKSPACE_A })).rejects.toBe(failure);
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(browser.discardWorkspace).not.toHaveBeenCalled();
    expect(terminal.setActiveWorkspace).not.toHaveBeenCalled();
    expect(terminal.discardWorkspace).not.toHaveBeenCalled();
    expect(onWorkspaceArchived).not.toHaveBeenCalled();
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
    const terminal = {
      setActiveWorkspace: vi.fn(),
      discardWorkspace: vi.fn(() => {
        throw new Error('terminal process already disappeared');
      }),
    };
    const onSnapshot = vi.fn();
    const onWorkspaceArchived = vi.fn(() => {
      throw new Error('assistant runtime already disappeared');
    });
    const adapter = createWorkspaceIpcAdapter(
      persistence,
      browser,
      terminal,
      onSnapshot,
      onWorkspaceArchived,
    );

    await expect(adapter.archiveWorkspace({ workspaceId: WORKSPACE_A })).resolves.toBe(snapshot);
    expect(browser.discardWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(terminal.setActiveWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_B);
    expect(terminal.discardWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(onWorkspaceArchived).toHaveBeenCalledExactlyOnceWith(WORKSPACE_A);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it('reads the authoritative archive snapshot without changing active runtime state', async () => {
    const archiveSnapshot = workspaceArchiveSnapshot();
    const persistence = createPersistence();
    persistence.getWorkspaceArchiveSnapshot.mockResolvedValue(archiveSnapshot);
    const browser = { discardWorkspace: vi.fn() };
    const terminal = { setActiveWorkspace: vi.fn(), discardWorkspace: vi.fn() };
    const onSnapshot = vi.fn();
    const onWorkspaceArchived = vi.fn();
    const adapter = createWorkspaceIpcAdapter(
      persistence,
      browser,
      terminal,
      onSnapshot,
      onWorkspaceArchived,
    );

    await expect(adapter.getWorkspaceArchiveSnapshot()).resolves.toBe(archiveSnapshot);
    expect(persistence.getWorkspaceArchiveSnapshot).toHaveBeenCalledExactlyOnceWith();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(browser.discardWorkspace).not.toHaveBeenCalled();
    expect(terminal.setActiveWorkspace).not.toHaveBeenCalled();
    expect(terminal.discardWorkspace).not.toHaveBeenCalled();
    expect(onWorkspaceArchived).not.toHaveBeenCalled();
  });

  it('tracks the authoritative restored snapshot without rebuilding or discarding runtimes', async () => {
    const result = workspaceRestoreResult(workspaceSnapshot(WORKSPACE_B));
    const persistence = createPersistence();
    persistence.restoreWorkspace.mockResolvedValue(result);
    const order: string[] = [];
    const browser = { discardWorkspace: vi.fn(() => order.push('discard-browser')) };
    const terminal = {
      setActiveWorkspace: vi.fn(() => order.push('activate-terminal')),
      discardWorkspace: vi.fn(() => order.push('discard-terminal')),
    };
    const onSnapshot = vi.fn(() => order.push('snapshot'));
    const onWorkspaceArchived = vi.fn(() => order.push('discard-assistant'));
    const adapter = createWorkspaceIpcAdapter(
      persistence,
      browser,
      terminal,
      onSnapshot,
      onWorkspaceArchived,
    );
    const input = {
      workspaceId: WORKSPACE_A,
      expectedRevision: 4,
      name: 'Restored workspace',
    };

    await expect(adapter.restoreWorkspace(input)).resolves.toBe(result);
    expect(persistence.restoreWorkspace).toHaveBeenCalledExactlyOnceWith(input);
    expect(terminal.setActiveWorkspace).toHaveBeenCalledExactlyOnceWith(WORKSPACE_B);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(result.workspaceSnapshot);
    expect(browser.discardWorkspace).not.toHaveBeenCalled();
    expect(terminal.discardWorkspace).not.toHaveBeenCalled();
    expect(onWorkspaceArchived).not.toHaveBeenCalled();
    expect(order).toEqual(['activate-terminal', 'snapshot']);
  });

  it('preserves all non-archive workspace operations', async () => {
    const snapshot = workspaceSnapshot(WORKSPACE_A);
    const persistence = createPersistence(snapshot);
    const browser = { discardWorkspace: vi.fn() };
    const terminal = { setActiveWorkspace: vi.fn(), discardWorkspace: vi.fn() };
    const onSnapshot = vi.fn();
    const adapter = createWorkspaceIpcAdapter(persistence, browser, terminal, onSnapshot);

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
    expect(terminal.setActiveWorkspace).toHaveBeenCalledTimes(4);
    expect(terminal.setActiveWorkspace).toHaveBeenNthCalledWith(1, WORKSPACE_A);
    expect(terminal.setActiveWorkspace).toHaveBeenNthCalledWith(2, WORKSPACE_A);
    expect(terminal.setActiveWorkspace).toHaveBeenNthCalledWith(3, WORKSPACE_A);
    // The adapter follows the authoritative snapshot returned by persistence,
    // rather than trusting the requested activation target.
    expect(terminal.setActiveWorkspace).toHaveBeenNthCalledWith(4, WORKSPACE_A);
    expect(terminal.discardWorkspace).not.toHaveBeenCalled();
  });
});

function createPersistence(snapshot = workspaceSnapshot(WORKSPACE_A)) {
  return {
    getWorkspaceSnapshot: vi.fn(async () => snapshot),
    getWorkspaceArchiveSnapshot: vi.fn(async () => workspaceArchiveSnapshot()),
    createWorkspace: vi.fn(async () => snapshot),
    renameWorkspace: vi.fn(async () => snapshot),
    activateWorkspace: vi.fn(async () => snapshot),
    archiveWorkspace: vi.fn(async () => snapshot),
    restoreWorkspace: vi.fn(async () => workspaceRestoreResult(snapshot)),
    updateWorkspacePreferences: vi.fn(async () => DEFAULT_WORKSPACE_PREFERENCES),
  } satisfies WorkspaceIpcPersistence;
}

function workspaceArchiveSnapshot(): WorkspaceArchiveSnapshot {
  return {
    archivedWorkspaces: [
      {
        id: WORKSPACE_A,
        name: 'Archived workspace',
        color: '#348bd4',
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-22T12:00:00.000Z',
        archivedAt: '2026-07-23T12:00:00.000Z',
        revision: 4,
      },
    ],
  };
}

function workspaceRestoreResult(workspaceSnapshot: WorkspaceSnapshot): WorkspaceRestoreResult {
  return {
    workspaceSnapshot,
    archiveSnapshot: { archivedWorkspaces: [] },
  };
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
