import type {
  PlanningDay,
  PlanningDayToken,
  ScheduleSnapshot,
  Task,
  TaskPlanning,
  TaskSnapshot,
} from '../shared/contracts';
import { createRollingPlanningDays } from '../shared/planning-domain';

export type TaskPlanningValue = TaskPlanning | 'outside-window';

export function planningSnapshotsMatch(
  taskSnapshot: TaskSnapshot | null,
  scheduleSnapshot: ScheduleSnapshot | null,
): boolean {
  if (
    !taskSnapshot ||
    !scheduleSnapshot ||
    taskSnapshot.workspaceId !== scheduleSnapshot.workspaceId ||
    taskSnapshot.todayDate !== scheduleSnapshot.todayDate
  ) {
    return false;
  }

  let expectedDays: readonly PlanningDay[];
  try {
    expectedDays = createRollingPlanningDays(taskSnapshot.todayDate);
  } catch {
    return false;
  }

  return (
    planningDaysMatch(taskSnapshot.planningDays, expectedDays) &&
    planningDaysMatch(scheduleSnapshot.planningDays, expectedDays)
  );
}

export function planningValueForTask(
  task: Task,
  planningDays: readonly PlanningDay[],
): TaskPlanningValue {
  if (task.plannedFor === null) return 'none';
  return planningDays.find(({ date }) => date === task.plannedFor)?.token ?? 'outside-window';
}

export function planningDayLabel(day: PlanningDay): {
  readonly short: string;
  readonly date: string;
  readonly accessible: string;
} {
  const parsed = parseCivilDate(day.date);
  if (!parsed) {
    return {
      short: day.token === 'day-0' ? '今天' : day.date,
      date: day.date,
      accessible: day.date,
    };
  }
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(parsed);
  const date = `${parsed.getMonth() + 1}月${parsed.getDate()}日`;
  return {
    short: day.token === 'day-0' ? '今天' : weekday,
    date,
    accessible: `${day.token === 'day-0' ? '今天，' : ''}${date}，${weekday}`,
  };
}

export function planningTokenAt(
  planningDays: readonly PlanningDay[],
  index: number,
): PlanningDayToken {
  const normalizedIndex = Math.min(Math.max(index, 0), Math.max(planningDays.length - 1, 0));
  return planningDays[normalizedIndex]?.token ?? 'day-0';
}

function planningDaysMatch(
  actual: readonly PlanningDay[],
  expected: readonly PlanningDay[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every(
      (day, index) => day.token === expected[index]?.token && day.date === expected[index]?.date,
    )
  );
}

function parseCivilDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(0);
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, monthIndex, day);
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day
    ? date
    : null;
}
