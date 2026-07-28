import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_COLORS,
  type WorkspaceSnapshot,
} from '../src/shared/contracts';
import { normalizeWorkspaceName } from '../src/shared/workspace-domain';
import {
  WorkspacePreferenceRetryGate,
  WorkspacePreferenceWriteCoordinator,
  isLegacyWorkspaceImportCommitted,
  readLegacyWorkspacePreferences,
  rebaseWorkspaceMutationSnapshot,
} from '../src/shared/workspace-preference-state';

const FIRST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

describe('workspace renderer state helpers', () => {
  it('imports only valid legacy layout values', () => {
    const legacy = new Map<string, string>([
      ['daily.navigation.view', JSON.stringify('notes')],
      ['daily.workspace.current', JSON.stringify('work')],
      ['daily.appearance.theme', JSON.stringify('light')],
      ['daily.layout.sidebar-collapsed', JSON.stringify(true)],
      ['daily.layout.browser-open', JSON.stringify(false)],
      ['daily.layout.browser-width', JSON.stringify(612)],
      ['daily.layout.terminal-open', JSON.stringify('not-a-boolean')],
      ['daily.layout.terminal-height', JSON.stringify(9999)],
    ]);

    expect(readLegacyWorkspacePreferences((key) => legacy.get(key) ?? null)).toEqual({
      found: true,
      patch: {
        activeView: 'notes',
        theme: 'light',
        sidebarCollapsed: true,
        browserOpen: false,
        browserWidth: 612,
      },
    });
  });

  it('clears legacy storage only after every imported field commits to its workspace', () => {
    expect(isLegacyWorkspaceImportCommitted(FIRST_ID, FIRST_ID, { theme: 'light' })).toBe(false);
    expect(isLegacyWorkspaceImportCommitted(FIRST_ID, SECOND_ID, {})).toBe(false);
    expect(isLegacyWorkspaceImportCommitted(FIRST_ID, FIRST_ID, {})).toBe(true);
  });

  it('rebases a stale mutation snapshot onto newer preferences for the same workspace', () => {
    const mutation = snapshot(FIRST_ID, { browserOpen: true, theme: 'dark' });
    const latest = snapshot(FIRST_ID, { browserOpen: false, theme: 'light' });
    expect(
      rebaseWorkspaceMutationSnapshot(mutation, latest, FIRST_ID, true).preferences,
    ).toMatchObject({ browserOpen: false, theme: 'light' });

    const switched = snapshot(SECOND_ID, { browserOpen: true, theme: 'dark' });
    expect(rebaseWorkspaceMutationSnapshot(switched, latest, FIRST_ID, true)).toBe(switched);
    expect(
      rebaseWorkspaceMutationSnapshot(switched, latest, FIRST_ID, true, {
        browserOpen: false,
      }).preferences.browserOpen,
    ).toBe(false);
  });

  it('keeps the latest A intent dirty across an A → B → A completion sequence', () => {
    const coordinator = new WorkspacePreferenceWriteCoordinator();
    const firstA = coordinator.beginWrite(FIRST_ID, { theme: 'dark' });
    const middleB = coordinator.beginWrite(FIRST_ID, { theme: 'light' });
    const latestA = coordinator.beginWrite(FIRST_ID, { theme: 'dark' });

    expect(coordinator.settleSuccess(firstA, preferences({ theme: 'dark' }))).toBe(true);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({ theme: 'dark' });
    expect(coordinator.settleSuccess(middleB, preferences({ theme: 'light' }))).toBe(true);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({ theme: 'dark' });

    expect(coordinator.settleFailure(latestA)).toBe(true);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({ theme: 'dark' });
    expect(coordinator.isFieldFailed(FIRST_ID, 'theme')).toBe(true);
    expect(coordinator.hasFailedPreferences).toBe(true);
  });

  it('does not let an unrelated success clear a current failed preference', () => {
    const coordinator = new WorkspacePreferenceWriteCoordinator();
    const failed = coordinator.beginWrite(FIRST_ID, { browserOpen: false });
    const unrelated = coordinator.beginWrite(SECOND_ID, { terminalOpen: false });

    expect(coordinator.settleFailure(failed)).toBe(true);
    expect(coordinator.settleSuccess(unrelated, preferences({ terminalOpen: false }))).toBe(true);

    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({ browserOpen: false });
    expect(coordinator.isFieldFailed(FIRST_ID, 'browserOpen')).toBe(true);
    expect(coordinator.hasFailedPreferences).toBe(true);
    expect(coordinator.dirtyWorkspaceCount).toBe(1);
  });

  it('allocates a fresh generation when retrying the exact current dirty patch', () => {
    const coordinator = new WorkspacePreferenceWriteCoordinator();
    const failed = coordinator.beginWrite(FIRST_ID, {
      browserOpen: false,
      terminalHeight: 480,
    });
    coordinator.settleFailure(failed);

    const retry = coordinator.beginRetry(FIRST_ID);

    expect(retry).not.toBeNull();
    expect(retry!.sequence).toBeGreaterThan(failed.sequence);
    expect(retry!.patch).toEqual({ browserOpen: false, terminalHeight: 480 });
    expect(coordinator.hasFailedPreferences).toBe(false);
    expect(coordinator.settleFailure(failed)).toBe(false);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({
      browserOpen: false,
      terminalHeight: 480,
    });

    expect(
      coordinator.settleSuccess(retry!, preferences({ browserOpen: false, terminalHeight: 480 })),
    ).toBe(true);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({});
    expect(coordinator.hasDirtyPreferences).toBe(false);
  });

  it('settles multi-field writes independently when only one field is superseded', () => {
    const coordinator = new WorkspacePreferenceWriteCoordinator();
    const first = coordinator.beginWrite(FIRST_ID, {
      theme: 'dark',
      browserOpen: false,
    });
    coordinator.beginWrite(FIRST_ID, { theme: 'light' });

    expect(
      coordinator.settleSuccess(first, preferences({ theme: 'dark', browserOpen: false })),
    ).toBe(true);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({ theme: 'light' });
  });

  it('freezes write identity and rejects completions from an invalidated epoch', () => {
    const coordinator = new WorkspacePreferenceWriteCoordinator();
    const mutablePatch: { theme: 'dark' | 'light' } = { theme: 'dark' };
    const stale = coordinator.beginWrite(FIRST_ID, mutablePatch);

    expect(Object.isFrozen(stale)).toBe(true);
    expect(Object.isFrozen(stale.patch)).toBe(true);
    expect(Object.isFrozen(stale.generations)).toBe(true);
    mutablePatch.theme = 'light';
    expect(stale.patch).toEqual({ theme: 'dark' });

    coordinator.invalidate();
    const current = coordinator.beginWrite(FIRST_ID, { theme: 'light' });

    expect(current.epoch).toBeGreaterThan(stale.epoch);
    expect(coordinator.isCurrent(stale)).toBe(false);
    expect(coordinator.isCurrent(current)).toBe(true);
    expect(coordinator.settleSuccess(stale, preferences({ theme: 'dark' }))).toBe(false);
    expect(coordinator.settleFailure(stale)).toBe(false);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({ theme: 'light' });
    expect(coordinator.settleSuccess(current, preferences({ theme: 'light' }))).toBe(true);
    expect(coordinator.hasDirtyPreferences).toBe(false);
  });

  it('keeps and fails only current fields that the authoritative result does not confirm', () => {
    const coordinator = new WorkspacePreferenceWriteCoordinator();
    const intent = coordinator.beginWrite(FIRST_ID, {
      theme: 'light',
      browserOpen: false,
    });

    expect(
      coordinator.settleSuccess(intent, preferences({ theme: 'dark', browserOpen: false })),
    ).toBe(false);
    expect(coordinator.getDirtyPatch(FIRST_ID)).toEqual({ theme: 'light' });
    expect(coordinator.isFieldFailed(FIRST_ID, 'theme')).toBe(true);
    expect(coordinator.isFieldFailed(FIRST_ID, 'browserOpen')).toBe(false);
  });

  it('deduplicates retry double-clicks until the shared task settles', async () => {
    const gate = new WorkspacePreferenceRetryGate();
    let calls = 0;
    let resolve!: (value: boolean) => void;
    const task = new Promise<boolean>((complete) => {
      resolve = complete;
    });

    const first = gate.run(() => {
      calls += 1;
      return task;
    });
    const duplicate = gate.run(() => {
      calls += 1;
      return Promise.resolve(false);
    });

    expect(duplicate).toBe(first);
    expect(calls).toBe(1);
    resolve(true);
    await expect(first).resolves.toBe(true);

    const next = gate.run(async () => {
      calls += 1;
      return false;
    });
    expect(next).not.toBe(first);
    await expect(next).resolves.toBe(false);
    expect(calls).toBe(2);
  });

  it('does not let an invalidated retry finally release a newer retry', async () => {
    const gate = new WorkspacePreferenceRetryGate();
    let resolveOld!: (value: boolean) => void;
    let resolveCurrent!: (value: boolean) => void;
    const oldTask = new Promise<boolean>((complete) => {
      resolveOld = complete;
    });
    const currentTask = new Promise<boolean>((complete) => {
      resolveCurrent = complete;
    });

    const oldRetry = gate.run(() => oldTask);
    gate.invalidate();
    const currentRetry = gate.run(() => currentTask);

    resolveOld(true);
    await expect(oldRetry).resolves.toBe(true);
    expect(gate.run(() => Promise.resolve(false))).toBe(currentRetry);

    resolveCurrent(true);
    await expect(currentRetry).resolves.toBe(true);
  });
});

