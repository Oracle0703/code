import { SCHEDULE_KINDS, type ScheduleKind } from './contracts';
import { formatLocalTaskDate, normalizeTaskCivilDate } from './task-domain';

export const SCHEDULE_TITLE_MAX_LENGTH = 200;
export const SCHEDULE_DAY_MINUTES = 1_440;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_TITLE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const VISIBLE_TITLE_CHARACTER = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export function normalizeScheduleId(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError('Schedule item id must be a lowercase UUID v4.');
  }
  return value;
}

export function normalizeScheduleTitle(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Schedule title must be a string.');
  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Schedule title must contain well-formed Unicode.');
  }
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > SCHEDULE_TITLE_MAX_LENGTH ||
    FORBIDDEN_TITLE_CHARACTER.test(normalized) ||
    !VISIBLE_TITLE_CHARACTER.test(normalized)
  ) {
    throw new TypeError('Schedule title is empty, too long, or contains unsupported characters.');
  }
  return normalized;
}

export function normalizeScheduleKind(value: unknown): ScheduleKind {
  if (typeof value !== 'string' || !SCHEDULE_KINDS.includes(value as ScheduleKind)) {
    throw new TypeError('Schedule kind is not supported.');
  }
  return value as ScheduleKind;
}

export function normalizeScheduleCivilDate(value: unknown): string {
  return normalizeTaskCivilDate(value);
}

export function formatLocalScheduleDate(value: Date): string {
  return formatLocalTaskDate(value);
}

export function normalizeScheduleStartMinute(value: unknown): number {
  return integerInRange(value, 'Schedule start minute', 0, SCHEDULE_DAY_MINUTES - 1);
}

export function normalizeScheduleEndMinute(value: unknown): number {
  return integerInRange(value, 'Schedule end minute', 1, SCHEDULE_DAY_MINUTES);
}

export function normalizeScheduleRange(
  startValue: unknown,
  endValue: unknown,
): { readonly startMinute: number; readonly endMinute: number } {
  const startMinute = normalizeScheduleStartMinute(startValue);
  const endMinute = normalizeScheduleEndMinute(endValue);
  if (endMinute <= startMinute) {
    throw new TypeError('Schedule end minute must be later than its start minute.');
  }
  return { startMinute, endMinute };
}

export function normalizeScheduleRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Schedule revision must be a positive safe integer.');
  }
  return value as number;
}

export function formatScheduleMinute(value: number): string {
  const minute = integerInRange(value, 'Schedule minute', 0, SCHEDULE_DAY_MINUTES);
  if (minute === SCHEDULE_DAY_MINUTES) return '24:00';
  return `${Math.floor(minute / 60)
    .toString()
    .padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
}

function integerInRange(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
