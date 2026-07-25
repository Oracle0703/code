import type { Task, TaskSnapshot } from '../shared/contracts';

export const OVERDUE_TASK_PREVIEW_LIMIT = 5;

export function selectOverdueTasks(snapshot: TaskSnapshot | null): readonly Task[] {
  if (!snapshot) return [];
  return [...snapshot.tasks]
    .filter(
      (task) =>
        task.status !== 'completed' &&
        task.plannedFor !== null &&
        task.plannedFor < snapshot.todayDate,
    )
    .sort(
      (left, right) =>
        left.plannedFor!.localeCompare(right.plannedFor!) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
}

export function overdueTaskReviewIdentity(snapshot: TaskSnapshot | null): string | null {
  return snapshot ? JSON.stringify([snapshot.workspaceId, snapshot.todayDate]) : null;
}

export function nextOverdueTaskId(tasks: readonly Task[], currentTaskId: string): string | null {
  const index = tasks.findIndex(({ id }) => id === currentTaskId);
  if (index < 0) return null;
  return tasks[index + 1]?.id ?? tasks[index - 1]?.id ?? null;
}

export class OverdueTaskActionGate {
  readonly #pendingTaskIds = new Set<string>();

  begin(taskId: string): boolean {
    if (this.#pendingTaskIds.has(taskId)) return false;
    this.#pendingTaskIds.add(taskId);
    return true;
  }

  end(taskId: string): void {
    this.#pendingTaskIds.delete(taskId);
  }
}
