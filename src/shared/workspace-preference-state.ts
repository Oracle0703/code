import {
  WORKSPACE_THEMES,
  WORKSPACE_VIEW_IDS,
  type WorkspacePreferencesPatch,
  type WorkspaceSnapshot,
  type WorkspaceTheme,
  type WorkspaceViewId,
} from './contracts';
import { normalizeWorkspacePreferencesPatch } from './workspace-domain';

export const LEGACY_WORKSPACE_STORAGE_KEYS = [
  'daily.navigation.view',
  'daily.workspace.current',
  'daily.appearance.theme',
  'daily.layout.sidebar-collapsed',
  'daily.layout.browser-open',
  'daily.layout.terminal-open',
  'daily.layout.browser-width',
  'daily.layout.terminal-height',
] as const;

export interface LegacyWorkspacePreferences {
  readonly found: boolean;
  readonly patch: WorkspacePreferencesPatch;
}

export function readLegacyWorkspacePreferences(
  read: (key: string) => string | null,
): LegacyWorkspacePreferences {
  const values = new Map<string, unknown>();
  let found = false;
  for (const key of LEGACY_WORKSPACE_STORAGE_KEYS) {
    let raw: string | null;
    try {
      raw = read(key);
    } catch {
      continue;
    }
    if (raw === null) continue;
    found = true;
    try {
      values.set(key, JSON.parse(raw) as unknown);
    } catch {
      // Invalid prototype state is ignored rather than entering SQLite.
    }
  }

  const candidate: {
    -readonly [Key in keyof WorkspacePreferencesPatch]?: WorkspacePreferencesPatch[Key];
  } = {};
  const activeView = values.get('daily.navigation.view');
  if (
    typeof activeView === 'string' &&
    WORKSPACE_VIEW_IDS.includes(activeView as WorkspaceViewId)
  ) {
    candidate.activeView = activeView as WorkspaceViewId;
  }
  const theme = values.get('daily.appearance.theme');
  if (typeof theme === 'string' && WORKSPACE_THEMES.includes(theme as WorkspaceTheme)) {
    candidate.theme = theme as WorkspaceTheme;
  }
  copyBoolean(values, candidate, 'daily.layout.sidebar-collapsed', 'sidebarCollapsed');
  copyBoolean(values, candidate, 'daily.layout.browser-open', 'browserOpen');
  copyBoolean(values, candidate, 'daily.layout.terminal-open', 'terminalOpen');
  copyInteger(values, candidate, 'daily.layout.browser-width', 'browserWidth', 340, 720);
  copyInteger(values, candidate, 'daily.layout.terminal-height', 'terminalHeight', 180, 2160);

  return {
    found,
    patch:
      Object.keys(candidate).length > 0 ? normalizeWorkspacePreferencesPatch(candidate) : candidate,
  };
}

export function mergeWorkspacePreferencePatches(
  current: WorkspacePreferencesPatch,
  next: WorkspacePreferencesPatch,
): WorkspacePreferencesPatch {
  return { ...current, ...next };
}

export function removeCommittedWorkspacePreferencePatch(
  dirty: WorkspacePreferencesPatch,
  committed: WorkspacePreferencesPatch,
): WorkspacePreferencesPatch {
  const remaining = { ...dirty };
  for (const key of Object.keys(committed) as Array<keyof WorkspacePreferencesPatch>) {
    if (remaining[key] === committed[key]) {
      delete remaining[key];
    }
  }
  return remaining;
}

export function isLegacyWorkspaceImportCommitted(
  pendingWorkspaceId: string | null,
  committedWorkspaceId: string,
  remainingPatch: WorkspacePreferencesPatch,
): boolean {
  return pendingWorkspaceId === committedWorkspaceId && Object.keys(remainingPatch).length === 0;
}

export function rebaseWorkspaceMutationSnapshot(
  mutationSnapshot: WorkspaceSnapshot,
  latestSnapshot: WorkspaceSnapshot | null,
  startedWorkspaceId: string | null,
  preferencesChanged: boolean,
  targetPatch: WorkspacePreferencesPatch = {},
): WorkspaceSnapshot {
  let rebased = mutationSnapshot;
  if (
    preferencesChanged &&
    latestSnapshot &&
    startedWorkspaceId !== null &&
    mutationSnapshot.currentWorkspaceId === startedWorkspaceId &&
    latestSnapshot.currentWorkspaceId === startedWorkspaceId
  ) {
    rebased = { ...mutationSnapshot, preferences: latestSnapshot.preferences };
  }
  return Object.keys(targetPatch).length > 0
    ? { ...rebased, preferences: { ...rebased.preferences, ...targetPatch } }
    : rebased;
}

function copyBoolean(
  values: ReadonlyMap<string, unknown>,
  candidate: {
    -readonly [Key in keyof WorkspacePreferencesPatch]?: WorkspacePreferencesPatch[Key];
  },
  storageKey: string,
  preferenceKey: 'browserOpen' | 'sidebarCollapsed' | 'terminalOpen',
): void {
  const value = values.get(storageKey);
  if (typeof value === 'boolean') candidate[preferenceKey] = value;
}

function copyInteger(
  values: ReadonlyMap<string, unknown>,
  candidate: {
    -readonly [Key in keyof WorkspacePreferencesPatch]?: WorkspacePreferencesPatch[Key];
  },
  storageKey: string,
  preferenceKey: 'browserWidth' | 'terminalHeight',
  minimum: number,
  maximum: number,
): void {
  const value = values.get(storageKey);
  if (Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum) {
    candidate[preferenceKey] = value as number;
  }
}
