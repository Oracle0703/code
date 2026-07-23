import type {
  BackupPolicy,
  BackupPolicyUpdateInput,
  BackupRunErrorCode,
} from '../../shared/contracts';
import { DatabaseIntegrityError, DatabaseStateError } from './errors';
import type { SqliteAdapter } from './sqlite-adapter';

interface BackupPolicyRow {
  enabled: unknown;
  cadence: unknown;
  local_time_minute: unknown;
  weekday: unknown;
  retention_count: unknown;
  revision: unknown;
  updated_at: unknown;
}

interface BackupRunStateRow {
  last_attempt_at: unknown;
  last_success_at: unknown;
  last_success_bucket: unknown;
  last_error_code: unknown;
  consecutive_failures: unknown;
  updated_at: unknown;
}

export interface StoredBackupRunState {
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastSuccessBucket: string | null;
  readonly lastErrorCode: BackupRunErrorCode | null;
  readonly consecutiveFailures: number;
  readonly updatedAt: string;
}

export interface BackupRunResult {
  readonly attemptedAt: string;
  readonly completedAt: string;
  readonly successfulBucket?: string;
  readonly errorCode?: BackupRunErrorCode;
}

export class BackupPolicyRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  initializeWithinTransaction(timestamp: string): void {
    if (!this.#database.isTransaction) {
      throw new DatabaseIntegrityError(
        'Backup policy initialization requires an active transaction.',
      );
    }
    assertIsoTimestamp(timestamp, 'backup policy initialization time');
    this.#database.run(
      `INSERT INTO backup_policy (
         singleton, enabled, cadence, local_time_minute, weekday,
         retention_count, revision, updated_at
       ) VALUES (1, 0, 'daily', 120, NULL, 14, 1, ?)
       ON CONFLICT(singleton) DO NOTHING`,
      [timestamp],
    );
    this.#database.run(
      `INSERT INTO backup_run_state (
         singleton, last_attempt_at, last_success_at, last_success_bucket,
         last_error_code, consecutive_failures, updated_at
       ) VALUES (1, NULL, NULL, NULL, NULL, 0, ?)
       ON CONFLICT(singleton) DO NOTHING`,
      [timestamp],
    );
    this.readPolicy();
    this.readRunState();
  }

  readPolicy(): BackupPolicy {
    const row = this.#database.get<BackupPolicyRow>(
      `SELECT enabled, cadence, local_time_minute, weekday,
              retention_count, revision, updated_at
       FROM backup_policy
       WHERE singleton = 1`,
    );
    if (!row) {
      throw new DatabaseIntegrityError('The backup policy is missing.');
    }
    return mapPolicy(row);
  }

  updatePolicy(input: BackupPolicyUpdateInput, timestamp: string): BackupPolicy {
    validatePolicyUpdate(input);
    assertIsoTimestamp(timestamp, 'backup policy update time');
    const result = this.#database.run(
      `UPDATE backup_policy
       SET enabled = ?, cadence = ?, local_time_minute = ?, weekday = ?,
           retention_count = ?, revision = revision + 1, updated_at = ?
       WHERE singleton = 1 AND revision = ?`,
      [
        input.enabled ? 1 : 0,
        input.cadence,
        input.localTimeMinute,
        input.weekday,
        input.retentionCount,
        timestamp,
        input.expectedRevision,
      ],
    );
    if (Number(result.changes) !== 1) {
      throw new DatabaseStateError('The backup policy changed before it could be updated.');
    }
    return this.readPolicy();
  }

  readRunState(): StoredBackupRunState {
    const row = this.#database.get<BackupRunStateRow>(
      `SELECT last_attempt_at, last_success_at, last_success_bucket,
              last_error_code, consecutive_failures, updated_at
       FROM backup_run_state
       WHERE singleton = 1`,
    );
    if (!row) {
      throw new DatabaseIntegrityError('The backup run state is missing.');
    }
    return mapRunState(row);
  }

  recordAttempt(timestamp: string): StoredBackupRunState {
    assertIsoTimestamp(timestamp, 'backup attempt time');
    const result = this.#database.run(
      `UPDATE backup_run_state
       SET last_attempt_at = ?, updated_at = ?
       WHERE singleton = 1`,
      [timestamp, timestamp],
    );
    assertChanged(result.changes, 'recorded');
    return this.readRunState();
  }

  recordResult(result: BackupRunResult): StoredBackupRunState {
    validateRunResult(result);
    const successfulAt = result.successfulBucket ? result.completedAt : null;
    const successfulBucket = result.successfulBucket ?? null;
    const errorCode = result.errorCode ?? null;
    const update = this.#database.run(
      `UPDATE backup_run_state
       SET last_attempt_at = ?,
           last_success_at = COALESCE(?, last_success_at),
           last_success_bucket = COALESCE(?, last_success_bucket),
           last_error_code = ?,
           consecutive_failures = CASE WHEN ? IS NULL THEN 0 ELSE consecutive_failures + 1 END,
           updated_at = ?
       WHERE singleton = 1`,
      [
        result.attemptedAt,
        successfulAt,
        successfulBucket,
        errorCode,
        errorCode,
        result.completedAt,
      ],
    );
    assertChanged(update.changes, 'completed');
    return this.readRunState();
  }
}

