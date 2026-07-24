import type {
  AssistantContextReference,
  AssistantContextSummary,
  NoteSnapshot,
  ScheduleSnapshot,
  TaskSnapshot,
  WorkspaceSnapshot,
} from '../../shared/contracts';
import {
  ASSISTANT_NOTE_CONTEXT_MAX_LENGTH,
  ASSISTANT_TODAY_SCHEDULE_MAX_COUNT,
  ASSISTANT_TODAY_TASK_MAX_COUNT,
  sliceAssistantText,
} from '../../shared/assistant-domain';
import { AssistantContextError } from './assistant-errors';

export interface AssistantContextSource {
  getWorkspaceSnapshot(): Promise<WorkspaceSnapshot>;
  getTaskSnapshot(input: { readonly workspaceId: string }): Promise<TaskSnapshot>;
  getNoteSnapshot(input: { readonly workspaceId: string }): Promise<NoteSnapshot>;
  getScheduleSnapshot(input: { readonly workspaceId: string }): Promise<ScheduleSnapshot>;
}

export interface ResolvedAssistantContext {
  readonly workspaceId: string;
  readonly reference: AssistantContextReference;
  readonly summary: AssistantContextSummary;
  readonly serialized: string;
}

export class AssistantContextBuilder {
  readonly #source: AssistantContextSource;

  constructor(source: AssistantContextSource) {
    this.#source = source;
  }

