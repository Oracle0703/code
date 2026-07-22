import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_COLORS,
  type WorkspaceSnapshot,
} from '../src/shared/contracts';
import { normalizeWorkspaceName } from '../src/shared/workspace-domain';
import {
  isLegacyWorkspaceImportCommitted,
  readLegacyWorkspacePreferences,
  rebaseWorkspaceMutationSnapshot,
  removeCommittedWorkspacePreferencePatch,
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

  it('keeps dirty fields until the matching value is committed', () => {
    expect(
      removeCommittedWorkspacePreferencePatch(
        { theme: 'dark', browserOpen: false, terminalHeight: 480 },
        { theme: 'light', browserOpen: false },
      ),
    ).toEqual({ theme: 'dark', terminalHeight: 480 });
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
