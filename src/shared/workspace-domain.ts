import {
  WORKSPACE_COLORS,
  WORKSPACE_THEMES,
  WORKSPACE_VIEW_IDS,
  type WorkspaceColor,
  type WorkspaceInfo,
  type WorkspacePreferences,
  type WorkspacePreferencesPatch,
  type WorkspaceTheme,
  type WorkspaceViewId,
} from './contracts';

export const WORKSPACE_NAME_MAX_LENGTH = 80;

const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function normalizeWorkspaceId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Workspace id must be a UUID.');
  }

  const normalized = value.toLowerCase();
  if (value !== normalized || !WORKSPACE_ID_PATTERN.test(normalized)) {
    throw new TypeError('Workspace id must be a UUID.');
  }
  return normalized;
}

export function normalizeWorkspaceName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Workspace name must be a string.');
  }

  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Workspace name must contain well-formed Unicode.');
  }
  const canonical = value.normalize('NFKC');
  if (WORKSPACE_NAME_FORBIDDEN_CHARACTER.test(canonical)) {
    throw new TypeError('Workspace name is empty, too long, or contains invisible characters.');
  }
  const normalized = canonical.trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new TypeError('Workspace name is empty, too long, or contains control characters.');
  }
  return normalized;
}

export function createWorkspaceNameKey(name: string): string {
  return normalizeWorkspaceName(name).toLowerCase();
}

export function normalizeWorkspaceColor(value: unknown): WorkspaceColor {
  if (typeof value !== 'string' || !WORKSPACE_COLORS.includes(value as WorkspaceColor)) {
    throw new TypeError('Workspace color is not supported.');
  }
  return value as WorkspaceColor;
}

export function normalizeWorkspacePreferencesPatch(value: unknown): WorkspacePreferencesPatch {
  if (!isRecord(value)) {
    throw new TypeError('Workspace preference patch must be an object.');
  }

  const allowedKeys = [
    'activeView',
    'theme',
    'sidebarCollapsed',
    'browserOpen',
    'browserWidth',
    'terminalOpen',
    'terminalHeight',
  ] as const;
  const keys = Object.keys(value);
  if (keys.length === 0) {
    throw new TypeError('Workspace preference patch must not be empty.');
  }
  const unknownKey = keys.find((key) => !allowedKeys.includes(key as (typeof allowedKeys)[number]));
  if (unknownKey) {
    throw new TypeError(`Unexpected workspace preference: ${unknownKey}`);
  }

  const patch: {
    -readonly [Key in keyof WorkspacePreferences]?: WorkspacePreferences[Key];
  } = {};
  if (hasOwn(value, 'activeView')) {
    if (
      typeof value.activeView !== 'string' ||
      !WORKSPACE_VIEW_IDS.includes(value.activeView as WorkspaceViewId)
    ) {
      throw new TypeError('Workspace view is not supported.');
    }
    patch.activeView = value.activeView as WorkspaceViewId;
  }
  if (hasOwn(value, 'theme')) {
    if (
      typeof value.theme !== 'string' ||
      !WORKSPACE_THEMES.includes(value.theme as WorkspaceTheme)
    ) {
      throw new TypeError('Workspace theme is not supported.');
    }
    patch.theme = value.theme as WorkspaceTheme;
  }
  for (const key of ['sidebarCollapsed', 'browserOpen', 'terminalOpen'] as const) {
    if (hasOwn(value, key)) {
      if (typeof value[key] !== 'boolean') {
        throw new TypeError(`${key} must be a boolean.`);
      }
      patch[key] = value[key];
    }
  }
  if (hasOwn(value, 'browserWidth')) {
    patch.browserWidth = integerInRange(value.browserWidth, 'browserWidth', 340, 720);
  }
  if (hasOwn(value, 'terminalHeight')) {
    patch.terminalHeight = integerInRange(value.terminalHeight, 'terminalHeight', 180, 2160);
  }
  return patch;
}

export function createWorkspaceMark(name: string): string {
  const normalized = normalizeWorkspaceName(name);
  const words = normalized.split(/\s+/u).filter(Boolean);
  if (words.length > 1) {
    return `${firstCharacter(words[0])}${firstCharacter(words[1])}`.toLocaleUpperCase();
  }
  return Array.from(normalized).slice(0, 2).join('').toLocaleUpperCase();
}

export function findCurrentWorkspace(snapshot: {
  readonly currentWorkspaceId: string;
  readonly workspaces: readonly WorkspaceInfo[];
}): WorkspaceInfo {
  const workspace = snapshot.workspaces.find(({ id }) => id === snapshot.currentWorkspaceId);
  if (!workspace) {
    throw new TypeError('Workspace snapshot does not contain its current workspace.');
  }
  return workspace;
}

const WORKSPACE_NAME_FORBIDDEN_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function firstCharacter(value: string): string {
  return Array.from(value)[0] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function integerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}
