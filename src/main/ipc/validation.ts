import {
  TERMINAL_SHELLS,
  type BrowserBounds,
  type InboxCategorizeInput,
  type InboxCreateInput,
  type InboxTargetInput,
  type InboxUndoInput,
  type NoteArchiveInput,
  type NoteConvertInboxInput,
  type NoteCreateInput,
  type NoteUpdateInput,
  type ScheduleCreateInput,
  type ScheduleTargetInput,
  type ScheduleUpdateInput,
  type TaskConvertInboxInput,
  type TaskCreateInput,
  type TaskPlanningInput,
  type TaskRenameInput,
  type TaskStatusInput,
  type TerminalCreateOptions,
  type TerminalShell,
  type WorkspaceCreateInput,
  type WorkspacePreferencesInput,
  type WorkspaceRenameInput,
  type WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  normalizeInboxCategory,
  normalizeInboxContent,
  normalizeInboxId,
  normalizeInboxUndoToken,
} from '../../shared/inbox-domain';
import {
  normalizeNoteBody,
  normalizeNoteId,
  normalizeNoteRevision,
  normalizeNoteTitle,
} from '../../shared/note-domain';
import {
  normalizeScheduleCivilDate,
  normalizeScheduleId,
  normalizeScheduleKind,
  normalizeScheduleRange,
  normalizeScheduleRevision,
  normalizeScheduleTitle,
} from '../../shared/schedule-domain';
import {
  normalizeTaskId,
  normalizeTaskPlanning,
  normalizeTaskStatus,
  normalizeTaskTitle,
} from '../../shared/task-domain';
import {
  normalizeWorkspaceColor,
  normalizeWorkspaceId,
  normalizeWorkspaceName,
  normalizeWorkspacePreferencesPatch,
} from '../../shared/workspace-domain';

const MAX_URL_LENGTH = 4_096;
const MAX_PATH_LENGTH = 4_096;
const MAX_TERMINAL_WRITE_LENGTH = 1_048_576;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey) {
    throw new TypeError(`Unexpected property: ${unknownKey}`);
  }
}

function assertIntegerInRange(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return value as number;
}

export function parseBrowserBounds(value: unknown): BrowserBounds {
  if (!isRecord(value)) {
    throw new TypeError('Browser bounds must be an object');
  }

  assertOnlyKeys(value, ['x', 'y', 'width', 'height']);

  return {
    x: assertIntegerInRange(value.x, 'x', 0, 32_768),
    y: assertIntegerInRange(value.y, 'y', 0, 32_768),
    width: assertIntegerInRange(value.width, 'width', 0, 32_768),
    height: assertIntegerInRange(value.height, 'height', 0, 32_768),
  };
}

export function parseBrowserUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('URL must be a string');
  }

  const input = value.trim();
  if (input.length === 0 || input.length > MAX_URL_LENGTH || containsControlCharacters(input)) {
    throw new TypeError('URL is empty, too long, or contains control characters');
  }

  return input;
}

export function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }

  return value;
}

export function assertNoArguments(values: readonly unknown[], operation: string): void {
  if (values.length !== 0) {
    throw new TypeError(`${operation} does not accept arguments`);
  }
}

export function parseWorkspaceCreateInput(value: unknown): WorkspaceCreateInput {
  if (!isRecord(value)) {
    throw new TypeError('Workspace creation input must be an object');
  }
  assertOnlyKeys(value, ['name', 'color']);
  return {
    name: normalizeWorkspaceName(value.name),
    color: normalizeWorkspaceColor(value.color),
  };
}

