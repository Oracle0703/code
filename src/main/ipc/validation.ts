import {
  type AssistantCancelInput,
  type AssistantCredentialInput,
  type AssistantStartInput,
  type AutomationAction,
  type AutomationCreateInput,
  type AutomationSchedule,
  type AutomationSetEnabledInput,
  type AutomationTargetInput,
  type AutomationUpdateInput,
  BACKUP_CADENCES,
  type BackupCadence,
  type BackupPolicyUpdateInput,
  type BrowserBounds,
  type BrowserBoundsInput,
  type BrowserBookmarkTargetInput,
  type BrowserCreateTabInput,
  type BrowserDownloadTargetInput,
  type BrowserNavigateInput,
  type BrowserOpenBookmarkInput,
  type BrowserTabTargetInput,
  type BrowserVisibilityInput,
  type BrowserWorkspaceInput,
  type DataImportCommitInput,
  type DataImportTargetInput,
  type DatabaseBackupReason,
  type DatabaseBackupRestoreInput,
  type FocusStartInput,
  type FocusTargetInput,
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
  type SearchQueryInput,
  type TaskConvertInboxInput,
  type TaskCreateInput,
  type TaskPlanningInput,
  type TaskRenameInput,
  type TaskStatusInput,
  type TerminalCreateInput,
  type TerminalConfigurationRevisionInput,
  type TerminalProfilePreferenceInput,
  type TerminalResizeInput,
  type TerminalSessionTargetInput,
  type TerminalWorkspaceInput,
  type TerminalWslPreferenceInput,
  type TerminalWriteInput,
  type WindowCloseResponse,
  type WorkspaceCreateInput,
  type WorkspacePreferencesInput,
  type WorkspaceRenameInput,
  type WorkspaceRestoreInput,
  type WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  normalizeAssistantContextReference,
  normalizeAssistantCredentialInput,
  normalizeAssistantPrompt,
} from '../../shared/assistant-domain';
import {
  normalizeAutomationAction,
  normalizeAutomationActionKind,
  normalizeAutomationId,
  normalizeAutomationName,
  normalizeAutomationRevision,
  normalizeAutomationSchedule,
} from '../../shared/automation-domain';
import {
  normalizeTerminalPreferenceRevision,
  normalizeTerminalProfileId,
  normalizeWslDistributionId,
} from '../../shared/terminal-domain';
import { normalizeFocusRevision, normalizeFocusSessionId } from '../../shared/focus-domain';
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
  normalizeWorkspaceRevision,
} from '../../shared/workspace-domain';
import { normalizeSearchQuery, normalizeSearchScope } from '../../shared/search-domain';

const MAX_URL_LENGTH = 4_096;
const MAX_TERMINAL_WRITE_LENGTH = 1_048_576;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DATABASE_BACKUP_REASONS: readonly DatabaseBackupReason[] = [
  'manual',
  'scheduled',
  'pre-migration',
  'pre-import',
];

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

export function parseBrowserWorkspaceInput(value: unknown): BrowserWorkspaceInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser workspace input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId']);
  return { workspaceId: normalizeWorkspaceId(value.workspaceId) };
}

export function parseBrowserCreateTabInput(value: unknown): BrowserCreateTabInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser tab creation input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'url']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    ...(value.url === undefined ? {} : { url: parseBrowserUrl(value.url) }),
  };
}

export function parseBrowserTabTargetInput(value: unknown): BrowserTabTargetInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser tab target must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'tabId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    tabId: parseUuidV4(value.tabId, 'Browser tab id'),
  };
}

export function parseBrowserNavigateInput(value: unknown): BrowserNavigateInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser navigation input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'tabId', 'url']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    tabId: parseUuidV4(value.tabId, 'Browser tab id'),
    url: parseBrowserUrl(value.url),
  };
}

export function parseBrowserBookmarkTargetInput(value: unknown): BrowserBookmarkTargetInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser bookmark target must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'bookmarkId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    bookmarkId: parseUuidV4(value.bookmarkId, 'Browser bookmark id'),
  };
}

export function parseBrowserOpenBookmarkInput(value: unknown): BrowserOpenBookmarkInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser bookmark open input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'bookmarkId', 'newTab']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    bookmarkId: parseUuidV4(value.bookmarkId, 'Browser bookmark id'),
    newTab: parseBoolean(value.newTab, 'newTab'),
  };
}

