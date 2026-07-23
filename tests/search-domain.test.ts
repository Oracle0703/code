import { describe, expect, it } from 'vitest';
import {
  SEARCH_EXCERPT_MAX_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
  SEARCH_RESULT_LIMIT,
  SEARCH_RESULT_PER_KIND_LIMIT,
  escapeSearchLike,
  normalizeSearchQuery,
  normalizeSearchScope,
  searchQueryLength,
  toSearchFtsPhrase,
} from '../src/shared/search-domain';

describe('search domain', () => {
  it('normalizes bounded visible queries to their NFKC searchable form', () => {
    expect(normalizeSearchQuery('  世界计划  ')).toBe('世界计划');
    expect(normalizeSearchQuery('Ａlpha')).toBe('Alpha');
    expect(normalizeSearchQuery('  ＡPI\u3000搜索  ')).toBe('API 搜索');
    expect(searchQueryLength('A😀中')).toBe(3);
  });

  it('rejects malformed, invisible, and out-of-range queries', () => {
    expect(() => normalizeSearchQuery('a')).toThrow(TypeError);
    expect(() => normalizeSearchQuery('x'.repeat(SEARCH_QUERY_MAX_LENGTH + 1))).toThrow(TypeError);
    expect(() => normalizeSearchQuery(`ab\u0000cd`)).toThrow(TypeError);
    expect(() => normalizeSearchQuery(`ab\u202ecd`)).toThrow(TypeError);
    expect(() => normalizeSearchQuery(`ab${String.fromCharCode(0xd800)}cd`)).toThrow(TypeError);
    expect(() => normalizeSearchQuery(42)).toThrow(TypeError);
  });

  it('accepts only the two declared scopes', () => {
    expect(normalizeSearchScope('workspace')).toBe('workspace');
    expect(normalizeSearchScope('all')).toBe('all');
    expect(() => normalizeSearchScope('archived')).toThrow(TypeError);
  });

  it('escapes LIKE wildcards and quotes an FTS phrase literally', () => {
    expect(escapeSearchLike(`50%_off\\today`)).toBe(`50\\%\\_off\\\\today`);
    expect(toSearchFtsPhrase(`say "yes" OR no`)).toBe(`"say ""yes"" OR no"`);
  });

  it('exports fixed server-side query and response bounds', () => {
    expect(SEARCH_QUERY_MIN_LENGTH).toBe(2);
    expect(SEARCH_QUERY_MAX_LENGTH).toBe(120);
    expect(SEARCH_RESULT_PER_KIND_LIMIT).toBe(8);
    expect(SEARCH_RESULT_LIMIT).toBe(40);
    expect(SEARCH_EXCERPT_MAX_LENGTH).toBe(180);
  });
});
