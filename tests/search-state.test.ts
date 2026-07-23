import { describe, expect, it } from 'vitest';
import {
  commandPaletteKey,
  filterPaletteCommands,
  isCurrentSearchSnapshot,
  movePaletteSelection,
  reconcilePaletteSelection,
  searchResultGroup,
  searchResultPaletteKey,
  searchStatusMessage,
} from '../src/renderer/search-state';
import type { SearchResult, SearchSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('global search renderer state', () => {
  it('filters commands across labels, descriptions, and keywords', () => {
    const commands = [
      {
        id: 'capture',
        label: '快速记录',
        description: '加入收件箱',
        keywords: 'new inbox',
      },
      {
        id: 'theme',
        label: '切换主题',
        description: '深色或浅色',
        keywords: 'dark light',
      },
    ] as const;

    expect(filterPaletteCommands(commands, '  INBOX ')).toEqual([commands[0]]);
    expect(filterPaletteCommands(commands, '浅色')).toEqual([commands[1]]);
    expect(filterPaletteCommands(commands, '')).toBe(commands);
  });

  it('keeps a stable selected key across asynchronous result reordering', () => {
    const reordered = ['result:b', 'command:capture', 'result:a'];

    expect(reconcilePaletteSelection('result:b', reordered)).toBe('result:b');
    expect(reconcilePaletteSelection('result:removed', reordered)).toBe('result:b');
    expect(reconcilePaletteSelection(null, [])).toBeNull();
    expect(commandPaletteKey('capture')).toBe('command:capture');
  });

  it('wraps arrow selection and supports first and last navigation', () => {
    const keys = ['a', 'b', 'c'];
    expect(movePaletteSelection('c', keys, 'next')).toBe('a');
    expect(movePaletteSelection('a', keys, 'previous')).toBe('c');
    expect(movePaletteSelection('b', keys, 'first')).toBe('a');
    expect(movePaletteSelection('b', keys, 'last')).toBe('c');
    expect(movePaletteSelection(null, [], 'next')).toBeNull();
  });

  it('isolates result keys and groups by workspace', () => {
    const current = result({ workspaceId: WORKSPACE_A, entityId: 'same' });
    const other = result({ workspaceId: WORKSPACE_B, entityId: 'same' });

    expect(searchResultPaletteKey(current)).not.toBe(searchResultPaletteKey(other));
    expect(searchResultGroup(current, WORKSPACE_A)).toBe('当前工作区');
    expect(searchResultGroup(other, WORKSPACE_A)).toBe('其他工作区');
  });

  it('accepts only the exact current query, scope, and workspace snapshot', () => {
    const value = snapshot();
    expect(isCurrentSearchSnapshot(value, WORKSPACE_A, '  发布计划  ', 'all')).toBe(true);
    expect(isCurrentSearchSnapshot(value, WORKSPACE_B, '发布计划', 'all')).toBe(false);
    expect(isCurrentSearchSnapshot(value, WORKSPACE_A, '另一个查询', 'all')).toBe(false);
    expect(isCurrentSearchSnapshot(value, WORKSPACE_A, '发布计划', 'workspace')).toBe(false);
  });

  it('builds concise live-region messages for every async state', () => {
    expect(
      searchStatusMessage({
        query: '',
        status: 'idle',
        commandCount: 8,
        resultCount: 0,
        truncated: false,
        error: null,
      }),
    ).toBe('8 个快捷操作');
    expect(
      searchStatusMessage({
        query: '计',
        status: 'idle',
        commandCount: 0,
        resultCount: 0,
        truncated: false,
        error: null,
      }),
    ).toBe('至少输入 2 个字符以搜索内容');
    expect(
      searchStatusMessage({
        query: '计划',
        status: 'searching',
        commandCount: 1,
        resultCount: 0,
        truncated: false,
        error: null,
      }),
    ).toBe('正在搜索所有内容');
    expect(
      searchStatusMessage({
        query: '计划',
        status: 'ready',
        commandCount: 1,
        resultCount: 12,
        truncated: true,
        error: null,
      }),
    ).toContain('还有更多结果');
    expect(
      searchStatusMessage({
        query: '计划',
        status: 'error',
        commandCount: 1,
        resultCount: 0,
        truncated: false,
        error: '搜索服务不可用',
      }),
    ).toBe('搜索服务不可用');
  });
});

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    kind: 'task',
    entityId: 'task-a',
    workspaceId: WORKSPACE_A,
    workspaceName: '开发',
    title: '发布计划',
    excerpt: null,
    matchField: 'title',
    sortAt: '2026-07-23T12:00:00.000Z',
    ...overrides,
  };
}

function snapshot(): SearchSnapshot {
  return {
    workspaceId: WORKSPACE_A,
    query: '发布计划',
    scope: 'all',
    results: [result()],
    truncated: false,
    truncatedKinds: [],
  };
}
