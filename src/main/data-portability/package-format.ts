import { createHash } from 'node:crypto';
import type { DataImportCounts } from '../../shared/contracts';
import {
  normalizeAutomationAction,
  normalizeAutomationId,
  normalizeAutomationName,
  normalizeAutomationRevision,
  normalizeAutomationSchedule,
} from '../../shared/automation-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';

export const DATA_PACKAGE_FORMAT = 'daily-workbench-portable';
export const LEGACY_DATA_PACKAGE_FORMAT_VERSION = 1;
export const DATA_PACKAGE_FORMAT_VERSION = 2;
export const DEFAULT_MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1024;
export const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RECORDS = 100_000;

const LEGACY_PORTABLE_RECORD_TYPES = [
  'app-state',
  'workspace',
  'workspace-preference',
  'inbox-entry',
  'task',
  'note',
  'schedule-item',
  'browser-tab',
  'browser-state',
  'browser-bookmark',
] as const;

export const PORTABLE_RECORD_TYPES = [
  ...LEGACY_PORTABLE_RECORD_TYPES,
  'automation-definition',
] as const;

export type PortableRecordType = (typeof PORTABLE_RECORD_TYPES)[number];
export type PortablePackageFormatVersion =
  typeof LEGACY_DATA_PACKAGE_FORMAT_VERSION | typeof DATA_PACKAGE_FORMAT_VERSION;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface PortableDataRecord {
  readonly type: PortableRecordType;
  readonly data: { readonly [key: string]: JsonValue };
}

export interface PortablePackageManifest {
  readonly format: typeof DATA_PACKAGE_FORMAT;
  readonly formatVersion: PortablePackageFormatVersion;
  readonly exportId: string;
  readonly exportedAt: string;
  readonly sourceAppVersion: string;
  readonly sourceSchemaVersion: number;
  readonly recordCount: number;
  readonly counts: DataImportCounts;
  readonly bodySha256: string;
}

export interface ParsedPortablePackage {
  readonly manifest: PortablePackageManifest;
  readonly records: readonly PortableDataRecord[];
  readonly currentWorkspaceName: string;
  readonly packageSha256: string;
}

export interface PortablePackageSource {
  readonly exportId: string;
  readonly exportedAt: string;
  readonly sourceAppVersion: string;
  readonly sourceSchemaVersion: number;
  readonly records: readonly PortableDataRecord[];
}

export interface PortablePackageLimits {
  readonly maxPackageBytes?: number;
  readonly maxRecordBytes?: number;
  readonly maxRecords?: number;
}

export class DataPackageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataPackageError';
  }
}

export function serializePortablePackage(
  source: PortablePackageSource,
  limits: PortablePackageLimits = {},
): Buffer {
  validateUuid(source.exportId, 'export id');
  validateIsoTimestamp(source.exportedAt, 'export time');
  validateSourceVersion(source.sourceAppVersion);
  validateSchemaVersion(source.sourceSchemaVersion);
  const formatVersion = formatVersionForSchema(source.sourceSchemaVersion);
  const resolvedLimits = resolveLimits(limits);
  if (source.records.length > resolvedLimits.maxRecords) {
    throw new DataPackageError('The data package contains too many records.');
  }

  let bodyByteLength = 0;
  const lines = source.records.map((record) => {
    validateRecord(record, formatVersion);
    const line = canonicalJson(record);
    const lineByteLength = Buffer.byteLength(line, 'utf8');
    if (lineByteLength > resolvedLimits.maxRecordBytes) {
      throw new DataPackageError('A data package record exceeds the size limit.');
    }
    bodyByteLength += lineByteLength + 1;
    if (bodyByteLength >= resolvedLimits.maxPackageBytes) {
      throw new DataPackageError('The data package exceeds the size limit.');
    }
    return line;
  });
  const body = `${lines.join('\n')}\n`;
  const bodySha256 = sha256(Buffer.from(body, 'utf8'));
  const counts = countRecords(source.records);
  validateRecordGraph(source.records);
  const manifest = {
    format: DATA_PACKAGE_FORMAT,
    formatVersion,
    exportId: source.exportId.toLowerCase(),
    exportedAt: source.exportedAt,
    sourceAppVersion: source.sourceAppVersion,
    sourceSchemaVersion: source.sourceSchemaVersion,
    recordCount: source.records.length,
    counts: formatVersion === LEGACY_DATA_PACKAGE_FORMAT_VERSION ? toLegacyCounts(counts) : counts,
    bodySha256,
  };
  const output = Buffer.from(`${canonicalJson(manifest)}\n${body}`, 'utf8');
  if (output.byteLength > resolvedLimits.maxPackageBytes) {
    throw new DataPackageError('The data package exceeds the size limit.');
  }
  return output;
}