  async resolve(
    reference: AssistantContextReference,
    signal: AbortSignal,
  ): Promise<ResolvedAssistantContext> {
    signal.throwIfAborted();
    const before = await this.#source.getWorkspaceSnapshot();
    signal.throwIfAborted();
    const workspace = before.workspaces.find(({ id }) => id === before.currentWorkspaceId);
    if (!workspace) {
      throw new AssistantContextError('The active workspace is unavailable.');
    }

    const resolved = await this.#resolveForWorkspace(
      workspace.id,
      workspace.name,
      reference,
      signal,
    );
    signal.throwIfAborted();
    const after = await this.#source.getWorkspaceSnapshot();
    signal.throwIfAborted();
    const current = after.workspaces.find(({ id }) => id === after.currentWorkspaceId);
    if (
      !current ||
      current.id !== workspace.id ||
      current.name !== workspace.name ||
      current.updatedAt !== workspace.updatedAt
    ) {
      throw new AssistantContextError(
        'The active workspace changed while assistant context was being prepared.',
      );
    }
    return resolved;
  }

  async #resolveForWorkspace(
    workspaceId: string,
    workspaceName: string,
    reference: AssistantContextReference,
    signal: AbortSignal,
  ): Promise<ResolvedAssistantContext> {
    switch (reference.kind) {
      case 'none':
        return {
          workspaceId,
          reference,
          summary: {
            kind: 'none',
            label: '不附加工作区内容',
            includedCount: 0,
            totalCount: 0,
            truncated: false,
          },
          serialized: JSON.stringify({ context: { kind: 'none' } }),
        };
      case 'today':
        return this.#resolveToday(workspaceId, workspaceName, reference, signal);
      case 'tasks':
        return this.#resolveTasks(workspaceId, workspaceName, reference, signal);
      case 'note':
        return this.#resolveNote(workspaceId, workspaceName, reference, signal);
    }
  }

  async #resolveToday(
    workspaceId: string,
    workspaceName: string,
    reference: Extract<AssistantContextReference, { readonly kind: 'today' }>,
    signal: AbortSignal,
  ): Promise<ResolvedAssistantContext> {
    signal.throwIfAborted();
    const tasks = await this.#source.getTaskSnapshot({ workspaceId });
    signal.throwIfAborted();
    const schedule = await this.#source.getScheduleSnapshot({ workspaceId });
    signal.throwIfAborted();
    assertWorkspaceSnapshot(tasks.workspaceId, workspaceId, 'task');
    assertWorkspaceSnapshot(schedule.workspaceId, workspaceId, 'schedule');
    if (tasks.todayDate !== schedule.todayDate) {
      throw new AssistantContextError(
        'The local date changed while Today context was being prepared.',
      );
    }

    const todayTasks = tasks.tasks.filter(
      ({ plannedFor, status }) => plannedFor === tasks.todayDate && status !== 'completed',
    );
    const includedTasks = todayTasks.slice(0, ASSISTANT_TODAY_TASK_MAX_COUNT);
    const includedSchedule = schedule.items.slice(0, ASSISTANT_TODAY_SCHEDULE_MAX_COUNT);
    const totalCount = todayTasks.length + schedule.items.length;
    const includedCount = includedTasks.length + includedSchedule.length;
    return {
      workspaceId,
      reference,
      summary: {
        kind: 'today',
        label: `今日 · ${tasks.todayDate}`,
        includedCount,
        totalCount,
        truncated: includedCount < totalCount,
      },
      serialized: JSON.stringify({
        workspace: { name: workspaceName },
        context: {
          kind: 'today',
          localDate: tasks.todayDate,
          tasks: includedTasks.map(({ title, status }) => ({ title, status })),
          schedule: includedSchedule.map(({ title, kind, startMinute, endMinute }) => ({
            title,
            kind,
            startTime: formatMinute(startMinute),
            endTime: formatMinute(endMinute),
          })),
          truncated: includedCount < totalCount,
        },
      }),
    };
  }

  async #resolveTasks(
    workspaceId: string,
    workspaceName: string,
    reference: Extract<AssistantContextReference, { readonly kind: 'tasks' }>,
    signal: AbortSignal,
  ): Promise<ResolvedAssistantContext> {
    signal.throwIfAborted();
    const snapshot = await this.#source.getTaskSnapshot({ workspaceId });
    signal.throwIfAborted();
    assertWorkspaceSnapshot(snapshot.workspaceId, workspaceId, 'task');
    const tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
    const selected = reference.taskIds.map((taskId) => {
      const task = tasksById.get(taskId);
      if (!task || task.status === 'completed') {
        throw new AssistantContextError(
          'Every selected assistant task must still exist and be incomplete.',
        );
      }
      return task;
    });
    return {
      workspaceId,
      reference,
      summary: {
        kind: 'tasks',
        label: '所选未完成任务',
        includedCount: selected.length,
        totalCount: selected.length,
        truncated: false,
      },
      serialized: JSON.stringify({
        workspace: { name: workspaceName },
        context: {
          kind: 'tasks',
          localDate: snapshot.todayDate,
          tasks: selected.map(({ title, status, plannedFor }) => ({
            title,
            status,
            plannedFor,
          })),
        },
      }),
    };
  }

  async #resolveNote(
    workspaceId: string,
    workspaceName: string,
    reference: Extract<AssistantContextReference, { readonly kind: 'note' }>,
    signal: AbortSignal,
  ): Promise<ResolvedAssistantContext> {
    signal.throwIfAborted();
    const snapshot = await this.#source.getNoteSnapshot({ workspaceId });
    signal.throwIfAborted();
    assertWorkspaceSnapshot(snapshot.workspaceId, workspaceId, 'note');
    const note = snapshot.notes.find(({ id }) => id === reference.noteId);
    if (!note || note.revision !== reference.revision) {
      throw new AssistantContextError('The selected note must still exist at the saved revision.');
    }
    const body = sliceAssistantText(note.body, ASSISTANT_NOTE_CONTEXT_MAX_LENGTH);
    return {
      workspaceId,
      reference,
      summary: {
        kind: 'note',
        label: `笔记 · ${note.title}`,
        includedCount: Math.min(body.totalLength, ASSISTANT_NOTE_CONTEXT_MAX_LENGTH),
        totalCount: body.totalLength,
        truncated: body.truncated,
      },
      serialized: JSON.stringify({
        workspace: { name: workspaceName },
        context: {
          kind: 'note',
          title: note.title,
          revision: note.revision,
          body: body.value,
          truncated: body.truncated,
        },
      }),
    };
  }
}

function formatMinute(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function assertWorkspaceSnapshot(actual: string, expected: string, kind: string): void {
  if (actual !== expected) {
    throw new AssistantContextError(`The ${kind} context did not belong to the active workspace.`);
  }
}
