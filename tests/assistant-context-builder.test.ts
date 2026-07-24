import { describe, expect, it, vi } from 'vitest';
import { AssistantContextBuilder } from '../src/main/assistant/assistant-context-builder';
import { ASSISTANT_NOTE_CONTEXT_MAX_LENGTH } from '../src/shared/assistant-domain';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  type NoteSnapshot,
  type ScheduleSnapshot,
  type TaskSnapshot,
  type WorkspaceSnapshot,
} from '../src/shared/contracts';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const NOTE_ID = '33333333-3333-4333-8333-333333333333';

describe('assistant context builder', () => {
  it('sends no workspace record for explicit no-context requests', async () => {
    const source = contextSource();
    const resolved = await new AssistantContextBuilder(source).resolve(
      { kind: 'none' },
      activeSignal(),
    );

    expect(JSON.parse(resolved.serialized)).toEqual({ context: { kind: 'none' } });
    expect(resolved.workspaceId).toBe(WORKSPACE_ID);
    expect(resolved.summary).toMatchObject({
      kind: 'none',
      includedCount: 0,
      totalCount: 0,
      truncated: false,
    });
    expect(source.getTaskSnapshot).not.toHaveBeenCalled();
    expect(source.getNoteSnapshot).not.toHaveBeenCalled();
    expect(source.getScheduleSnapshot).not.toHaveBeenCalled();
  });

  it('includes only bounded unfinished Today tasks and reports truncation', async () => {
    const unfinished = Array.from({ length: 55 }, (_, index) =>
      task(`task-${index}`, `未完成 ${index}`, 'todo', '2026-07-23'),
    );
    const source = contextSource({
      tasks: {
        workspaceId: WORKSPACE_ID,
        todayDate: '2026-07-23',
        tasks: [
          ...unfinished,
          task('44444444-4444-4444-8444-444444444444', '已完成', 'completed', '2026-07-23'),
          task('55555555-5555-4555-8555-555555555555', '以后', 'todo', null),
        ],
      },
      schedule: {
        workspaceId: WORKSPACE_ID,
        todayDate: '2026-07-23',
        items: Array.from({ length: 3 }, (_, index) => ({
          id: `schedule-${index}`,
          title: `日程 ${index}`,
          kind: 'focus' as const,
          scheduledFor: '2026-07-23',
          startMinute: index * 60,
          endMinute: index * 60 + 30,
          revision: 1,
          createdAt: '2026-07-23T10:00:00.000Z',
          updatedAt: '2026-07-23T10:00:00.000Z',
        })),
      },
    });
    const resolved = await new AssistantContextBuilder(source).resolve(
      { kind: 'today' },
      activeSignal(),
    );
    const payload = JSON.parse(resolved.serialized) as {
      context: { tasks: readonly { title: string }[] };
    };

    expect(payload.context.tasks).toHaveLength(50);
    expect(payload.context.tasks[0]).toEqual({ title: '未完成 0', status: 'todo' });
    expect(resolved.summary).toMatchObject({
      includedCount: 53,
      totalCount: 58,
      truncated: true,
    });
  });

  it('requires selected tasks to remain incomplete', async () => {
    const source = contextSource({
      tasks: {
        workspaceId: WORKSPACE_ID,
        todayDate: '2026-07-23',
        tasks: [task(TASK_ID, '已完成', 'completed', '2026-07-23')],
      },
    });

    await expect(
      new AssistantContextBuilder(source).resolve(
        { kind: 'tasks', taskIds: [TASK_ID] },
        activeSignal(),
      ),
    ).rejects.toThrow('must still exist and be incomplete');
  });

  it('re-reads an exact saved note revision and discloses body truncation', async () => {
    const longBody = '字'.repeat(ASSISTANT_NOTE_CONTEXT_MAX_LENGTH + 12);
    const source = contextSource({
      notes: {
        workspaceId: WORKSPACE_ID,
        notes: [
          {
            id: NOTE_ID,
            title: '保存的笔记',
            body: longBody,
            revision: 4,
            sourceInboxEntryId: null,
            createdAt: '2026-07-23T10:00:00.000Z',
            updatedAt: '2026-07-23T10:00:00.000Z',
          },
        ],
      },
    });
    const resolved = await new AssistantContextBuilder(source).resolve(
      {
        kind: 'note',
        noteId: NOTE_ID,
        revision: 4,
      },
      activeSignal(),
    );
    const payload = JSON.parse(resolved.serialized) as {
      context: { body: string; truncated: boolean };
    };

    expect(Array.from(payload.context.body)).toHaveLength(ASSISTANT_NOTE_CONTEXT_MAX_LENGTH);
    expect(payload.context.truncated).toBe(true);
    expect(resolved.summary).toMatchObject({
      includedCount: ASSISTANT_NOTE_CONTEXT_MAX_LENGTH,
      totalCount: ASSISTANT_NOTE_CONTEXT_MAX_LENGTH + 12,
      truncated: true,
    });
  });

  it('fails closed if the active workspace changes during context reads', async () => {
    const source = contextSource();
    source.getWorkspaceSnapshot
      .mockResolvedValueOnce(workspaceSnapshot(WORKSPACE_ID))
      .mockResolvedValueOnce(workspaceSnapshot('66666666-6666-4666-8666-666666666666'));

    await expect(
      new AssistantContextBuilder(source).resolve({ kind: 'none' }, activeSignal()),
    ).rejects.toThrow('active workspace changed');
  });

  it.each(['today-task', 'today-schedule', 'tasks', 'note'] as const)(
    'fails closed on a cross-workspace %s snapshot',
    async (kind) => {
      const otherWorkspace = '66666666-6666-4666-8666-666666666666';
      const source = contextSource({
        tasks: {
          workspaceId: kind === 'today-task' || kind === 'tasks' ? otherWorkspace : WORKSPACE_ID,
          todayDate: '2026-07-23',
          tasks: [task(TASK_ID, '任务', 'todo', '2026-07-23')],
        },
        schedule: {
          workspaceId: kind === 'today-schedule' ? otherWorkspace : WORKSPACE_ID,
          todayDate: '2026-07-23',
          items: [],
        },
        notes: {
          workspaceId: kind === 'note' ? otherWorkspace : WORKSPACE_ID,
          notes: [
            {
              id: NOTE_ID,
              title: '笔记',
              body: '正文',
              revision: 1,
              sourceInboxEntryId: null,
              createdAt: '2026-07-23T10:00:00.000Z',
              updatedAt: '2026-07-23T10:00:00.000Z',
            },
          ],
        },
      });
      const reference =
        kind === 'note'
          ? ({ kind: 'note', noteId: NOTE_ID, revision: 1 } as const)
          : kind === 'tasks'
            ? ({ kind: 'tasks', taskIds: [TASK_ID] } as const)
            : ({ kind: 'today' } as const);

      await expect(
        new AssistantContextBuilder(source).resolve(reference, activeSignal()),
      ).rejects.toThrow('did not belong to the active workspace');
    },
  );

  it('does not begin downstream context reads after cancellation', async () => {
    const source = contextSource();
    const pendingTasks = deferred<TaskSnapshot>();
    source.getTaskSnapshot.mockReturnValueOnce(pendingTasks.promise);
    const abort = new AbortController();
    const resolving = new AssistantContextBuilder(source).resolve({ kind: 'today' }, abort.signal);

    await vi.waitFor(() => expect(source.getTaskSnapshot).toHaveBeenCalledTimes(1));
    abort.abort();
    pendingTasks.resolve({
      workspaceId: WORKSPACE_ID,
      todayDate: '2026-07-23',
      tasks: [],
    });

    await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.getScheduleSnapshot).not.toHaveBeenCalled();
    expect(source.getWorkspaceSnapshot).toHaveBeenCalledTimes(1);
  });
});

