import { basename, isAbsolute, relative, resolve } from 'node:path';

const MAX_FILE_NAME_CODE_POINTS = 180;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const WINDOWS_UNSAFE_FILE_NAME_CHARACTERS = new Set('<>:"/\\|?*');

export function sanitizeDownloadFileName(input: string): string {
  const lastPathSegment = input.replaceAll('\\', '/').split('/').at(-1) ?? '';
  let fileName = Array.from(lastPathSegment.normalize('NFC'))
    .map((character) => (isUnsafeFileNameCharacter(character) ? '_' : character))
    .join('')
    .replace(/[. ]+$/gu, '')
    .trim();

  if (fileName === '' || fileName === '.' || fileName === '..') {
    fileName = 'download';
  }
  if (fileName.startsWith('.')) {
    fileName = `download${fileName}`;
  }
  if (WINDOWS_RESERVED_NAME.test(fileName)) {
    fileName = `_${fileName}`;
  }

  const codePoints = Array.from(fileName);
  if (codePoints.length > MAX_FILE_NAME_CODE_POINTS) {
    const dotIndex = fileName.lastIndexOf('.');
    const extension =
      dotIndex > 0 && fileName.length - dotIndex <= 20 ? fileName.slice(dotIndex) : '';
    const extensionLength = Array.from(extension).length;
    fileName = `${codePoints
      .slice(0, Math.max(1, MAX_FILE_NAME_CODE_POINTS - extensionLength))
      .join('')}${extension}`;
  }

  return fileName;
}

export function createDownloadDefaultPath(
  downloadsDirectory: string,
  suggestedName: string,
): string {
  if (!isAbsolute(downloadsDirectory)) {
    throw new TypeError('The downloads directory must be absolute');
  }

  const directory = resolve(downloadsDirectory);
  const candidate = resolve(directory, sanitizeDownloadFileName(suggestedName));
  const candidateRelativePath = relative(directory, candidate);
  if (
    candidateRelativePath === '' ||
    candidateRelativePath === '..' ||
    candidateRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(candidateRelativePath)
  ) {
    throw new TypeError('The download path escaped the downloads directory');
  }

  return candidate;
}

export function getSafeDownloadFileName(savePath: string, fallbackName: string): string {
  if (!isAbsolute(savePath) || savePath.includes('\0')) {
    return sanitizeDownloadFileName(fallbackName);
  }
  return sanitizeDownloadFileName(basename(savePath));
}

export function getDownloadSourceHost(urlChain: readonly string[]): string {
  for (const value of [...urlChain].reverse()) {
    const host = parseSourceHost(value);
    if (host) {
      return sanitizeDownloadDisplayText(host, 255);
    }
  }
  return '';
}

export function sanitizeDownloadDisplayText(input: string, maximumCodePoints: number): string {
  return Array.from(input.normalize('NFC'))
    .filter((character) => !isUnsafeDisplayCharacter(character))
    .slice(0, maximumCodePoints)
    .join('');
}

function isUnsafeFileNameCharacter(character: string): boolean {
  return isUnsafeDisplayCharacter(character) || WINDOWS_UNSAFE_FILE_NAME_CHARACTERS.has(character);
}

function isUnsafeDisplayCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function parseSourceHost(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname;
    }
    if (parsed.protocol === 'blob:') {
      const origin = new URL(parsed.pathname);
      if (origin.protocol === 'http:' || origin.protocol === 'https:') {
        return origin.hostname;
      }
    }
  } catch {
    // Ignore malformed or privileged URL metadata.
  }
  return '';
}