function mapPolicy(row: BackupPolicyRow): BackupPolicy {
  const enabled = readSqlBoolean(row.enabled, 'backup enabled state');
  const cadence = row.cadence;
  const localTimeMinute = readInteger(row.local_time_minute, 'backup local time', 0, 1_439);
  const retentionCount = readInteger(row.retention_count, 'backup retention count', 1, 90);
  const revision = readInteger(row.revision, 'backup policy revision', 1, Number.MAX_SAFE_INTEGER);
  const weekday = row.weekday === null ? null : readInteger(row.weekday, 'backup weekday', 0, 6);
  if (
    (cadence !== 'daily' && cadence !== 'weekly') ||
    (cadence === 'daily' && weekday !== null) ||
    (cadence === 'weekly' && weekday === null)
  ) {
    throw new DatabaseIntegrityError('The backup policy cadence is invalid.');
  }
  const updatedAt = readIsoTimestamp(row.updated_at, 'backup policy update time');
  return {
    enabled,
    cadence,
    localTimeMinute,
    weekday,
    retentionCount,
    revision,
    updatedAt,
  };
}

function mapRunState(row: BackupRunStateRow): StoredBackupRunState {
  const lastAttemptAt = readNullableTimestamp(row.last_attempt_at, 'last backup attempt time');
  const lastSuccessAt = readNullableTimestamp(row.last_success_at, 'last backup success time');
  const lastSuccessBucket = readNullableBucket(row.last_success_bucket);
  const lastErrorCode = readNullableErrorCode(row.last_error_code);
  const consecutiveFailures = readInteger(
    row.consecutive_failures,
    'backup failure count',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const updatedAt = readIsoTimestamp(row.updated_at, 'backup run-state update time');
  if (
    (lastSuccessAt === null) !== (lastSuccessBucket === null) ||
    (lastErrorCode === null) !== (consecutiveFailures === 0)
  ) {
    throw new DatabaseIntegrityError('The backup run state is inconsistent.');
  }
  return {
    lastAttemptAt,
    lastSuccessAt,
    lastSuccessBucket,
    lastErrorCode,
    consecutiveFailures,
    updatedAt,
  };
}

function validatePolicyUpdate(input: BackupPolicyUpdateInput): void {
  if (
    typeof input.enabled !== 'boolean' ||
    (input.cadence !== 'daily' && input.cadence !== 'weekly') ||
    !Number.isSafeInteger(input.localTimeMinute) ||
    input.localTimeMinute < 0 ||
    input.localTimeMinute > 1_439 ||
    !Number.isSafeInteger(input.retentionCount) ||
    input.retentionCount < 1 ||
    input.retentionCount > 90 ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (input.cadence === 'daily' && input.weekday !== null) ||
    (input.cadence === 'weekly' &&
      (!Number.isSafeInteger(input.weekday) ||
        (input.weekday as number) < 0 ||
        (input.weekday as number) > 6))
  ) {
    throw new TypeError('The backup policy update is invalid.');
  }
}

function validateRunResult(result: BackupRunResult): void {
  assertIsoTimestamp(result.attemptedAt, 'backup attempt time');
  assertIsoTimestamp(result.completedAt, 'backup completion time');
  if (result.completedAt < result.attemptedAt) {
    throw new TypeError('The backup completion time precedes its attempt time.');
  }
  const reportsSuccess = result.successfulBucket !== undefined;
  const reportsFailure = result.errorCode !== undefined;
  if (reportsSuccess === reportsFailure) {
    throw new TypeError('A backup result must report exactly one of success or failure.');
  }
  if (reportsSuccess) {
    readNullableBucket(result.successfulBucket);
  }
  if (reportsFailure) {
    readNullableErrorCode(result.errorCode);
  }
}

function assertChanged(value: unknown, operation: string): void {
  if (typeof value !== 'number' || Number(value) !== 1) {
    throw new DatabaseIntegrityError(`The backup run could not be ${operation}.`);
  }
}

function readSqlBoolean(value: unknown, name: string): boolean {
  if (value !== 0 && value !== 1) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  return value === 1;
}

function readInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  return value as number;
}

function readIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`);
  }
  try {
    assertIsoTimestamp(value, name);
  } catch (error) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${name}.`, { cause: error });
  }
  return value;
}

function readNullableTimestamp(value: unknown, name: string): string | null {
  return value === null ? null : readIsoTimestamp(value, name);
}

function readNullableBucket(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^(?:daily|weekly):\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !isCivilDate(value.slice(value.indexOf(':') + 1))
  ) {
    throw new DatabaseIntegrityError('SQLite returned an invalid backup bucket.');
  }
  return value;
}

function readNullableErrorCode(value: unknown): BackupRunErrorCode | null {
  if (value === null) return null;
  if (
    value !== 'backup-failed' &&
    value !== 'retention-failed' &&
    value !== 'database-unavailable'
  ) {
    throw new DatabaseIntegrityError('SQLite returned an invalid backup error code.');
  }
  return value;
}

function isCivilDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

function assertIsoTimestamp(value: string, name: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError(`The ${name} is invalid.`);
  }
}