function contextSource({
  tasks = {
    workspaceId: WORKSPACE_ID,
    todayDate: '2026-07-23',
    tasks: [],
  },
  notes = { workspaceId: WORKSPACE_ID, notes: [] },
  schedule = { workspaceId: WORKSPACE_ID, todayDate: '2026-07-23', items: [] },
}: {
  tasks?: TaskSnapshot;
  notes?: NoteSnapshot;
  schedule?: ScheduleSnapshot;
} = {}) {
  return {
    getWorkspaceSnapshot: vi.fn(async () => workspaceSnapshot(WORKSPACE_ID)),
    getTaskSnapshot: vi.fn(async () => tasks),
    getNoteSnapshot: vi.fn(async () => notes),
    getScheduleSnapshot: vi.fn(async () => schedule),
  };
}

function workspaceSnapshot(workspaceId: string): WorkspaceSnapshot {
  return {
    currentWorkspaceId: workspaceId,
    workspaces: [
      {
        id: workspaceId,
        name: workspaceId === WORKSPACE_ID ? '产品' : '其他',
        color: '#7b6ee8',
        createdAt: '2026-07-23T10:00:00.000Z',
        updatedAt: '2026-07-23T10:00:00.000Z',
      },
    ],
    preferences: DEFAULT_WORKSPACE_PREFERENCES,
  };
}

function task(
  id: string,
  title: string,
  status: 'todo' | 'in_progress' | 'completed',
  plannedFor: string | null,
) {
  return {
    id,
    title,
    status,
    plannedFor,
    sourceInboxEntryId: null,
    createdAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
    completedAt: status === 'completed' ? '2026-07-23T11:00:00.000Z' : null,
  };
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
