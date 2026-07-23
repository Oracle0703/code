import { TASK_PLANNING, TASK_STATUSES, type TaskPlanning, type TaskStatus } from './contracts';

export const TASK_TITLE_MAX_LENGTH = 500;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const FORBIDDEN_TITLE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const VISIBLE_TITLE_CHARACTER = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export function normalizeTaskId(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError('Task id must be a lowercase UUID v4.');
  }
  return value;
}

export function normalizeTaskTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Task title must be a string.');
  }
  if (!isWellFormedUnicode(value)) {
    throw new TypeError('Task title must contain well-formed Unicode.');
  }

  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > TASK_TITLE_MAX_LENGTH ||
    FORBIDDEN_TITLE_CHARACTER.test(normalized) ||
    !VISIBLE_TITLE_CHARACTER.test(normalized)
  ) {
    throw new TypeError('Task title is empty, too long, or contains unsupported characters.');
  }
  return normalized;
}

export function normalizeTaskStatus(value: unknown): TaskStatus {
  if (typeof value !== 'string' || !TASK_STATUSES.includes(value as TaskStatus)) {
    throw new TypeError('Task status is not supported.');
  }
  return value as TaskStatus;
}

export function normalizeTaskPlanning(value: unknown): TaskPlanning {
  if (typeof value !== 'string' || !TASK_PLANNING.includes(value as TaskPlanning)) {
    throw new TypeError('Task planning value is not supported.');
  }
  return value as TaskPlanning;
}

export function normalizeTaskCivilDate(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Task date must be a string.');
  const match = CIVIL_DATE_PATTERN.exec(value);
  if (!match) throw new TypeError('Task date must use YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(0);
  candidate.setUTCHours(0, 0, 0, 0);
  candidate.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    year > 9999 ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    throw new TypeError('Task date is not a valid calendar day.');
  }
  return value;
}

export function formatLocalTaskDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError('Task clock is invalid.');
  const year = value.getFullYear().toString().padStart(4, '0');
  const month = (value.getMonth() + 1).toString().padStart(2, '0');
  const day = value.getDate().toString().padStart(2, '0');
  return normalizeTaskCivilDate(`${year}-${month}-${day}`);
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
