import { INBOX_CATEGORIES, type InboxCategory } from './contracts';

export const INBOX_CONTENT_MAX_LENGTH = 500;
export const INBOX_UNDO_WINDOW_MS = 15_000;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_CONTENT_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const VISIBLE_CONTENT_CHARACTER = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export function normalizeInboxId(value: unknown): string {
  return normalizeUuid(value, 'Inbox entry id');
}

export function normalizeInboxUndoToken(value: unknown): string {
  return normalizeUuid(value, 'Inbox undo token');
}

export function normalizeInboxContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Inbox content must be a string.');
  }
  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Inbox content must contain well-formed Unicode.');
  }

  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > INBOX_CONTENT_MAX_LENGTH ||
    FORBIDDEN_CONTENT_CHARACTER.test(normalized) ||
    !VISIBLE_CONTENT_CHARACTER.test(normalized)
  ) {
    throw new TypeError('Inbox content is empty, too long, or contains unsupported characters.');
  }
  return normalized;
}

export function normalizeInboxCategory(value: unknown): InboxCategory {
  if (typeof value !== 'string' || !INBOX_CATEGORIES.includes(value as InboxCategory)) {
    throw new TypeError('Inbox category is not supported.');
  }
  return value as InboxCategory;
}

function normalizeUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase UUID v4.`);
  }
  return value;
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
