import type { Task, TaskSnapshot } from '../shared/contracts';

export type TaskFilter = 'open' | 'today' | 'completed' | 'all';

export function isTaskSequenceCurrent(sequence: number, lastAppliedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence >= lastAppliedSequence;
}

export function isTaskRequestLatest(sequence: number, latestRequestedSequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0 && sequence === latestRequestedSequence;
}

export function isTaskWorkspaceCurrent(
  activeWorkspaceId: string | null,
  snapshot: TaskSnapshot,
): boolean {
  return activeWorkspaceId !== null && snapshot.workspaceId === activeWorkspaceId;
}

export function toLocalDateKey(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError('Task date must be valid.');
  const year = value.getFullYear().toString().padStart(4, '0');
  const month = (value.getMonth() + 1).toString().padStart(2, '0');
  const day = value.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function millisecondsUntilNextLocalDay(value: Date): number {
  if (!Number.isFinite(value.getTime())) throw new TypeError('Task date must be valid.');
  const nextDay = new Date(value.getFullYear(), value.getMonth(), value.getDate() + 1, 0, 0, 0, 50);
  return Math.max(1, nextDay.getTime() - value.getTime());
}

export function isTaskSnapshotDateCurrent(snapshot: TaskSnapshot, value: Date): boolean {
  return snapshot.todayDate === toLocalDateKey(value);
}

export function countTasks(tasks: readonly Task[], todayDate: string) {
  let active = 0;
  let today = 0;
  let todayTotal = 0;
  let todayCompleted = 0;
  let completed = 0;

  for (const task of tasks) {
    const isCompleted = task.status === 'completed';
    const isToday = task.plannedFor === todayDate;
    if (isCompleted) completed += 1;
    else active += 1;
    if (isToday) {
      todayTotal += 1;
      if (isCompleted) todayCompleted += 1;
      else today += 1;
    }
  }

  return { active, today, todayTotal, todayCompleted, completed } as const;
}

export function filterTasks(
  tasks: readonly Task[],
  filter: TaskFilter,
  query: string,
  todayDate: string,
): readonly Task[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return tasks.filter((task) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'open' && task.status !== 'completed') ||
      (filter === 'completed' && task.status === 'completed') ||
      (filter === 'today' && task.plannedFor === todayDate);
    return (
      matchesFilter &&
      (!normalizedQuery || task.title.toLocaleLowerCase().includes(normalizedQuery))
    );
  });
}
