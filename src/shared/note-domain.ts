export const NOTE_TITLE_MAX_LENGTH = 200;
export const NOTE_BODY_MAX_LENGTH = 100_000;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_TITLE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const VISIBLE_TITLE_CHARACTER = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export function normalizeNoteId(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError('Note id must be a lowercase UUID v4.');
  }
  return value;
}

export function normalizeNoteTitle(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Note title must be a string.');
  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Note title must contain well-formed Unicode.');
  }

  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > NOTE_TITLE_MAX_LENGTH ||
    FORBIDDEN_TITLE_CHARACTER.test(normalized) ||
    !VISIBLE_TITLE_CHARACTER.test(normalized)
  ) {
    throw new TypeError('Note title is empty, too long, or contains unsupported characters.');
  }
  return normalized;
}

export function normalizeNoteBody(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Note body must be a string.');
  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Note body must contain well-formed Unicode.');
  }

  const normalized = value.replace(/\r\n?/gu, '\n');
  if (
    Array.from(normalized).length > NOTE_BODY_MAX_LENGTH ||
    containsForbiddenBodyCharacter(normalized)
  ) {
    throw new TypeError('Note body is too long or contains unsupported control characters.');
  }
  return normalized;
}

export function normalizeNoteRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Note revision must be a positive safe integer.');
  }
  return value as number;
}

export function deriveNoteTitle(value: string): string {
  const body = normalizeNoteBody(value);
  const firstContentLine =
    body
      .split('\n')
      .map((line) => line.replace(/^\s{0,3}(?:#{1,6}|[-*+]>?)\s+/u, '').trim())
      .find(Boolean) ?? '无标题笔记';
  return normalizeNoteTitle(Array.from(firstContentLine).slice(0, NOTE_TITLE_MAX_LENGTH).join(''));
}

function containsForbiddenBodyCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 32 && codePoint !== 9 && codePoint !== 10) ||
      (codePoint >= 127 && codePoint <= 159) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
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
