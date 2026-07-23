export const BROWSER_DEFAULT_URL = 'https://www.google.com/';
export const BROWSER_DEFAULT_TITLE = 'New tab';
export const BROWSER_TITLE_MAX_LENGTH = 512;
export const BROWSER_MAX_TABS = 12;
export const BROWSER_MAX_BOOKMARKS = 500;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_TITLE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]+/gu;
const VISIBLE_TITLE_CHARACTER = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export function normalizeBrowserId(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError('Browser id must be a lowercase UUID v4.');
  }
  return value;
}

export function sanitizeBrowserTitle(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) {
    return BROWSER_DEFAULT_TITLE;
  }

  const normalized = value.replace(FORBIDDEN_TITLE_CHARACTER, ' ').trim();
  const visible = VISIBLE_TITLE_CHARACTER.test(normalized) ? normalized : BROWSER_DEFAULT_TITLE;
  return Array.from(visible).slice(0, BROWSER_TITLE_MAX_LENGTH).join('');
}

export function normalizeBrowserTitle(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) {
    throw new TypeError('Browser title must contain well-formed Unicode.');
  }
  const normalized = sanitizeBrowserTitle(value);
  if (value !== normalized) {
    throw new TypeError('Browser title is not in its persisted form.');
  }
  return normalized;
}

export function normalizeBrowserRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Browser revision must be a positive safe integer.');
  }
  return value as number;
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