export function parsePortablePackage(
  bytes: Uint8Array,
  limits: PortablePackageLimits = {},
): ParsedPortablePackage {
  const resolvedLimits = resolveLimits(limits);
  if (bytes.byteLength === 0 || bytes.byteLength > resolvedLimits.maxPackageBytes) {
    throw new DataPackageError('The data package size is invalid.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DataPackageError('The data package is not valid UTF-8.', { cause: error });
  }
  const firstNewline = text.indexOf('\n');
  if (
    firstNewline < 1 ||
    Buffer.byteLength(text.slice(0, firstNewline), 'utf8') > DEFAULT_MAX_MANIFEST_BYTES ||
    !text.endsWith('\n')
  ) {
    throw new DataPackageError('The data package framing is invalid.');
  }
  const manifestLine = text.slice(0, firstNewline);
  const body = text.slice(firstNewline + 1);
  if (manifestLine.endsWith('\r') || body.length === 0) {
    throw new DataPackageError('The data package uses invalid line framing.');
  }
  const manifestValue = parseCanonicalLine(manifestLine, 'manifest');
  const manifest = parseManifest(manifestValue);
  if (manifest.recordCount > resolvedLimits.maxRecords) {
    throw new DataPackageError('The data package contains too many records.');
  }
  if (sha256Utf8(body) !== manifest.bodySha256) {
    throw new DataPackageError('The data package body digest does not match its manifest.');
  }

  const records: PortableDataRecord[] = [];
  let lineStart = 0;
  while (lineStart < body.length) {
    const lineEnd = body.indexOf('\n', lineStart);
    if (lineEnd < lineStart || records.length >= resolvedLimits.maxRecords) {
      throw new DataPackageError('The data package record count is invalid.');
    }
    const line = body.slice(lineStart, lineEnd);
    if (
      line.length === 0 ||
      line.endsWith('\r') ||
      Buffer.byteLength(line, 'utf8') > resolvedLimits.maxRecordBytes
    ) {
      throw new DataPackageError('A data package record has invalid framing or size.');
    }
    const value = parseCanonicalLine(line, 'record');
    records.push(parseRecord(value, manifest.formatVersion));
    lineStart = lineEnd + 1;
  }
  if (records.length !== manifest.recordCount) {
    throw new DataPackageError('The data package record count is invalid.');
  }
  const counts = countRecords(records);
  if (canonicalJson(counts) !== canonicalJson(manifest.counts)) {
    throw new DataPackageError('The data package counts do not match its records.');
  }
  const currentWorkspaceName = validateRecordGraph(records);
  return {
    manifest,
    records,
    currentWorkspaceName,
    packageSha256: sha256(bytes),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, 0));
}

function parseCanonicalLine(line: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new DataPackageError(`The data package ${label} is not valid JSON.`, { cause: error });
  }
  if (canonicalJson(value) !== line) {
    throw new DataPackageError(`The data package ${label} is not canonical JSON.`);
  }
  return value;
}

function parseManifest(value: unknown): PortablePackageManifest {
  assertExactObjectKeys(value, [
    'bodySha256',
    'counts',
    'exportId',
    'exportedAt',
    'format',
    'formatVersion',
    'recordCount',
    'sourceAppVersion',
    'sourceSchemaVersion',
  ]);
  const object = value as Record<string, unknown>;
  if (object.format !== DATA_PACKAGE_FORMAT || !isSupportedFormatVersion(object.formatVersion)) {
    throw new DataPackageError('The data package format is not supported.');
  }
  validateUuid(object.exportId, 'export id');
  validateIsoTimestamp(object.exportedAt, 'export time');
  validateSourceVersion(object.sourceAppVersion);
  validateSchemaVersion(object.sourceSchemaVersion);
  assertFormatMatchesSchema(object.formatVersion, object.sourceSchemaVersion);
  if (!Number.isSafeInteger(object.recordCount) || (object.recordCount as number) < 1) {
    throw new DataPackageError('The data package record count is invalid.');
  }
  validateDigest(object.bodySha256, 'body digest');
  const counts = parseCounts(object.counts, object.formatVersion);
  return {
    format: DATA_PACKAGE_FORMAT,
    formatVersion: object.formatVersion,
    exportId: (object.exportId as string).toLowerCase(),
    exportedAt: object.exportedAt as string,
    sourceAppVersion: object.sourceAppVersion as string,
    sourceSchemaVersion: object.sourceSchemaVersion as number,
    recordCount: object.recordCount as number,
    counts,
    bodySha256: object.bodySha256 as string,
  };
}

