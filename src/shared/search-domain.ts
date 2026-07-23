import { SEARCH_SCOPES, type SearchScope } from './contracts';

export const SEARCH_QUERY_MIN_LENGTH = 2;
export const SEARCH_QUERY_MAX_LENGTH = 120;
export const SEARCH_RESULT_LIMIT = 40;
export const SEARCH_RESULT_PER_KIND_LIMIT = 8;
export const SEARCH_EXCERPT_MAX_LENGTH = 180;

const FORBIDDEN_QUERY_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Search query must be a string.');
  }
  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Search query must contain well-formed Unicode.');
  }

  const normalized = value.normalize('NFKC').trim();
  const length = Array.from(normalized).length;
  if (
    length < SEARCH_QUERY_MIN_LENGTH ||
    length > SEARCH_QUERY_MAX_LENGTH ||
    FORBIDDEN_QUERY_CHARACTER.test(normalized)
  ) {
    throw new TypeError(
      `Search query must contain between ${SEARCH_QUERY_MIN_LENGTH} and ${SEARCH_QUERY_MAX_LENGTH} visible characters.`,
    );
  }
  return normalized;
}

export function normalizeSearchScope(value: unknown): SearchScope {
  if (typeof value !== 'string' || !SEARCH_SCOPES.includes(value as SearchScope)) {
    throw new TypeError('Search scope is not supported.');
  }
  return value as SearchScope;
}

export function escapeSearchLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function toSearchFtsPhrase(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function searchQueryLength(value: string): number {
  return Array.from(value).length;
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
