import {
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_CADENCES,
  type AutomationAction,
  type AutomationActionKind,
  type AutomationCadence,
  type AutomationSchedule,
} from './contracts';
import { normalizeNoteBody, normalizeNoteTitle } from './note-domain';
import { normalizeTaskTitle } from './task-domain';

export const AUTOMATION_NAME_MAX_LENGTH = 120;
export const AUTOMATION_LOCAL_DAY_MINUTES = 1_440;
export const AUTOMATION_ENABLED_WORKSPACE_LIMIT = 25;
export const AUTOMATION_ACTIVE_GLOBAL_LIMIT = 100;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_NAME_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const VISIBLE_NAME_CHARACTER = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export function normalizeAutomationId(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !UUID_V4_PATTERN.test(value)) {
    throw new TypeError('Automation id must be a lowercase UUID v4.');
  }
  return value;
}

export function normalizeAutomationName(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) {
    throw new TypeError('Automation name must be a well-formed string.');
  }
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > AUTOMATION_NAME_MAX_LENGTH ||
    FORBIDDEN_NAME_CHARACTER.test(normalized) ||
    !VISIBLE_NAME_CHARACTER.test(normalized)
  ) {
    throw new TypeError('Automation name is empty, too long, or contains unsupported characters.');
  }
  return normalized;
}

export function normalizeAutomationCadence(value: unknown): AutomationCadence {
  if (typeof value !== 'string' || !AUTOMATION_CADENCES.includes(value as AutomationCadence)) {
    throw new TypeError('Automation cadence is not supported.');
  }
  return value as AutomationCadence;
}

export function normalizeAutomationActionKind(value: unknown): AutomationActionKind {
  if (
    typeof value !== 'string' ||
    !AUTOMATION_ACTION_KINDS.includes(value as AutomationActionKind)
  ) {
    throw new TypeError('Automation action is not supported.');
  }
  return value as AutomationActionKind;
}

export function normalizeAutomationLocalTimeMinute(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= AUTOMATION_LOCAL_DAY_MINUTES
  ) {
    throw new TypeError('Automation local time must be a minute within the local day.');
  }
  return value as number;
}

export function normalizeAutomationWeekday(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 6) {
    throw new TypeError('Automation weekday must be an integer between 0 and 6.');
  }
  return value as number;
}

export function normalizeAutomationSchedule(value: unknown): AutomationSchedule {
  if (!isRecord(value)) {
    throw new TypeError('Automation schedule must be an object.');
  }
  const cadence = normalizeAutomationCadence(value.cadence);
  const localTimeMinute = normalizeAutomationLocalTimeMinute(value.localTimeMinute);
  const weekday = normalizeAutomationWeekday(value.weekday);
  if ((cadence === 'daily' && weekday !== null) || (cadence === 'weekly' && weekday === null)) {
    throw new TypeError('Automation weekday must be null for daily and set for weekly schedules.');
  }
  return { cadence, localTimeMinute, weekday };
}

export function normalizeAutomationAction(value: unknown): AutomationAction {
  if (!isRecord(value)) {
    throw new TypeError('Automation action must be an object.');
  }
  const kind = normalizeAutomationActionKind(value.kind);
  if (kind === 'create-today-task') {
    return { kind, title: normalizeTaskTitle(value.title) };
  }
  return {
    kind,
    title: normalizeNoteTitle(value.title),
    body: normalizeNoteBody(value.body),
  };
}

export function normalizeAutomationRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('Automation revision must be a positive safe integer.');
  }
  return value as number;
}

export function formatAutomationMinute(value: number): string {
  const minute = normalizeAutomationLocalTimeMinute(value);
  return `${Math.floor(minute / 60)
    .toString()
    .padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
