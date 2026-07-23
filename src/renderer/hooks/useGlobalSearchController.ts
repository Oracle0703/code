import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SearchResult,
  SearchResultKind,
  SearchScope,
  WorkbenchApi,
} from '../../shared/contracts';
import { SEARCH_QUERY_MIN_LENGTH, normalizeSearchQuery } from '../../shared/search-domain';
import {
  isCurrentSearchSnapshot,
  normalizePaletteQuery,
  type SearchRequestStatus,
} from '../search-state';

const DEFAULT_SEARCH_DEBOUNCE_MS = 180;
const EMPTY_RESULTS: readonly SearchResult[] = Object.freeze([]);
const EMPTY_KINDS: readonly SearchResultKind[] = Object.freeze([]);

export interface GlobalSearchController {
  readonly query: string;
  readonly scope: SearchScope;
  readonly status: SearchRequestStatus;
  readonly results: readonly SearchResult[];
  readonly error: string | null;
  readonly canRetry: boolean;
  readonly truncated: boolean;
  readonly truncatedKinds: readonly SearchResultKind[];
  setQuery(query: string): void;
  setScope(scope: SearchScope): void;
  retry(): void;
  reset(): void;
}

interface GlobalSearchControllerOptions {
  readonly open: boolean;
  readonly workspaceId: string | null;
  readonly debounceMs?: number;
  readonly searchApi?: WorkbenchApi['search'] | null;
  readonly initialScope?: SearchScope;
}

export function useGlobalSearchController({
  open,
  workspaceId,
  debounceMs = DEFAULT_SEARCH_DEBOUNCE_MS,
  searchApi = window.workbench?.search ?? null,
  initialScope = 'all',
}: GlobalSearchControllerOptions): GlobalSearchController {
  const [query, setQueryState] = useState('');
  const [scope, setScopeState] = useState<SearchScope>(initialScope);
  const [status, setStatus] = useState<SearchRequestStatus>('idle');
  const [results, setResults] = useState<readonly SearchResult[]>(EMPTY_RESULTS);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [truncatedKinds, setTruncatedKinds] = useState<readonly SearchResultKind[]>(EMPTY_KINDS);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const requestGenerationRef = useRef(0);
  const effectiveDebounceMs = Number.isFinite(debounceMs)
    ? Math.max(0, Math.min(2_000, Math.floor(debounceMs)))
    : DEFAULT_SEARCH_DEBOUNCE_MS;

  const clearResults = useCallback(() => {
    setResults(EMPTY_RESULTS);
    setError(null);
    setCanRetry(false);
    setTruncated(false);
    setTruncatedKinds(EMPTY_KINDS);
  }, []);

  const setQuery = useCallback(
    (nextQuery: string) => {
      requestGenerationRef.current += 1;
      setQueryState(nextQuery);
      clearResults();
      const validation = validateRendererSearchQuery(nextQuery);
      setStatus(validation.status);
      setError(validation.error);
      setCanRetry(false);
    },
    [clearResults],
  );

  const setScope = useCallback(
    (nextScope: SearchScope) => {
      requestGenerationRef.current += 1;
      setScopeState(nextScope);
      clearResults();
      const validation = validateRendererSearchQuery(query);
      setStatus(validation.status);
      setError(validation.error);
      setCanRetry(false);
    },
    [clearResults, query],
  );

  const reset = useCallback(() => {
    requestGenerationRef.current += 1;
    setQueryState('');
    setStatus('idle');
    clearResults();
  }, [clearResults]);

  const retry = useCallback(() => {
    if (validateRendererSearchQuery(query).status !== 'searching') return;
    requestGenerationRef.current += 1;
    setStatus('searching');
    setError(null);
    setCanRetry(false);
    setRetryGeneration((generation) => generation + 1);
  }, [query]);

  useEffect(() => {
    let normalizedQuery: string;
    try {
      normalizedQuery = normalizeSearchQuery(query);
    } catch {
      return;
    }
    if (!open || !workspaceId) return;

    const generation = ++requestGenerationRef.current;
    const timer = window.setTimeout(() => {
      setStatus('searching');
      void (async () => {
        if (!searchApi) {
          if (generation !== requestGenerationRef.current) return;
          setStatus('error');
          setError('桌面搜索桥接不可用，请重新启动应用。');
          setCanRetry(false);
          return;
        }
        try {
          const snapshot = await searchApi.query({
            workspaceId,
            query: normalizedQuery,
            scope,
          });
          if (
            generation !== requestGenerationRef.current ||
            !isCurrentSearchSnapshot(snapshot, workspaceId, normalizedQuery, scope)
          ) {
            return;
          }
          setResults(snapshot.results);
          setTruncated(snapshot.truncated);
          setTruncatedKinds(snapshot.truncatedKinds);
          setError(null);
          setCanRetry(false);
          setStatus('ready');
        } catch (searchError) {
          if (generation !== requestGenerationRef.current) return;
          setResults(EMPTY_RESULTS);
          setTruncated(false);
          setTruncatedKinds(EMPTY_KINDS);
          setError(toSearchErrorMessage(searchError));
          setCanRetry(true);
          setStatus('error');
        }
      })();
    }, effectiveDebounceMs);

    return () => {
      window.clearTimeout(timer);
      if (requestGenerationRef.current === generation) requestGenerationRef.current += 1;
    };
  }, [effectiveDebounceMs, open, query, retryGeneration, scope, searchApi, workspaceId]);

  return {
    query,
    scope,
    status,
    results,
    error,
    canRetry,
    truncated,
    truncatedKinds,
    setQuery,
    setScope,
    retry,
    reset,
  };
}

function toSearchErrorMessage(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) return '搜索失败，请重试。';
  const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
  return message || '搜索失败，请重试。';
}

function validateRendererSearchQuery(query: string): {
  readonly status: SearchRequestStatus;
  readonly error: string | null;
} {
  if (!normalizePaletteQuery(query)) return { status: 'idle', error: null };
  try {
    normalizeSearchQuery(query);
    return { status: 'searching', error: null };
  } catch {
    if (Array.from(query.trim()).length < SEARCH_QUERY_MIN_LENGTH) {
      return { status: 'idle', error: null };
    }
    return {
      status: 'error',
      error: '搜索词必须是 2–120 个可见字符。',
    };
  }
}
