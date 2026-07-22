import { describe, expect, it } from 'vitest';
import {
  countInboxEntries,
  isInboxRequestLatest,
  isInboxSequenceCurrent,
  isInboxWorkspaceCurrent,
} from '../src/renderer/inbox-state';
import type { InboxSnapshot } from '../src/shared/contracts';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';

describe('inbox renderer state', () => {
  it('rejects an older response even when it belongs to the current workspace', () => {
    expect(isInboxSequenceCurrent(4, 5)).toBe(false);
    expect(isInboxSequenceCurrent(5, 5)).toBe(true);
    expect(isInboxSequenceCurrent(6, 5)).toBe(true);
  });

  it('accepts an older successful operation when the newer operation has no snapshot', () => {
    expect(isInboxSequenceCurrent(4, 3)).toBe(true);
  });

  it('rejects a stale success or failure after a newer request starts', () => {
    expect(isInboxRequestLatest(4, 5)).toBe(false);
    expect(isInboxRequestLatest(5, 5)).toBe(true);
    expect(isInboxRequestLatest(6, 5)).toBe(false);
  });

  it('rejects a delayed response from the previously active workspace', () => {
    const snapshot: InboxSnapshot = { workspaceId: WORKSPACE_A, entries: [] };
    expect(isInboxWorkspaceCurrent(WORKSPACE_B, snapshot)).toBe(false);
    expect(isInboxWorkspaceCurrent(WORKSPACE_A, snapshot)).toBe(true);
    expect(isInboxWorkspaceCurrent(null, snapshot)).toBe(false);
  });

  it('derives every badge from the real active-entry snapshot', () => {
    expect(
      countInboxEntries([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          content: '未分类',
          category: 'uncategorized',
          createdAt: '2026-07-22T12:00:00.000Z',
          updatedAt: '2026-07-22T12:00:00.000Z',
        },
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          content: '任务',
          category: 'task',
          createdAt: '2026-07-22T12:00:00.000Z',
          updatedAt: '2026-07-22T12:00:00.000Z',
        },
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          content: '链接',
          category: 'link',
          createdAt: '2026-07-22T12:00:00.000Z',
          updatedAt: '2026-07-22T12:00:00.000Z',
        },
      ]),
    ).toEqual({ total: 3, uncategorized: 1, task: 1, note: 0, link: 1 });
  });
});