export function parseWorkspaceRenameInput(value: unknown): WorkspaceRenameInput {
  if (!isRecord(value)) {
    throw new TypeError('Workspace rename input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'name']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    name: normalizeWorkspaceName(value.name),
  };
}

export function parseWorkspaceTargetInput(value: unknown): WorkspaceTargetInput {
  if (!isRecord(value)) {
    throw new TypeError('Workspace target input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId']);
  return { workspaceId: normalizeWorkspaceId(value.workspaceId) };
}

export function parseWorkspacePreferencesInput(value: unknown): WorkspacePreferencesInput {
  if (!isRecord(value)) {
    throw new TypeError('Workspace preference input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'patch']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    patch: normalizeWorkspacePreferencesPatch(value.patch),
  };
}

export function parseInboxCreateInput(value: unknown): InboxCreateInput {
  if (!isRecord(value)) {
    throw new TypeError('Inbox creation input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'content', 'category']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    content: normalizeInboxContent(value.content),
    category: normalizeInboxCategory(value.category),
  };
}

export function parseInboxTargetInput(value: unknown): InboxTargetInput {
  if (!isRecord(value)) {
    throw new TypeError('Inbox target input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'entryId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    entryId: normalizeInboxId(value.entryId),
  };
}

export function parseInboxCategorizeInput(value: unknown): InboxCategorizeInput {
  if (!isRecord(value)) {
    throw new TypeError('Inbox categorization input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'entryId', 'category']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    entryId: normalizeInboxId(value.entryId),
    category: normalizeInboxCategory(value.category),
  };
}

export function parseInboxUndoInput(value: unknown): InboxUndoInput {
  if (!isRecord(value)) {
    throw new TypeError('Inbox undo input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'undoToken']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    undoToken: normalizeInboxUndoToken(value.undoToken),
  };
}

export function parseTaskCreateInput(value: unknown): TaskCreateInput {
  if (!isRecord(value)) throw new TypeError('Task creation input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'title', 'planning']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    title: normalizeTaskTitle(value.title),
    planning: normalizeTaskPlanning(value.planning),
  };
}

export function parseTaskRenameInput(value: unknown): TaskRenameInput {
  if (!isRecord(value)) throw new TypeError('Task rename input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'taskId', 'title']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    taskId: normalizeTaskId(value.taskId),
    title: normalizeTaskTitle(value.title),
  };
}

export function parseTaskStatusInput(value: unknown): TaskStatusInput {
  if (!isRecord(value)) throw new TypeError('Task status input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'taskId', 'status']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    taskId: normalizeTaskId(value.taskId),
    status: normalizeTaskStatus(value.status),
  };
}

export function parseTaskPlanningInput(value: unknown): TaskPlanningInput {
  if (!isRecord(value)) throw new TypeError('Task planning input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'taskId', 'planning']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    taskId: normalizeTaskId(value.taskId),
    planning: normalizeTaskPlanning(value.planning),
  };
}

export function parseTaskConvertInboxInput(value: unknown): TaskConvertInboxInput {
  if (!isRecord(value)) throw new TypeError('Task conversion input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'entryId', 'planning']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    entryId: normalizeInboxId(value.entryId),
    planning: normalizeTaskPlanning(value.planning),
  };
}

export function parseNoteCreateInput(value: unknown): NoteCreateInput {
  if (!isRecord(value)) throw new TypeError('Note creation input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'title', 'body']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    title: normalizeNoteTitle(value.title),
    body: normalizeNoteBody(value.body),
  };
}

export function parseNoteUpdateInput(value: unknown): NoteUpdateInput {
  if (!isRecord(value)) throw new TypeError('Note update input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'noteId', 'title', 'body', 'expectedRevision']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    noteId: normalizeNoteId(value.noteId),
    title: normalizeNoteTitle(value.title),
    body: normalizeNoteBody(value.body),
    expectedRevision: normalizeNoteRevision(value.expectedRevision),
  };
}

export function parseNoteArchiveInput(value: unknown): NoteArchiveInput {
  if (!isRecord(value)) throw new TypeError('Note archive input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'noteId', 'expectedRevision']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    noteId: normalizeNoteId(value.noteId),
    expectedRevision: normalizeNoteRevision(value.expectedRevision),
  };
}

export function parseNoteConvertInboxInput(value: unknown): NoteConvertInboxInput {
  if (!isRecord(value)) throw new TypeError('Note conversion input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'entryId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    entryId: normalizeInboxId(value.entryId),
  };
}

export function parseScheduleCreateInput(value: unknown): ScheduleCreateInput {
  if (!isRecord(value)) throw new TypeError('Schedule creation input must be an object');
  assertOnlyKeys(value, [
    'workspaceId',
    'expectedDate',
    'title',
    'kind',
    'startMinute',
    'endMinute',
  ]);
  const range = normalizeScheduleRange(value.startMinute, value.endMinute);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    expectedDate: normalizeScheduleCivilDate(value.expectedDate),
    title: normalizeScheduleTitle(value.title),
    kind: normalizeScheduleKind(value.kind),
    ...range,
  };
}

export function parseScheduleTargetInput(value: unknown): ScheduleTargetInput {
  if (!isRecord(value)) throw new TypeError('Schedule target input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'scheduleId', 'expectedDate', 'expectedRevision']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    scheduleId: normalizeScheduleId(value.scheduleId),
    expectedDate: normalizeScheduleCivilDate(value.expectedDate),
    expectedRevision: normalizeScheduleRevision(value.expectedRevision),
  };
}

export function parseScheduleUpdateInput(value: unknown): ScheduleUpdateInput {
  if (!isRecord(value)) throw new TypeError('Schedule update input must be an object');
  assertOnlyKeys(value, [
    'workspaceId',
    'scheduleId',
    'expectedDate',
    'expectedRevision',
    'title',
    'kind',
    'startMinute',
    'endMinute',
  ]);
  const range = normalizeScheduleRange(value.startMinute, value.endMinute);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    scheduleId: normalizeScheduleId(value.scheduleId),
    expectedDate: normalizeScheduleCivilDate(value.expectedDate),
    expectedRevision: normalizeScheduleRevision(value.expectedRevision),
    title: normalizeScheduleTitle(value.title),
    kind: normalizeScheduleKind(value.kind),
    ...range,
  };
}

export function parseTerminalCreateOptions(value: unknown): TerminalCreateOptions {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    throw new TypeError('Terminal options must be an object');
  }

  assertOnlyKeys(value, ['cwd', 'shell']);

  let cwd: string | undefined;
  if (value.cwd !== undefined) {
    if (
      typeof value.cwd !== 'string' ||
      value.cwd.length === 0 ||
      value.cwd.length > MAX_PATH_LENGTH ||
      value.cwd.includes('\0')
    ) {
      throw new TypeError('cwd must be a non-empty local path');
    }
    cwd = value.cwd;
  }

  let shell: TerminalShell | undefined;
  if (value.shell !== undefined) {
    if (
      typeof value.shell !== 'string' ||
      !TERMINAL_SHELLS.includes(value.shell as TerminalShell)
    ) {
      throw new TypeError('Unsupported terminal shell profile');
    }
    shell = value.shell as TerminalShell;
  }

  return { cwd, shell };
}

export function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new TypeError('Invalid terminal session id');
  }

  return value;
}

export function parseTerminalData(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TERMINAL_WRITE_LENGTH) {
    throw new TypeError('Terminal input must be a string no larger than 1 MiB');
  }

  return value;
}

export function parseTerminalSize(
  columnsValue: unknown,
  rowsValue: unknown,
): { columns: number; rows: number } {
  return {
    columns: assertIntegerInRange(columnsValue, 'columns', 1, 1_000),
    rows: assertIntegerInRange(rowsValue, 'rows', 1, 1_000),
  };
}
