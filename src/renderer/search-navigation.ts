import type { SearchResult, SearchResultKind } from '../shared/contracts';

export interface SearchNavigationIntent {
  readonly generation: number;
  readonly result: Readonly<SearchResult>;
}

export class SearchNavigationCoordinator {
  #generation = 0;

  begin(result: SearchResult): SearchNavigationIntent {
    const intent = Object.freeze({
      generation: ++this.#generation,
      result: Object.freeze({ ...result }),
    });
    return intent;
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isCurrent(intent: SearchNavigationIntent): boolean {
    return intent.generation === this.#generation;
  }

  assertCurrent(intent: SearchNavigationIntent): void {
    if (!this.isCurrent(intent)) throw new SearchNavigationSupersededError();
  }
}

export class SearchNavigationSupersededError extends Error {
  constructor() {
    super('导航已被较新的选择替代。');
    this.name = 'SearchNavigationSupersededError';
  }
}

const RESULT_KIND_LABELS: Record<SearchResultKind, string> = {
  inbox: '收件箱记录',
  task: '任务',
  note: '笔记',
  schedule: '日程',
  'browser-tab': '浏览器标签',
  'browser-bookmark': '浏览器收藏',
};

export function assertSearchTargetExists(
  intent: SearchNavigationIntent,
  exists: boolean,
): asserts exists {
  if (exists) return;
  throw new Error(
    `${RESULT_KIND_LABELS[intent.result.kind]}“${intent.result.title}”已被归档或删除，请重新搜索。`,
  );
}

export function searchNavigationError(error: unknown): Error {
  if (error instanceof SearchNavigationSupersededError) return error;
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.replace(/^Error invoking remote method '[^']+':\s*/u, '').trim();
    if (
      message.includes('归档') ||
      message.includes('删除') ||
      message.includes('不存在') ||
      message.includes('替代')
    ) {
      return new Error(message, { cause: error });
    }
  }
  return new Error('无法打开这条搜索结果；它可能已经变化，请重新搜索。', { cause: error });
}
