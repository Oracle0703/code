import type { AssistantContextReference, AssistantCredentialInput } from './contracts';
import { normalizeNoteId, normalizeNoteRevision } from './note-domain';
import { normalizeTaskId } from './task-domain';

export const ASSISTANT_PROVIDER = 'OpenAI';
export const ASSISTANT_MODEL = 'gpt-5.6';
export const ASSISTANT_PROMPT_MAX_LENGTH = 4_000;
export const ASSISTANT_SELECTED_TASK_MAX_COUNT = 20;
export const ASSISTANT_NOTE_CONTEXT_MAX_LENGTH = 20_000;
export const ASSISTANT_TODAY_TASK_MAX_COUNT = 50;
export const ASSISTANT_TODAY_SCHEDULE_MAX_COUNT = 50;
export const ASSISTANT_RESPONSE_MAX_LENGTH = 50_000;
export const ASSISTANT_API_KEY_MIN_LENGTH = 20;
export const ASSISTANT_API_KEY_MAX_LENGTH = 512;

const OPENAI_API_KEY_PATTERN = /^sk-[\x21-\x7e]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`Unexpected assistant input field: ${key}`);
    }
  }
}

export function normalizeAssistantPrompt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Assistant prompt must be a string');
  }
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > ASSISTANT_PROMPT_MAX_LENGTH ||
    containsDisallowedPromptControl(normalized)
  ) {
    throw new TypeError(
      `Assistant prompt must contain between 1 and ${ASSISTANT_PROMPT_MAX_LENGTH} visible characters`,
    );
  }
  return normalized;
}

function containsDisallowedPromptControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint <= 31 && codePoint !== 9 && codePoint !== 10) || codePoint === 127;
  });
}

export function normalizeAssistantApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < ASSISTANT_API_KEY_MIN_LENGTH ||
    value.length > ASSISTANT_API_KEY_MAX_LENGTH ||
    value !== value.trim() ||
    !OPENAI_API_KEY_PATTERN.test(value)
  ) {
    throw new TypeError('OpenAI API key format is invalid');
  }
  return value;
}

export function normalizeAssistantCredentialInput(value: unknown): AssistantCredentialInput {
  if (!isRecord(value)) {
    throw new TypeError('Assistant credential input must be an object');
  }
  assertOnlyKeys(value, ['apiKey']);
  return { apiKey: normalizeAssistantApiKey(value.apiKey) };
}

export function normalizeAssistantContextReference(value: unknown): AssistantContextReference {
  if (!isRecord(value)) {
    throw new TypeError('Assistant context must be an object');
  }
  if (typeof value.kind !== 'string') {
    throw new TypeError('Assistant context kind is invalid');
  }
  switch (value.kind) {
    case 'none':
    case 'today': {
      assertOnlyKeys(value, ['kind']);
      return { kind: value.kind };
    }
    case 'tasks': {
      assertOnlyKeys(value, ['kind', 'taskIds']);
      if (!Array.isArray(value.taskIds)) {
        throw new TypeError('Assistant task context must contain an array of task ids');
      }
      if (value.taskIds.length < 1 || value.taskIds.length > ASSISTANT_SELECTED_TASK_MAX_COUNT) {
        throw new TypeError(
          `Assistant task context must select between 1 and ${ASSISTANT_SELECTED_TASK_MAX_COUNT} tasks`,
        );
      }
      const taskIds = value.taskIds.map(normalizeTaskId);
      if (new Set(taskIds).size !== taskIds.length) {
        throw new TypeError('Assistant task context must not contain duplicate task ids');
      }
      return { kind: 'tasks', taskIds };
    }
    case 'note': {
      assertOnlyKeys(value, ['kind', 'noteId', 'revision']);
      return {
        kind: 'note',
        noteId: normalizeNoteId(value.noteId),
        revision: normalizeNoteRevision(value.revision),
      };
    }
    default:
      throw new TypeError('Assistant context kind is invalid');
  }
}

export function sliceAssistantText(
  value: string,
  maximumLength: number,
): { readonly value: string; readonly totalLength: number; readonly truncated: boolean } {
  const characters = Array.from(value);
  if (characters.length <= maximumLength) {
    return { value, totalLength: characters.length, truncated: false };
  }
  return {
    value: characters.slice(0, maximumLength).join(''),
    totalLength: characters.length,
    truncated: true,
  };
}
