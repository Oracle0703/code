import { describe, expect, it } from 'vitest';
import {
  SearchNavigationCoordinator,
  SearchNavigationSupersededError,
  assertSearchTargetExists,
} from '../src/renderer/search-navigation';
import type { SearchResult } from '../src/shared/contracts';

describe('search result navigation intents', () => {
  it('prevents a delayed cross-workspace activation from opening an older result', async () => {
    const coordinator = new SearchNavigationCoordinator();
    const first = coordinator.begin(result('task-old', 'workspace-b'));
    let releaseActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const delayedContinuation = (async () => {
      await activation;
      coordinator.assertCurrent(first);
    })();

    const latest = coordinator.begin(result('task-new', 'workspace-c'));
    releaseActivation();

    await expect(delayedContinuation).rejects.toBeInstanceOf(SearchNavigationSupersededError);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(latest)).toBe(true);
  });

  it('captures an immutable result snapshot for the whole async navigation', () => {
    const coordinator = new SearchNavigationCoordinator();
    const source = result('task-a', 'workspace-a');
    const intent = coordinator.begin(source);

    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.result)).toBe(true);
    expect(intent.result).not.toBe(source);
  });

  it('reports a readable error when a refreshed target disappeared', () => {
    const intent = new SearchNavigationCoordinator().begin(result('task-a', 'workspace-a'));
    expect(() => assertSearchTargetExists(intent, false)).toThrow(
      '任务“任务 task-a”已被归档或删除，请重新搜索。',
    );
  });
});

function result(entityId: string, workspaceId: string): SearchResult {
  return {
    kind: 'task',
    entityId,
    workspaceId,
    workspaceName: workspaceId,
    title: `任务 ${entityId}`,
    excerpt: null,
    matchField: 'title',
    sortAt: '2026-07-23T12:00:00.000Z',
  };
}
