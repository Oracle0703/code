import {
  PLANNING_DAY_TOKENS,
  type PlanningDay,
  type PlanningDayToken,
  type TaskPlanning,
} from './contracts';
import { normalizeTaskCivilDate } from './task-domain';

export const ROLLING_PLANNING_DAY_COUNT = PLANNING_DAY_TOKENS.length;

const TOKEN_OFFSET = new Map<PlanningDayToken, number>(
  PLANNING_DAY_TOKENS.map((token, offset) => [token, offset] as const),
);

export function createRollingPlanningDays(todayValue: unknown): readonly PlanningDay[] {
  const todayDate = normalizeTaskCivilDate(todayValue);
  return Object.freeze(
    PLANNING_DAY_TOKENS.map((token, offset) =>
      Object.freeze({
        token,
        date: addCivilDays(todayDate, offset),
      }),
    ),
  );
}

export function planningDateForTask(planning: TaskPlanning, todayValue: unknown): string | null {
  if (planning === 'none') return null;
  const offset = TOKEN_OFFSET.get(planning);
  if (offset === undefined) {
    throw new TypeError('Task planning token is not supported.');
  }
  return addCivilDays(normalizeTaskCivilDate(todayValue), offset);
}

export function planningTokenForDate(
  dateValue: unknown,
  todayValue: unknown,
): PlanningDayToken | null {
  const date = normalizeTaskCivilDate(dateValue);
  return createRollingPlanningDays(todayValue).find((day) => day.date === date)?.token ?? null;
}

export function planningWindowEndDate(todayValue: unknown): string {
  return createRollingPlanningDays(todayValue)[ROLLING_PLANNING_DAY_COUNT - 1].date;
}

export function isDateInRollingPlanningWindow(dateValue: unknown, todayValue: unknown): boolean {
  return planningTokenForDate(dateValue, todayValue) !== null;
}

export function addCivilDays(dateValue: unknown, dayOffset: number): string {
  const date = normalizeTaskCivilDate(dateValue);
  if (!Number.isSafeInteger(dayOffset)) {
    throw new TypeError('Planning day offset must be a safe integer.');
  }
  const [yearText, monthText, dayText] = date.split('-');
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(Number(yearText), Number(monthText) - 1, Number(dayText) + dayOffset);
  const year = candidate.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new TypeError('Planning date falls outside the supported calendar range.');
  }
  return normalizeTaskCivilDate(
    `${year.toString().padStart(4, '0')}-${(candidate.getUTCMonth() + 1)
      .toString()
      .padStart(2, '0')}-${candidate.getUTCDate().toString().padStart(2, '0')}`,
  );
}