function parseRecord(
  value: unknown,
  formatVersion: PortablePackageFormatVersion,
): PortableDataRecord {
  assertExactObjectKeys(value, ['data', 'type']);
  const object = value as Record<string, unknown>;
  if (typeof object.type !== 'string' || !isRecordTypeSupported(object.type, formatVersion)) {
    throw new DataPackageError('The data package record type is invalid.');
  }
  if (!isPlainObject(object.data)) {
    throw new DataPackageError('The data package record payload is invalid.');
  }
  const record = {
    type: object.type as PortableRecordType,
    data: object.data as { readonly [key: string]: JsonValue },
  };
  validateRecord(record, formatVersion);
  return record;
}

function validateRecord(
  record: PortableDataRecord,
  formatVersion: PortablePackageFormatVersion,
): void {
  if (!isRecordTypeSupported(record.type, formatVersion) || !isPlainObject(record.data)) {
    throw new DataPackageError('The data package record is invalid.');
  }
  canonicalize(record.data, 0);
  if (record.type === 'app-state') {
    assertRecordString(record, 'currentWorkspaceId', 36);
    validateUuid(record.data.currentWorkspaceId, 'current workspace id');
  } else if (record.type === 'workspace') {
    assertRecordString(record, 'id', 36);
    validateUuid(record.data.id, 'workspace id');
    assertRecordString(record, 'name', 80);
    const archivedAt = record.data.archivedAt;
    if (!Object.hasOwn(record.data, 'archivedAt')) {
      throw new DataPackageError('The workspace archive state is missing.');
    }
    if (archivedAt !== null) {
      validateIsoTimestamp(archivedAt, 'workspace archive time');
    }
  } else if (record.type === 'automation-definition') {
    validateAutomationRecord(record);
  }
}

function validateAutomationRecord(record: PortableDataRecord): void {
  assertExactObjectKeys(record.data, [
    'action',
    'archivedAt',
    'createdAt',
    'enabled',
    'id',
    'name',
    'revision',
    'schedule',
    'updatedAt',
    'workspaceId',
  ]);
  const data = record.data;
  if (typeof data.enabled !== 'boolean') {
    throw new DataPackageError('The automation enabled state is invalid.');
  }
  if (!isPlainObject(data.schedule)) {
    throw new DataPackageError('The automation schedule is invalid.');
  }
  assertExactObjectKeys(data.schedule, ['cadence', 'localTimeMinute', 'weekday']);
  if (!isPlainObject(data.action) || typeof data.action.kind !== 'string') {
    throw new DataPackageError('The automation action is invalid.');
  }
  assertExactObjectKeys(
    data.action,
    data.action.kind === 'create-today-task' ? ['kind', 'title'] : ['body', 'kind', 'title'],
  );

  try {
    const id = normalizeAutomationId(data.id);
    const workspaceId = normalizeWorkspaceId(data.workspaceId);
    const name = normalizeAutomationName(data.name);
    const schedule = normalizeAutomationSchedule(data.schedule);
    const action = normalizeAutomationAction(data.action);
    const revision = normalizeAutomationRevision(data.revision);
    if (
      id !== data.id ||
      workspaceId !== data.workspaceId ||
      name !== data.name ||
      canonicalJson(schedule) !== canonicalJson(data.schedule) ||
      canonicalJson(action) !== canonicalJson(data.action) ||
      revision !== data.revision
    ) {
      throw new TypeError('Automation values must already be normalized.');
    }
  } catch (error) {
    throw new DataPackageError('The automation definition is invalid.', { cause: error });
  }

  validateIsoTimestamp(data.createdAt, 'automation creation time');
  validateIsoTimestamp(data.updatedAt, 'automation update time');
  if ((data.updatedAt as string) < (data.createdAt as string)) {
    throw new DataPackageError('The automation update time precedes its creation time.');
  }
  if (!Object.hasOwn(data, 'archivedAt')) {
    throw new DataPackageError('The automation archive state is missing.');
  }
  if (data.archivedAt !== null) {
    validateIsoTimestamp(data.archivedAt, 'automation archive time');
    if (
      data.enabled ||
      (data.archivedAt as string) < (data.createdAt as string) ||
      (data.updatedAt as string) < (data.archivedAt as string)
    ) {
      throw new DataPackageError('The archived automation state is invalid.');
    }
  }
}

