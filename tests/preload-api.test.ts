import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchApi } from '../src/shared/contracts';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(() => Promise.resolve(undefined)),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

let api: WorkbenchApi;

beforeAll(async () => {
  await import('../src/preload/index');
  expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1);
  api = electron.exposeInMainWorld.mock.calls[0]?.[1] as WorkbenchApi;
});

beforeEach(() => {
  electron.invoke.mockClear();
  electron.on.mockClear();
  electron.removeListener.mockClear();
});

describe('preload inbox API', () => {
  it('exposes only the declared inbox methods and capture event', () => {
    expect(Object.keys(api.inbox).sort()).toEqual([
      'archive',
      'categorize',
      'create',
      'getSnapshot',
      'onCaptureRequest',
      'undoArchive',
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.inbox)).toBe(true);
  });

  it('forwards exact inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const entryId = '223e4567-e89b-42d3-a456-426614174000';
    const undoToken = '323e4567-e89b-42d3-a456-426614174000';

    await api.inbox.getSnapshot({ workspaceId });
    await api.inbox.create({ workspaceId, content: '记录', category: 'note' });
    await api.inbox.categorize({ workspaceId, entryId, category: 'task' });
    await api.inbox.archive({ workspaceId, entryId });
    await api.inbox.undoArchive({ workspaceId, undoToken });

    expect(electron.invoke.mock.calls).toEqual([
      ['inbox:get-snapshot', { workspaceId }],
      ['inbox:create', { workspaceId, content: '记录', category: 'note' }],
      ['inbox:categorize', { workspaceId, entryId, category: 'task' }],
      ['inbox:archive', { workspaceId, entryId }],
      ['inbox:undo-archive', { workspaceId, undoToken }],
    ]);
  });

  it('subscribes and removes the Main-triggered quick-capture listener', () => {
    const listener = vi.fn();
    const unsubscribe = api.inbox.onCaptureRequest(listener);
    expect(electron.on).toHaveBeenCalledWith('inbox:capture-requested', expect.any(Function));

    const wrapped = electron.on.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => void;
    wrapped({}, undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith('inbox:capture-requested', wrapped);
  });
});

describe('preload task API', () => {
  it('exposes only the declared frozen task methods', () => {
    expect(Object.keys(api.task).sort()).toEqual([
      'convertInbox',
      'create',
      'getSnapshot',
      'rename',
      'updatePlanning',
      'updateStatus',
    ]);
    expect(Object.isFrozen(api.task)).toBe(true);
  });

  it('forwards exact task inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const taskId = '423e4567-e89b-42d3-a456-426614174000';
    const entryId = '223e4567-e89b-42d3-a456-426614174000';

    await api.task.getSnapshot({ workspaceId });
    await api.task.create({ workspaceId, title: '真实任务', planning: 'today' });
    await api.task.rename({ workspaceId, taskId, title: '更新标题' });
    await api.task.updateStatus({ workspaceId, taskId, status: 'in_progress' });
    await api.task.updatePlanning({ workspaceId, taskId, planning: 'none' });
    await api.task.convertInbox({ workspaceId, entryId, planning: 'today' });

    expect(electron.invoke.mock.calls).toEqual([
      ['task:get-snapshot', { workspaceId }],
      ['task:create', { workspaceId, title: '真实任务', planning: 'today' }],
      ['task:rename', { workspaceId, taskId, title: '更新标题' }],
      ['task:update-status', { workspaceId, taskId, status: 'in_progress' }],
      ['task:update-planning', { workspaceId, taskId, planning: 'none' }],
      ['task:convert-inbox', { workspaceId, entryId, planning: 'today' }],
    ]);
  });
});

describe('preload note API', () => {
  it('exposes only the declared frozen note methods', () => {
    expect(Object.keys(api.note).sort()).toEqual([
      'archive',
      'convertInbox',
      'create',
      'getSnapshot',
      'update',
    ]);
    expect(Object.isFrozen(api.note)).toBe(true);
  });

  it('forwards exact note inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const noteId = '523e4567-e89b-42d3-a456-426614174000';
    const entryId = '223e4567-e89b-42d3-a456-426614174000';

    await api.note.getSnapshot({ workspaceId });
    await api.note.create({ workspaceId, title: '笔记', body: '# Markdown' });
    await api.note.update({
      workspaceId,
      noteId,
      title: '更新',
      body: '正文',
      expectedRevision: 1,
    });
    await api.note.archive({ workspaceId, noteId, expectedRevision: 2 });
    await api.note.convertInbox({ workspaceId, entryId });

    expect(electron.invoke.mock.calls).toEqual([
      ['note:get-snapshot', { workspaceId }],
      ['note:create', { workspaceId, title: '笔记', body: '# Markdown' }],
      ['note:update', { workspaceId, noteId, title: '更新', body: '正文', expectedRevision: 1 }],
      ['note:archive', { workspaceId, noteId, expectedRevision: 2 }],
      ['note:convert-inbox', { workspaceId, entryId }],
    ]);
  });
});

describe('preload schedule API', () => {
  it('exposes only the declared frozen schedule methods', () => {
    expect(Object.keys(api.schedule).sort()).toEqual([
      'archive',
      'create',
      'getSnapshot',
      'update',
    ]);
    expect(Object.isFrozen(api.schedule)).toBe(true);
  });

  it('forwards exact schedule inputs through the allowlisted channels', async () => {
    const workspaceId = '123e4567-e89b-42d3-a456-426614174000';
    const scheduleId = '623e4567-e89b-42d3-a456-426614174000';
    const expectedDate = '2026-07-22';

    await api.schedule.getSnapshot({ workspaceId });
    await api.schedule.create({
      workspaceId,
      expectedDate,
      title: '专注',
      kind: 'focus',
      startMinute: 540,
      endMinute: 600,
    });
    await api.schedule.update({
      workspaceId,
      scheduleId,
      expectedDate,
      expectedRevision: 1,
      title: '评审',
      kind: 'review',
      startMinute: 600,
      endMinute: 660,
    });
    await api.schedule.archive({
      workspaceId,
      scheduleId,
      expectedDate,
      expectedRevision: 2,
    });

    expect(electron.invoke.mock.calls).toEqual([
      ['schedule:get-snapshot', { workspaceId }],
      [
        'schedule:create',
        {
          workspaceId,
          expectedDate,
          title: '专注',
          kind: 'focus',
          startMinute: 540,
          endMinute: 600,
        },
      ],
      [
        'schedule:update',
        {
          workspaceId,
          scheduleId,
          expectedDate,
          expectedRevision: 1,
          title: '评审',
          kind: 'review',
          startMinute: 600,
          endMinute: 660,
        },
      ],
      ['schedule:archive', { workspaceId, scheduleId, expectedDate, expectedRevision: 2 }],
    ]);
  });
});