export function parseBrowserDownloadTargetInput(value: unknown): BrowserDownloadTargetInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser download target must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'downloadId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    downloadId: parseUuidV4(value.downloadId, 'Browser download id'),
  };
}

export function parseBrowserBoundsInput(value: unknown): BrowserBoundsInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser bounds input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'bounds']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    bounds: parseBrowserBounds(value.bounds),
  };
}

export function parseBrowserVisibilityInput(value: unknown): BrowserVisibilityInput {
  if (!isRecord(value)) {
    throw new TypeError('Browser visibility input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'visible']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    visible: parseBoolean(value.visible, 'visible'),
  };
}

export function parseSearchQueryInput(value: unknown): SearchQueryInput {
  if (!isRecord(value)) {
    throw new TypeError('Search input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'query', 'scope']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    query: normalizeSearchQuery(value.query),
    scope: normalizeSearchScope(value.scope),
  };
}

export function parseBackupPolicyUpdateInput(value: unknown): BackupPolicyUpdateInput {
  if (!isRecord(value)) {
    throw new TypeError('Backup policy input must be an object');
  }
  assertOnlyKeys(value, [
    'enabled',
    'cadence',
    'localTimeMinute',
    'weekday',
    'retentionCount',
    'expectedRevision',
  ]);
  const cadence = parseBackupCadence(value.cadence);
  const weekday =
    value.weekday === null ? null : assertIntegerInRange(value.weekday, 'weekday', 0, 6);
  if ((cadence === 'daily' && weekday !== null) || (cadence === 'weekly' && weekday === null)) {
    throw new TypeError('Backup weekday must be null for daily and set for weekly schedules');
  }
  return {
    enabled: parseBoolean(value.enabled, 'enabled'),
    cadence,
    localTimeMinute: assertIntegerInRange(value.localTimeMinute, 'localTimeMinute', 0, 1_439),
    weekday,
    retentionCount: assertIntegerInRange(value.retentionCount, 'retentionCount', 1, 90),
    expectedRevision: assertIntegerInRange(
      value.expectedRevision,
      'expectedRevision',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function parseDatabaseBackupRestoreInput(value: unknown): DatabaseBackupRestoreInput {
  if (!isRecord(value)) {
    throw new TypeError('Database backup restore input must be an object');
  }
  assertOnlyKeys(value, [
    'backupId',
    'expectedReason',
    'expectedCreatedAt',
    'expectedSizeBytes',
    'expectedSchemaVersion',
  ]);
  if (
    typeof value.expectedReason !== 'string' ||
    !DATABASE_BACKUP_REASONS.includes(value.expectedReason as DatabaseBackupReason)
  ) {
    throw new TypeError('Unsupported database backup reason');
  }
  if (typeof value.expectedCreatedAt !== 'string') {
    throw new TypeError('Database backup creation time must be an ISO timestamp');
  }
  const expectedCreatedAt = new Date(value.expectedCreatedAt);
  if (
    !Number.isFinite(expectedCreatedAt.getTime()) ||
    expectedCreatedAt.toISOString() !== value.expectedCreatedAt
  ) {
    throw new TypeError('Database backup creation time must be an ISO timestamp');
  }
  return {
    backupId: parseUuidV4(value.backupId, 'Database backup id'),
    expectedReason: value.expectedReason as DatabaseBackupReason,
    expectedCreatedAt: value.expectedCreatedAt,
    expectedSizeBytes: assertIntegerInRange(
      value.expectedSizeBytes,
      'expectedSizeBytes',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    expectedSchemaVersion: assertIntegerInRange(
      value.expectedSchemaVersion,
      'expectedSchemaVersion',
      0,
      11,
    ),
  };
}

export function parseDataImportTargetInput(value: unknown): DataImportTargetInput {
  if (!isRecord(value)) {
    throw new TypeError('Data import target must be an object');
  }
  assertOnlyKeys(value, ['importId']);
  return { importId: parseUuidV4(value.importId, 'Data import id') };
}

export function parseDataImportCommitInput(value: unknown): DataImportCommitInput {
  if (!isRecord(value)) {
    throw new TypeError('Data import commit input must be an object');
  }
  assertOnlyKeys(value, ['importId', 'previewDigest']);
  if (
    typeof value.previewDigest !== 'string' ||
    value.previewDigest !== value.previewDigest.toLowerCase() ||
    !SHA256_PATTERN.test(value.previewDigest)
  ) {
    throw new TypeError('Data import preview digest must be a lowercase SHA-256 digest');
  }
  return {
    importId: parseUuidV4(value.importId, 'Data import id'),
    previewDigest: value.previewDigest,
  };
}

function parseBackupCadence(value: unknown): BackupCadence {
  if (typeof value !== 'string' || !BACKUP_CADENCES.includes(value as BackupCadence)) {
    throw new TypeError('Unsupported backup cadence');
  }
  return value as BackupCadence;
}

export function parseBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }

  return value;
}

export function parseWindowCloseResponse(value: unknown): WindowCloseResponse {
  if (!isRecord(value)) {
    throw new TypeError('Window close response must be an object');
  }
  assertOnlyKeys(value, ['requestId', 'approved']);
  return {
    requestId: parseUuidV4(value.requestId, 'Window close request id'),
    approved: parseBoolean(value.approved, 'approved'),
  };
}

function parseUuidV4(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.toLowerCase() ||
    !SESSION_ID_PATTERN.test(value)
  ) {
    throw new TypeError(`${name} must be a lowercase UUID v4`);
  }
  return value;
}

export function assertNoArguments(values: readonly unknown[], operation: string): void {
  if (values.length !== 0) {
    throw new TypeError(`${operation} does not accept arguments`);
  }
}

export function parseAssistantCredentialInput(value: unknown): AssistantCredentialInput {
  return normalizeAssistantCredentialInput(value);
}

export function parseAssistantStartInput(value: unknown): AssistantStartInput {
  if (!isRecord(value)) {
    throw new TypeError('Assistant start input must be an object');
  }
  assertOnlyKeys(value, ['prompt', 'context']);
  return {
    prompt: normalizeAssistantPrompt(value.prompt),
    context: normalizeAssistantContextReference(value.context),
  };
}

export function parseAssistantCancelInput(value: unknown): AssistantCancelInput {
  if (!isRecord(value)) {
    throw new TypeError('Assistant cancellation input must be an object');
  }
  assertOnlyKeys(value, ['runId']);
  return { runId: parseUuidV4(value.runId, 'Assistant run id') };
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

export function parseWorkspaceRestoreInput(value: unknown): WorkspaceRestoreInput {
  if (!isRecord(value)) {
    throw new TypeError('Workspace restore input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'expectedRevision', 'name']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    expectedRevision: normalizeWorkspaceRevision(value.expectedRevision),
    name: normalizeWorkspaceName(value.name),
  };
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

export function parseFocusStartInput(value: unknown): FocusStartInput {
  if (!isRecord(value)) throw new TypeError('Focus start input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'taskId']);
  const workspaceId = normalizeWorkspaceId(value.workspaceId);
  if (value.taskId === undefined) return { workspaceId };
  return {
    workspaceId,
    taskId: normalizeTaskId(value.taskId),
  };
}

export function parseFocusTargetInput(value: unknown): FocusTargetInput {
  if (!isRecord(value)) throw new TypeError('Focus target input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'sessionId', 'expectedRevision']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    sessionId: normalizeFocusSessionId(value.sessionId),
    expectedRevision: normalizeFocusRevision(value.expectedRevision),
  };
}

function parseAutomationSchedule(value: unknown): AutomationSchedule {
  if (!isRecord(value)) throw new TypeError('Automation schedule must be an object');
  assertOnlyKeys(value, ['cadence', 'localTimeMinute', 'weekday']);
  return normalizeAutomationSchedule(value);
}

function parseAutomationAction(value: unknown): AutomationAction {
  if (!isRecord(value)) throw new TypeError('Automation action must be an object');
  const kind = normalizeAutomationActionKind(value.kind);
  assertOnlyKeys(
    value,
    kind === 'create-today-task' ? ['kind', 'title'] : ['kind', 'title', 'body'],
  );
  return normalizeAutomationAction(value);
}

export function parseAutomationCreateInput(value: unknown): AutomationCreateInput {
  if (!isRecord(value)) throw new TypeError('Automation creation input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'name', 'schedule', 'action']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    name: normalizeAutomationName(value.name),
    schedule: parseAutomationSchedule(value.schedule),
    action: parseAutomationAction(value.action),
  };
}

export function parseAutomationTargetInput(value: unknown): AutomationTargetInput {
  if (!isRecord(value)) throw new TypeError('Automation target input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'automationId', 'expectedRevision']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    automationId: normalizeAutomationId(value.automationId),
    expectedRevision: normalizeAutomationRevision(value.expectedRevision),
  };
}

export function parseAutomationUpdateInput(value: unknown): AutomationUpdateInput {
  if (!isRecord(value)) throw new TypeError('Automation update input must be an object');
  assertOnlyKeys(value, [
    'workspaceId',
    'automationId',
    'expectedRevision',
    'name',
    'schedule',
    'action',
  ]);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    automationId: normalizeAutomationId(value.automationId),
    expectedRevision: normalizeAutomationRevision(value.expectedRevision),
    name: normalizeAutomationName(value.name),
    schedule: parseAutomationSchedule(value.schedule),
    action: parseAutomationAction(value.action),
  };
}

export function parseAutomationSetEnabledInput(value: unknown): AutomationSetEnabledInput {
  if (!isRecord(value)) throw new TypeError('Automation enabled input must be an object');
  assertOnlyKeys(value, ['workspaceId', 'automationId', 'expectedRevision', 'enabled']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    automationId: normalizeAutomationId(value.automationId),
    expectedRevision: normalizeAutomationRevision(value.expectedRevision),
    enabled: parseBoolean(value.enabled, 'enabled'),
  };
}

export function parseTerminalWorkspaceInput(value: unknown): TerminalWorkspaceInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal workspace input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId']);
  return { workspaceId: normalizeWorkspaceId(value.workspaceId) };
}

export function parseTerminalCreateInput(value: unknown): TerminalCreateInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal creation input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'configurationRevision', 'profileId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    configurationRevision: normalizeTerminalPreferenceRevision(value.configurationRevision),
    ...(value.profileId === undefined
      ? {}
      : { profileId: normalizeTerminalProfileId(value.profileId) }),
  };
}

export function parseTerminalConfigurationRevisionInput(
  value: unknown,
): TerminalConfigurationRevisionInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal configuration input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'expectedRevision']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    expectedRevision: normalizeTerminalPreferenceRevision(value.expectedRevision),
  };
}