function validateRecordGraph(records: readonly PortableDataRecord[]): string {
  const appStates = records.filter(({ type }) => type === 'app-state');
  if (appStates.length !== 1) {
    throw new DataPackageError('The data package must contain exactly one application state.');
  }
  const currentWorkspaceId = appStates[0].data.currentWorkspaceId;
  if (typeof currentWorkspaceId !== 'string') {
    throw new DataPackageError('The data package current workspace id is invalid.');
  }
  const workspaceNames = new Map<string, string>();
  for (const record of records) {
    if (record.type !== 'workspace') continue;
    const id = record.data.id;
    const name = record.data.name;
    if (typeof id !== 'string' || typeof name !== 'string' || workspaceNames.has(id)) {
      throw new DataPackageError('The data package workspace identity is invalid.');
    }
    workspaceNames.set(id, name);
  }
  const currentWorkspaceName = workspaceNames.get(currentWorkspaceId);
  if (!currentWorkspaceName) {
    throw new DataPackageError('The data package current workspace is missing.');
  }
  const automationIds = new Set<string>();
  for (const record of records) {
    if (record.type !== 'automation-definition') continue;
    const id = record.data.id;
    const workspaceId = record.data.workspaceId;
    if (
      typeof id !== 'string' ||
      typeof workspaceId !== 'string' ||
      automationIds.has(id) ||
      !workspaceNames.has(workspaceId)
    ) {
      throw new DataPackageError('The data package automation identity or workspace is invalid.');
    }
    automationIds.add(id);
  }
  return currentWorkspaceName;
}

function countRecords(records: readonly PortableDataRecord[]): DataImportCounts {
  const counts: {
    workspaces: number;
    archivedWorkspaces: number;
    inboxEntries: number;
    tasks: number;
    notes: number;
    scheduleItems: number;
    browserTabs: number;
    browserBookmarks: number;
    automations: number;
    enabledAutomations: number;
  } = {
    workspaces: 0,
    archivedWorkspaces: 0,
    inboxEntries: 0,
    tasks: 0,
    notes: 0,
    scheduleItems: 0,
    browserTabs: 0,
    browserBookmarks: 0,
    automations: 0,
    enabledAutomations: 0,
  };
  for (const record of records) {
    switch (record.type) {
      case 'workspace':
        counts.workspaces += 1;
        if (record.data.archivedAt !== null && record.data.archivedAt !== undefined) {
          counts.archivedWorkspaces += 1;
        }
        break;
      case 'inbox-entry':
        counts.inboxEntries += 1;
        break;
      case 'task':
        counts.tasks += 1;
        break;
      case 'note':
        counts.notes += 1;
        break;
      case 'schedule-item':
        counts.scheduleItems += 1;
        break;
      case 'browser-tab':
        counts.browserTabs += 1;
        break;
      case 'browser-bookmark':
        counts.browserBookmarks += 1;
        break;
      case 'automation-definition':
        counts.automations += 1;
        if (record.data.enabled === true) counts.enabledAutomations += 1;
        break;
      default:
        break;
    }
  }
  return counts;
}

function parseCounts(
  value: unknown,
  formatVersion: PortablePackageFormatVersion,
): DataImportCounts {
  const legacyKeys = [
    'archivedWorkspaces',
    'browserBookmarks',
    'browserTabs',
    'inboxEntries',
    'notes',
    'scheduleItems',
    'tasks',
    'workspaces',
  ] as const;
  assertExactObjectKeys(
    value,
    formatVersion === LEGACY_DATA_PACKAGE_FORMAT_VERSION
      ? legacyKeys
      : [...legacyKeys, 'automations', 'enabledAutomations'],
  );
  const object = value as Record<string, unknown>;
  for (const count of Object.values(object)) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new DataPackageError('The data package contains an invalid count.');
    }
  }
  return {
    workspaces: object.workspaces as number,
    archivedWorkspaces: object.archivedWorkspaces as number,
    inboxEntries: object.inboxEntries as number,
    tasks: object.tasks as number,
    notes: object.notes as number,
    scheduleItems: object.scheduleItems as number,
    browserTabs: object.browserTabs as number,
    browserBookmarks: object.browserBookmarks as number,
    automations:
      formatVersion === LEGACY_DATA_PACKAGE_FORMAT_VERSION ? 0 : (object.automations as number),
    enabledAutomations:
      formatVersion === LEGACY_DATA_PACKAGE_FORMAT_VERSION
        ? 0
        : (object.enabledAutomations as number),
  };
}

