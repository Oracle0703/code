import { TERMINAL_PROFILE_IDS, type TerminalProfileId } from './contracts';

export const TERMINAL_HOST_PLATFORMS = ['win32', 'darwin', 'linux'] as const;
export type TerminalHostPlatform = (typeof TERMINAL_HOST_PLATFORMS)[number];

export const TERMINAL_PATH_MAX_LENGTH = 4_096;
export const WSL_DISTRIBUTION_NAME_MAX_LENGTH = 256;
export const WSL_DISTRIBUTION_ID_PATTERN = /^wsl-[0-9a-f]{64}$/u;

export function normalizeTerminalProfileId(value: unknown): TerminalProfileId {
  if (typeof value !== 'string' || !TERMINAL_PROFILE_IDS.includes(value as TerminalProfileId)) {
    throw new TypeError('Terminal profile is not supported.');
  }
  return value as TerminalProfileId;
}

export function normalizeTerminalPreferenceRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Terminal preference revision is invalid.');
  }
  return value as number;
}

export function normalizeTerminalHostPlatform(value: unknown): TerminalHostPlatform {
  if (
    typeof value !== 'string' ||
    !TERMINAL_HOST_PLATFORMS.includes(value as TerminalHostPlatform)
  ) {
    throw new TypeError('Terminal host platform is not supported.');
  }
  return value as TerminalHostPlatform;
}

export function normalizeStoredTerminalPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isWellFormedUnicode(value) ||
    Array.from(value).length < 1 ||
    Array.from(value).length > TERMINAL_PATH_MAX_LENGTH ||
    containsForbiddenCharacters(value)
  ) {
    throw new TypeError('Terminal working directory is invalid.');
  }
  return value;
}

export function normalizeWslDistributionName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isWellFormedUnicode(value) ||
    value !== value.trim() ||
    Array.from(value).length < 1 ||
    Array.from(value).length > WSL_DISTRIBUTION_NAME_MAX_LENGTH ||
    value.startsWith('-') ||
    containsForbiddenCharacters(value)
  ) {
    throw new TypeError('WSL distribution name is invalid.');
  }
  return value;
}

export function normalizeWslDistributionId(value: unknown): string {
  if (typeof value !== 'string' || !WSL_DISTRIBUTION_ID_PATTERN.test(value)) {
    throw new TypeError('WSL distribution id is invalid.');
  }
  return value;
}

function containsForbiddenCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 31 || codePoint === 127 || /\p{Default_Ignorable_Code_Point}/u.test(character)
    );
  });
}

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
