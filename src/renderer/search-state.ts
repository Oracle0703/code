import type { SearchResult, SearchScope, SearchSnapshot } from '../shared/contracts';
import {
  SEARCH_QUERY_MIN_LENGTH,
  normalizeSearchQuery,
  searchQueryLength,
} from '../shared/search-domain';

export interface PaletteSearchableCommand {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly keywords?: string;
}

export type PaletteSelectionMove = 'next' | 'previous' | 'first' | 'last';

export type SearchRequestStatus = 'idle' | 'searching' | 'ready' | 'error';

export function normalizePaletteQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function filterPaletteCommands<T extends PaletteSearchableCommand>(
  commands: readonly T[],
  query: string,
): readonly T[] {
  const normalizedQuery = normalizePaletteQuery(query);
  if (!normalizedQuery) return commands;
  return commands.filter((command) =>
    `${command.label} ${command.description ?? ''} ${command.keywords ?? ''}`
      .toLocaleLowerCase()
      .includes(normalizedQuery),
  );
}

export function commandPaletteKey(commandId: string): string {
  return `command:${commandId}`;
}

export function searchResultPaletteKey(result: SearchResult): string {
  return `result:${result.workspaceId}:${result.kind}:${result.entityId}`;
}

export function reconcilePaletteSelection(
  selectedKey: string | null,
  orderedKeys: readonly string[],
): string | null {
  if (orderedKeys.length === 0) return null;
  return selectedKey && orderedKeys.includes(selectedKey) ? selectedKey : orderedKeys[0];
}

export function movePaletteSelection(
  selectedKey: string | null,
  orderedKeys: readonly string[],
  move: PaletteSelectionMove,
): string | null {
  if (orderedKeys.length === 0) return null;
  if (move === 'first') return orderedKeys[0];
  if (move === 'last') return orderedKeys[orderedKeys.length - 1];

  const currentKey = reconcilePaletteSelection(selectedKey, orderedKeys);
  const currentIndex = currentKey ? orderedKeys.indexOf(currentKey) : 0;
  const delta = move === 'next' ? 1 : -1;
  return orderedKeys[(currentIndex + delta + orderedKeys.length) % orderedKeys.length];
}

export function searchResultGroup(
  result: SearchResult,
  currentWorkspaceId: string,
): '当前工作区' | '其他工作区' {
  return result.workspaceId === currentWorkspaceId ? '当前工作区' : '其他工作区';
}

export function isCurrentSearchSnapshot(
  snapshot: SearchSnapshot,
  workspaceId: string,
  query: string,
  scope: SearchScope,
): boolean {
  try {
    return (
      snapshot.workspaceId === workspaceId &&
      normalizeSearchQuery(snapshot.query) === normalizeSearchQuery(query) &&
      snapshot.scope === scope
    );
  } catch {
    return false;
  }
}

interface SearchStatusMessageInput {
  readonly query: string;
  readonly status: SearchRequestStatus;
  readonly commandCount: number;
  readonly resultCount: number;
  readonly truncated: boolean;
  readonly error: string | null;
}

export function searchStatusMessage({
  query,
  status,
  commandCount,
  resultCount,
  truncated,
  error,
}: SearchStatusMessageInput): string {
  if (!normalizePaletteQuery(query)) return `${commandCount} 个快捷操作`;
  if (searchQueryLength(query.trim()) < SEARCH_QUERY_MIN_LENGTH) {
    return `至少输入 ${SEARCH_QUERY_MIN_LENGTH} 个字符以搜索内容`;
  }
  if (status === 'searching') return '正在搜索所有内容';
  if (status === 'error') return error ?? '搜索失败，请重试';
  const suffix = truncated ? '，还有更多结果，请缩小搜索范围' : '';
  return `找到 ${resultCount} 条内容结果和 ${commandCount} 个快捷操作${suffix}`;
}