describe('workspace name safety', () => {
  it('accepts normalized visible Unicode and rejects hidden or malformed text', () => {
    expect(normalizeWorkspaceName('  研发 🧪  ')).toBe('研发 🧪');
    expect(normalizeWorkspaceName('A\u030A')).toBe('Å');

    for (const invalid of ['Wo\u200Brk', '\u202Eabc', 'line\u2028break', 'broken\ud800']) {
      expect(() => normalizeWorkspaceName(invalid)).toThrow();
    }
  });
});

function snapshot(
  currentWorkspaceId: string,
  patch: Partial<typeof DEFAULT_WORKSPACE_PREFERENCES>,
): WorkspaceSnapshot {
  return {
    currentWorkspaceId,
    workspaces: [
      {
        id: currentWorkspaceId,
        name: currentWorkspaceId === FIRST_ID ? '第一空间' : '第二空间',
        color: WORKSPACE_COLORS[0],
        createdAt: '2026-07-22T12:00:00.000Z',
        updatedAt: '2026-07-22T12:00:00.000Z',
      },
    ],
    preferences: { ...DEFAULT_WORKSPACE_PREFERENCES, ...patch },
  };
}

function preferences(
  patch: Partial<typeof DEFAULT_WORKSPACE_PREFERENCES>,
): typeof DEFAULT_WORKSPACE_PREFERENCES {
  return { ...DEFAULT_WORKSPACE_PREFERENCES, ...patch };
}