export function parseTerminalProfilePreferenceInput(
  value: unknown,
): TerminalProfilePreferenceInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal profile preference input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'expectedRevision', 'profileId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    expectedRevision: normalizeTerminalPreferenceRevision(value.expectedRevision),
    profileId: normalizeTerminalProfileId(value.profileId),
  };
}

export function parseTerminalWslPreferenceInput(value: unknown): TerminalWslPreferenceInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal WSL preference input must be an object');
  }
  assertOnlyKeys(value, [
    'workspaceId',
    'expectedRevision',
    'capabilityRevision',
    'distributionId',
  ]);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    expectedRevision: normalizeTerminalPreferenceRevision(value.expectedRevision),
    capabilityRevision: normalizeTerminalPreferenceRevision(value.capabilityRevision),
    distributionId:
      value.distributionId === null ? null : normalizeWslDistributionId(value.distributionId),
  };
}

export function parseTerminalSessionTargetInput(value: unknown): TerminalSessionTargetInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal session target input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'sessionId']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    sessionId: parseSessionId(value.sessionId),
  };
}

export function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
    throw new TypeError('Invalid terminal session id');
  }

  return value;
}

function parseTerminalData(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_TERMINAL_WRITE_LENGTH) {
    throw new TypeError('Terminal input must be a string no larger than 1 MiB');
  }

  return value;
}

export function parseTerminalWriteInput(value: unknown): TerminalWriteInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal write input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'sessionId', 'data']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    sessionId: parseSessionId(value.sessionId),
    data: parseTerminalData(value.data),
  };
}

export function parseTerminalResizeInput(value: unknown): TerminalResizeInput {
  if (!isRecord(value)) {
    throw new TypeError('Terminal resize input must be an object');
  }
  assertOnlyKeys(value, ['workspaceId', 'sessionId', 'columns', 'rows']);
  return {
    workspaceId: normalizeWorkspaceId(value.workspaceId),
    sessionId: parseSessionId(value.sessionId),
    columns: assertIntegerInRange(value.columns, 'columns', 1, 1_000),
    rows: assertIntegerInRange(value.rows, 'rows', 1, 1_000),
  };
}
