import {
  WORKSPACE_THEMES,
  WORKSPACE_VIEW_IDS,
  type WorkspacePreferences,
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

export type WorkspacePreferenceKey = keyof WorkspacePreferencesPatch;

export interface WorkspacePreferenceWriteIntent {
  readonly epoch: number;
  readonly sequence: number;
  readonly workspaceId: string;
  readonly patch: WorkspacePreferencesPatch;
  readonly generations: Readonly<Partial<Record<WorkspacePreferenceKey, number>>>;
}

export class WorkspacePreferenceRetryGate {
  #generation = 0;
  #active: Promise<boolean> | null = null;

  run(task: () => Promise<boolean>): Promise<boolean> {
    if (this.#active) return this.#active;
    const generation = this.#generation;
    const active = task();
    this.#active = active;
    void active.then(
      () => this.#finish(active, generation),
      () => this.#finish(active, generation),
    );
    return active;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#active = null;
  }

  #finish(active: Promise<boolean>, generation: number): void {
    if (generation === this.#generation && this.#active === active) {
      this.#active = null;
    }
  }
}

interface WorkspacePreferenceDirtyField {
  readonly value: WorkspacePreferencesPatch[WorkspacePreferenceKey];
  readonly generation: number;
  readonly failed: boolean;
}

type WorkspacePreferenceDirtyFields = Partial<
  Record<WorkspacePreferenceKey, WorkspacePreferenceDirtyField>
>;

/**
 * Owns the identity of optimistic workspace-preference writes.
 *
 * A value comparison alone cannot distinguish A → B → A: the completion for
 * the first A must not clear the retry payload for the later A. Each dirty
 * field therefore carries the generation of the write (or staged change) that
 * currently owns it, and completions can only affect matching generations in
 * the current database epoch.
 */
export class WorkspacePreferenceWriteCoordinator {
  #epoch = 1;
  #sequence = 0;
  readonly #dirty = new Map<string, WorkspacePreferenceDirtyFields>();

  get epoch(): number {
    return this.#epoch;
  }

  get dirtyWorkspaceCount(): number {
    return this.#dirty.size;
  }

  get hasDirtyPreferences(): boolean {
    return this.#dirty.size > 0;
  }

  get hasFailedPreferences(): boolean {
    for (const fields of this.#dirty.values()) {
      if (Object.values(fields).some((field) => field?.failed)) return true;
    }
    return false;
  }

  isCurrent(intent: WorkspacePreferenceWriteIntent): boolean {
    return intent.epoch === this.#epoch;
  }

  beginWrite(
    workspaceId: string,
    patch: WorkspacePreferencesPatch,
  ): WorkspacePreferenceWriteIntent {
    const normalizedPatch = immutablePreferencePatch(patch);
    const sequence = ++this.#sequence;
    const fields = this.#dirty.get(workspaceId) ?? {};
    const generations: Partial<Record<WorkspacePreferenceKey, number>> = {};
    for (const key of preferenceKeys(normalizedPatch)) {
      fields[key] = {
        value: normalizedPatch[key],
        generation: sequence,
        failed: false,
      };
      generations[key] = sequence;
    }
    this.#dirty.set(workspaceId, fields);
    return immutableWriteIntent(this.#epoch, sequence, workspaceId, normalizedPatch, generations);
  }

  stage(workspaceId: string, patch: WorkspacePreferencesPatch): void {
    const normalizedPatch = immutablePreferencePatch(patch);
    const generation = ++this.#sequence;
    const fields = this.#dirty.get(workspaceId) ?? {};
    for (const key of preferenceKeys(normalizedPatch)) {
      fields[key] = {
        value: normalizedPatch[key],
        generation,
        failed: false,
      };
    }
    this.#dirty.set(workspaceId, fields);
  }

  beginRetry(workspaceId: string): WorkspacePreferenceWriteIntent | null {
    const fields = this.#dirty.get(workspaceId);
    if (!fields) return null;
    const patch = preferencePatchFromFields(fields);
    if (preferenceKeys(patch).length === 0) {
      this.#dirty.delete(workspaceId);
      return null;
    }
    return this.beginWrite(workspaceId, patch);
  }

  settleSuccess(
    intent: WorkspacePreferenceWriteIntent,
    authoritative: WorkspacePreferences,
  ): boolean {
    if (intent.epoch !== this.#epoch) return false;
    const fields = this.#dirty.get(intent.workspaceId);
    if (!fields) return true;
    let confirmed = true;
    for (const key of preferenceKeys(intent.patch)) {
      const field = fields[key];
      if (!field || field.generation !== intent.generations[key]) continue;
      if (authoritative[key] === intent.patch[key]) {
        delete fields[key];
      } else {
        fields[key] = {
          value: field.value,
          generation: field.generation,
          failed: true,
        };
        confirmed = false;
      }
    }
    if (preferenceKeysFromFields(fields).length === 0) {
      this.#dirty.delete(intent.workspaceId);
    }
    return confirmed;
  }

  settleFailure(intent: WorkspacePreferenceWriteIntent): boolean {
    if (intent.epoch !== this.#epoch) return false;
    const fields = this.#dirty.get(intent.workspaceId);
    if (!fields) return false;
    let marked = false;
    for (const key of preferenceKeys(intent.patch)) {
      const field = fields[key];
      if (!field || field.generation !== intent.generations[key]) continue;
      fields[key] = {
        value: field.value,
        generation: field.generation,
        failed: true,
      };
      marked = true;
    }
    return marked;
  }

  getDirtyPatch(workspaceId: string): WorkspacePreferencesPatch {
    const fields = this.#dirty.get(workspaceId);
    return fields ? preferencePatchFromFields(fields) : {};
  }

  getDirtyWorkspaces(): readonly string[] {
    return [...this.#dirty.keys()];
  }

  isFieldFailed(workspaceId: string, key: WorkspacePreferenceKey): boolean {
    return this.#dirty.get(workspaceId)?.[key]?.failed ?? false;
  }

  discardMissingWorkspaces(activeWorkspaceIds: ReadonlySet<string>): void {
    for (const workspaceId of this.#dirty.keys()) {
      if (!activeWorkspaceIds.has(workspaceId)) this.#dirty.delete(workspaceId);
    }
  }

  invalidate(): void {
    this.#epoch += 1;
    this.#sequence = 0;
    this.#dirty.clear();
  }
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

function immutablePreferencePatch(
  patch: WorkspacePreferencesPatch,
): Readonly<WorkspacePreferencesPatch> {
  return Object.freeze({ ...normalizeWorkspacePreferencesPatch(patch) });
}

function immutableWriteIntent(
  epoch: number,
  sequence: number,
  workspaceId: string,
  patch: Readonly<WorkspacePreferencesPatch>,
  generations: Partial<Record<WorkspacePreferenceKey, number>>,
): WorkspacePreferenceWriteIntent {
  return Object.freeze({
    epoch,
    sequence,
    workspaceId,
    patch,
    generations: Object.freeze({ ...generations }),
  });
}

function preferenceKeys(patch: WorkspacePreferencesPatch): readonly WorkspacePreferenceKey[] {
  return Object.keys(patch) as WorkspacePreferenceKey[];
}

function preferenceKeysFromFields(
  fields: WorkspacePreferenceDirtyFields,
): readonly WorkspacePreferenceKey[] {
  return Object.keys(fields) as WorkspacePreferenceKey[];
}

function preferencePatchFromFields(
  fields: WorkspacePreferenceDirtyFields,
): WorkspacePreferencesPatch {
  return Object.fromEntries(
    preferenceKeysFromFields(fields).flatMap((key) => {
      const field = fields[key];
      return field ? [[key, field.value] as const] : [];
    }),
  ) as WorkspacePreferencesPatch;
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