function toLegacyCounts(
  counts: DataImportCounts,
): Omit<DataImportCounts, 'automations' | 'enabledAutomations'> {
  return {
    workspaces: counts.workspaces,
    archivedWorkspaces: counts.archivedWorkspaces,
    inboxEntries: counts.inboxEntries,
    tasks: counts.tasks,
    notes: counts.notes,
    scheduleItems: counts.scheduleItems,
    browserTabs: counts.browserTabs,
    browserBookmarks: counts.browserBookmarks,
  };
}

function formatVersionForSchema(schemaVersion: number): PortablePackageFormatVersion {
  if (schemaVersion === 7 || schemaVersion === 8) {
    return LEGACY_DATA_PACKAGE_FORMAT_VERSION;
  }
  if (schemaVersion === 9) return DATA_PACKAGE_FORMAT_VERSION;
  throw new DataPackageError('The data package source schema version is not supported.');
}

function assertFormatMatchesSchema(
  formatVersion: PortablePackageFormatVersion,
  schemaVersion: number,
): void {
  const expected = formatVersionForSchema(schemaVersion);
  if (expected !== formatVersion) {
    throw new DataPackageError('The data package format does not match its source schema.');
  }
}

function isSupportedFormatVersion(value: unknown): value is PortablePackageFormatVersion {
  return value === LEGACY_DATA_PACKAGE_FORMAT_VERSION || value === DATA_PACKAGE_FORMAT_VERSION;
}

function isRecordTypeSupported(
  value: unknown,
  formatVersion: PortablePackageFormatVersion,
): value is PortableRecordType {
  if (typeof value !== 'string') return false;
  return (
    formatVersion === DATA_PACKAGE_FORMAT_VERSION
      ? PORTABLE_RECORD_TYPES
      : LEGACY_PORTABLE_RECORD_TYPES
  ).includes(value as never);
}

function canonicalize(value: unknown, depth: number): JsonValue {
  if (depth > 24) throw new DataPackageError('The data package JSON is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new DataPackageError('The data package JSON contains an unsafe number.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    throw new DataPackageError('The data package JSON arrays are not supported.');
  }
  if (!isPlainObject(value)) {
    throw new DataPackageError('The data package JSON contains an unsupported value.');
  }
  const keys = Object.keys(value);
  if (keys.length > 1_000) {
    throw new DataPackageError('The data package JSON object has too many fields.');
  }
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys.sort()) {
    if (key.length === 0 || key.length > 128) {
      throw new DataPackageError('The data package JSON contains an invalid field name.');
    }
    result[key] = canonicalize((value as Record<string, unknown>)[key], depth + 1);
  }
  return result;
}

function assertExactObjectKeys(value: unknown, expectedKeys: readonly string[]): void {
  if (!isPlainObject(value)) {
    throw new DataPackageError('The data package JSON object is invalid.');
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DataPackageError('The data package JSON fields are invalid.');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecordString(
  record: PortableDataRecord,
  field: string,
  maximumLength: number,
): void {
  const value = record.data[field];
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) {
    throw new DataPackageError(`The ${record.type} ${field} is invalid.`);
  }
}

function validateUuid(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new DataPackageError(`The data package ${name} is invalid.`);
  }
}

function validateIsoTimestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new DataPackageError(`The data package ${name} is invalid.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new DataPackageError(`The data package ${name} is invalid.`);
  }
}

function validateSourceVersion(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64) {
    throw new DataPackageError('The data package source version is invalid.');
  }
}

function validateSchemaVersion(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new DataPackageError('The data package source schema version is invalid.');
  }
}

function validateDigest(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new DataPackageError(`The data package ${name} is invalid.`);
  }
}

function resolveLimits(limits: PortablePackageLimits): Required<PortablePackageLimits> {
  const resolved = {
    maxPackageBytes: limits.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES,
    maxRecordBytes: limits.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
    maxRecords: limits.maxRecords ?? DEFAULT_MAX_RECORDS,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`The data package ${name} limit is invalid.`);
    }
  }
  if (
    resolved.maxPackageBytes > DEFAULT_MAX_PACKAGE_BYTES ||
    resolved.maxRecordBytes > DEFAULT_MAX_RECORD_BYTES ||
    resolved.maxRecords > DEFAULT_MAX_RECORDS
  ) {
    throw new TypeError('Data package limits cannot exceed the application hard limits.');
  }
  return resolved;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
