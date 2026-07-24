import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, parse, resolve } from 'node:path';
import { focusRemainingAt } from '../../shared/focus-domain';
import type {
  BackupPolicy,
  DatabaseBackupInfo,
  DatabaseBackupRestoreInput,
} from '../../shared/contracts';
import { AutomationRepository } from '../automations/automation-repository';
import { FocusRepository } from '../focus/focus-repository';
import type { BackupManager } from './backup-manager';
import { BackupPolicyRepository, type StoredBackupRunState } from './backup-policy-repository';
import { DatabaseIntegrityError } from './errors';
import { MigrationRunner } from './migration-runner';
import type { SqliteAdapter, SqliteAdapterFactory } from './sqlite-adapter';
import type { Migration, MigrationResult, PreparedBackupRestore } from './types';

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export interface BackupRestoreLocalState {
  readonly policy: BackupPolicy;
  readonly runState: StoredBackupRunState;
}

export interface BackupRestoreDurability {
  readonly syncFile: (path: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
}

export interface BackupRestoreStagerOptions {
  readonly dataDirectory: string;
  readonly migrations: readonly Migration[];
  readonly adapterFactory: SqliteAdapterFactory;
  readonly validateSnapshot: (database: SqliteAdapter, schemaVersion: number) => void;
  readonly validateContentIntegrity: (database: SqliteAdapter) => void;
  readonly initializeCopiedDatabase: (dataDirectory: string) => Promise<MigrationResult>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly durability?: BackupRestoreDurability;
}

interface StageOptions {
  readonly input: DatabaseBackupRestoreInput;
  readonly restoreId: string;
  readonly localState: BackupRestoreLocalState;
  readonly backups: BackupManager;
  readonly replaceExisting: boolean;
  readonly expectedSourceDigest?: string;
  readonly previous?: PreparedBackupRestore;
}

export class BackupRestoreStager {
  readonly #directory: string;
  readonly #migrationRunner: MigrationRunner;
  readonly #adapterFactory: SqliteAdapterFactory;
  readonly #validateSnapshot: (database: SqliteAdapter, schemaVersion: number) => void;
  readonly #validateContentIntegrity: (database: SqliteAdapter) => void;
  readonly #initializeCopiedDatabase: (dataDirectory: string) => Promise<MigrationResult>;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #durability: BackupRestoreDurability;

  constructor({
    dataDirectory,
    migrations,
    adapterFactory,
    validateSnapshot,
    validateContentIntegrity,
    initializeCopiedDatabase,
    now = () => new Date(),
    idFactory = randomUUID,
    durability = DEFAULT_RESTORE_DURABILITY,
  }: BackupRestoreStagerOptions) {
    const resolvedDataDirectory = resolve(dataDirectory);
    if (resolvedDataDirectory === parse(resolvedDataDirectory).root) {
      throw new TypeError('The database restore data directory cannot be a filesystem root.');
    }
    this.#directory = resolve(resolvedDataDirectory, 'imports');
    if (dirname(this.#directory) !== resolvedDataDirectory) {
      throw new TypeError('The database restore directory escaped its data directory.');
    }
    this.#migrationRunner = new MigrationRunner(migrations);
    this.#adapterFactory = adapterFactory;
    this.#validateSnapshot = validateSnapshot;
    this.#validateContentIntegrity = validateContentIntegrity;
    this.#initializeCopiedDatabase = initializeCopiedDatabase;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#durability = durability;
  }

  prepare(
    input: DatabaseBackupRestoreInput,
    restoreId: string,
    localState: BackupRestoreLocalState,
    backups: BackupManager,
  ): Promise<PreparedBackupRestore> {
    const normalizedRestoreId = normalizeUuid(restoreId, 'backup restore id');
    return this.#stage({
      input,
      restoreId: normalizedRestoreId,
      localState,
      backups,
      replaceExisting: false,
    });
  }

  async refresh(
    prepared: PreparedBackupRestore,
    localState: BackupRestoreLocalState,
    backups: BackupManager,
  ): Promise<PreparedBackupRestore> {
    this.#validatePrepared(prepared);
    await this.#prepareDirectory();
    await this.#assertPreparedDestination(prepared);
    return this.#stage({
      input: toRestoreInput(prepared.backup),
      restoreId: prepared.restoreId,
      localState,
      backups,
      replaceExisting: true,
      expectedSourceDigest: prepared.sourceDigest,
      previous: prepared,
    });
  }

  async discard(prepared: PreparedBackupRestore): Promise<void> {
    this.#validatePrepared(prepared);
    const directory = await inspectOptionalDirectory(this.#directory);
    if (!directory) return;
    const destination = this.#resolveStagingPath(prepared.restoreId);
    const entry = await lstat(destination).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!entry) {
      await assertNoSqliteSidecars(destination);
      return;
    }
    await this.#assertPreparedDestination(prepared);
    await rm(destination);
    await this.#durability.syncDirectory(this.#directory);
  }

  async #stage(options: StageOptions): Promise<PreparedBackupRestore> {
    await this.#prepareDirectory();
    const destination = this.#resolveStagingPath(options.restoreId);
    if (options.replaceExisting) {
      if (!options.previous) {
        throw new TypeError('The existing database restore staging reference is missing.');
      }
      await this.#assertPreparedDestination(options.previous);
    } else {
      await assertMissing(destination);
      await assertNoSqliteSidecars(destination);
    }

    const writeId = normalizeUuid(this.#idFactory(), 'backup restore staging write id');
    const workingDirectory = this.#resolveWorkingDirectory(options.restoreId, writeId);
    const workingPath = resolve(workingDirectory, 'daily-workbench.sqlite3');
    const temporaryPath = this.#resolveTemporaryPath(options.restoreId, writeId);
    await assertMissing(workingDirectory);
    await assertMissing(temporaryPath);
    await assertNoSqliteSidecars(temporaryPath);
    let installed = false;
    try {
      await mkdir(workingDirectory, { mode: 0o700 });
      await assertPrivateDirectory(workingDirectory);
      const copied = await options.backups.copyRestoreReference(options.input, workingPath);
      const copiedDigest = await hashRegularFile(workingPath);
      if (!equalDigest(copiedDigest, copied.sourceDigest)) {
        throw new DatabaseIntegrityError(
          'The database backup restore copy does not match its source.',
        );
      }
      if (
        options.expectedSourceDigest !== undefined &&
        !equalDigest(copied.sourceDigest, options.expectedSourceDigest)
      ) {
        throw new DatabaseIntegrityError(
          'The database backup restore source changed after it was prepared.',
        );
      }

      const now = this.#readNow();
      const migration = await this.#initializeCopiedDatabase(workingDirectory);
      if (
        migration.fromVersion !== copied.backup.schemaVersion ||
        migration.toVersion !== this.#migrationRunner.latestVersion
      ) {
        throw new DatabaseIntegrityError(
          'The database backup restore schema changed before staging.',
        );
      }
      await assertNoSqliteSidecars(workingPath);
      await this.#normalizeCurrentDatabase(workingPath, options.localState, now);
      await chmod(workingPath, 0o600);
      const workingDigest = await this.#validateAndDigest(workingPath, options.localState);
      await this.#durability.syncFile(workingPath);
      await this.#durability.syncDirectory(workingDirectory);
      await rename(workingPath, temporaryPath);
      await Promise.all([
        this.#durability.syncDirectory(workingDirectory),
        this.#durability.syncDirectory(this.#directory),
      ]);
      await rm(workingDirectory, { recursive: true });
      await this.#durability.syncDirectory(this.#directory);

      await chmod(temporaryPath, 0o600);
      const stagingDigest = await this.#validateAndDigest(temporaryPath, options.localState);
      if (!equalDigest(stagingDigest, workingDigest)) {
        throw new DatabaseIntegrityError(
          'The database restore staging file changed while its work directory was removed.',
        );
      }
      await this.#durability.syncFile(temporaryPath);

      if (options.replaceExisting) {
        await this.#assertPreparedDestination(options.previous as PreparedBackupRestore);
      } else {
        await assertMissing(destination);
        await assertNoSqliteSidecars(destination);
      }
      await rename(temporaryPath, destination);
      installed = true;
      await this.#durability.syncDirectory(this.#directory);
      const publishedDigest = await this.#validateAndDigest(destination, options.localState);
      if (!equalDigest(publishedDigest, stagingDigest)) {
        throw new DatabaseIntegrityError(
          'The database restore staging file changed while it was published.',
        );
      }
      await this.#durability.syncFile(destination);
      await this.#durability.syncDirectory(this.#directory);

      return {
        restoreId: options.restoreId,
        backup: copied.backup,
        sourceDigest: copied.sourceDigest,
        stagingFileName: basename(destination),
        stagingDigest: publishedDigest,
      };
    } catch (error) {
      const cleanup = [
        rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined),
        rm(temporaryPath, { force: true }).catch(() => undefined),
        removeSqliteSidecars(temporaryPath),
        installed ? rm(destination, { force: true }).catch(() => undefined) : undefined,
        installed ? removeSqliteSidecars(destination) : undefined,
      ];
      await Promise.all(cleanup);
      await this.#durability.syncDirectory(this.#directory).catch(() => undefined);
      throw error;
    }
  }

  async #normalizeCurrentDatabase(
    path: string,
    localState: BackupRestoreLocalState,
    now: Date,
  ): Promise<void> {
    const database = this.#adapterFactory(path, { timeoutMs: 5_000 });
    try {
      try {
        database.open();
        configureRestorePragmas(database);
        database.exec('BEGIN IMMEDIATE');
        try {
          replaceLocalBackupState(database, localState);
          normalizeAutomations(database, now);
          normalizeFocus(database, now);
          normalizeWorkspaceRuntimePreferences(database, now);
          database.exec('COMMIT');
        } catch (error) {
          try {
            if (database.isTransaction) database.exec('ROLLBACK');
          } catch {
            // Keep the normalization failure as the primary error.
          }
          throw error;
        }

        this.#validateContentIntegrity(database);
        database.exec('PRAGMA query_only = ON');
        this.#validateSnapshot(database, this.#migrationRunner.latestVersion);
        assertLocalBackupState(database, localState);
        assertSafeRuntimeState(database);
      } finally {
        database.close();
      }
      await assertNoSqliteSidecars(path);
    } finally {
      await removeSqliteSidecars(path);
    }
  }

  async #validateAndDigest(path: string, localState: BackupRestoreLocalState): Promise<string> {
    await assertNoSqliteSidecars(path);
    const before = await hashRegularFile(path);
    const database = this.#adapterFactory(path, { timeoutMs: 5_000 });
    try {
      try {
        database.open();
        configureRestorePragmas(database);
        this.#validateContentIntegrity(database);
        database.exec('PRAGMA query_only = ON');
        this.#validateSnapshot(database, this.#migrationRunner.latestVersion);
        assertLocalBackupState(database, localState);
        assertSafeRuntimeState(database);
      } finally {
        database.close();
      }
      await assertNoSqliteSidecars(path);
      const after = await hashRegularFile(path);
      if (!equalDigest(before, after)) {
        throw new DatabaseIntegrityError(
          'The database restore staging file changed while it was validated.',
        );
      }
      return after;
    } finally {
      await removeSqliteSidecars(path);
    }
  }

  async #assertPreparedDestination(prepared: PreparedBackupRestore): Promise<void> {
    const destination = this.#resolveStagingPath(prepared.restoreId);
    if (basename(destination) !== prepared.stagingFileName) {
      throw new TypeError('The database restore staging filename is invalid.');
    }
    await assertNoSqliteSidecars(destination);
    const digest = await hashRegularFile(destination);
    if (!equalDigest(digest, prepared.stagingDigest)) {
      throw new DatabaseIntegrityError(
        'The database restore staging file changed after it was prepared.',
      );
    }
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(this.#directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new DatabaseIntegrityError('The database restore directory is not a real directory.');
    }
    if (process.platform !== 'win32') await chmod(this.#directory, 0o700);
  }

  #resolveStagingPath(restoreId: string): string {
    return this.#resolveFile(`import-${normalizeUuid(restoreId, 'backup restore id')}.sqlite3`);
  }

  #resolveTemporaryPath(restoreId: string, writeId: string): string {
    return this.#resolveFile(
      `.import-${normalizeUuid(restoreId, 'backup restore id')}.sqlite3.${normalizeUuid(
        writeId,
        'backup restore staging write id',
      )}.partial`,
    );
  }

  #resolveWorkingDirectory(restoreId: string, writeId: string): string {
    return this.#resolveFile(
      `.backup-restore-${normalizeUuid(restoreId, 'backup restore id')}-${normalizeUuid(
        writeId,
        'backup restore staging write id',
      )}`,
    );
  }

  #resolveFile(fileName: string): string {
    if (basename(fileName) !== fileName) {
      throw new TypeError('The database restore staging filename is invalid.');
    }
    const path = resolve(this.#directory, fileName);
    if (dirname(path) !== this.#directory) {
      throw new TypeError('The database restore staging path escaped its directory.');
    }
    return path;
  }

  #validatePrepared(prepared: PreparedBackupRestore): void {
    if (
      !prepared ||
      typeof prepared !== 'object' ||
      normalizeUuid(prepared.restoreId, 'backup restore id') !== prepared.restoreId ||
      prepared.stagingFileName !== `import-${prepared.restoreId}.sqlite3` ||
      !isDigest(prepared.sourceDigest) ||
      !isDigest(prepared.stagingDigest) ||
      !isDatabaseBackupInfo(prepared.backup)
    ) {
      throw new TypeError('The prepared database backup restore is invalid.');
    }
  }

  #readNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('The database restore clock returned an invalid date.');
    }
    return now;
  }
}

function replaceLocalBackupState(
  database: SqliteAdapter,
  localState: BackupRestoreLocalState,
): void {
  database.run('DELETE FROM backup_policy');
  database.run(
    `INSERT INTO backup_policy (
       singleton, enabled, cadence, local_time_minute, weekday,
       retention_count, revision, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      localState.policy.enabled ? 1 : 0,
      localState.policy.cadence,
      localState.policy.localTimeMinute,
      localState.policy.weekday,
      localState.policy.retentionCount,
      localState.policy.revision,
      localState.policy.updatedAt,
    ],
  );
  database.run('DELETE FROM backup_run_state');
  database.run(
    `INSERT INTO backup_run_state (
       singleton, last_attempt_at, last_success_at, last_success_bucket,
       last_error_code, consecutive_failures, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?)`,
    [
      localState.runState.lastAttemptAt,
      localState.runState.lastSuccessAt,
      localState.runState.lastSuccessBucket,
      localState.runState.lastErrorCode,
      localState.runState.consecutiveFailures,
      localState.runState.updatedAt,
    ],
  );
}

function normalizeAutomations(database: SqliteAdapter, now: Date): void {
  const repository = new AutomationRepository(database);
  for (const automation of repository.readEnabled()) {
    const timestamp = timestampAtLeast(now, automation.createdAt, automation.updatedAt);
    if (
      !repository.setEnabled(
        automation.workspaceId,
        automation.id,
        automation.revision,
        false,
        timestamp,
      )
    ) {
      throw new DatabaseIntegrityError(
        'An enabled automation could not be paused for database restore.',
      );
    }
  }
}

function normalizeFocus(database: SqliteAdapter, now: Date): void {
  const repository = new FocusRepository(database);
  const session = repository.findOpen();
  if (!session || session.status === 'paused') return;
  if (!session.deadlineAt) {
    throw new DatabaseIntegrityError('A running focus session is missing its deadline.');
  }
  const remaining = focusRemainingAt(session.remainingSeconds, session.deadlineAt, now);
  const timestamp = timestampAtLeast(now, session.createdAt, session.updatedAt);
  const changed =
    remaining === 0
      ? repository.complete(session.workspaceId, session.id, session.revision, timestamp)
      : repository.pause(session.workspaceId, session.id, session.revision, remaining, timestamp);
  if (!changed) {
    throw new DatabaseIntegrityError(
      'The running focus session could not be normalized for database restore.',
    );
  }
}

function normalizeWorkspaceRuntimePreferences(database: SqliteAdapter, now: Date): void {
  const timestamp = now.toISOString();
  database.run(
    `UPDATE workspace_preferences
     SET browser_open = 0,
         terminal_open = 0,
         updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
     WHERE browser_open = 1 OR terminal_open = 1`,
    [timestamp, timestamp],
  );
}

function assertLocalBackupState(database: SqliteAdapter, expected: BackupRestoreLocalState): void {
  const repository = new BackupPolicyRepository(database);
  const policy = repository.readPolicy();
  const runState = repository.readRunState();
  if (!samePolicy(policy, expected.policy) || !sameRunState(runState, expected.runState)) {
    throw new DatabaseIntegrityError(
      'The database restore staging file did not preserve the local backup state.',
    );
  }
}

function assertSafeRuntimeState(database: SqliteAdapter): void {
  const enabledAutomations = readCount(
    database,
    'SELECT COUNT(*) AS count FROM automations WHERE enabled = 1',
  );
  const runningFocus = readCount(
    database,
    "SELECT COUNT(*) AS count FROM focus_sessions WHERE state = 'running'",
  );
  const openPanels = readCount(
    database,
    `SELECT COUNT(*) AS count
     FROM workspace_preferences
     WHERE browser_open = 1 OR terminal_open = 1`,
  );
  if (enabledAutomations !== 0 || runningFocus !== 0 || openPanels !== 0) {
    throw new DatabaseIntegrityError(
      'The database restore staging file retained unsafe runtime state.',
    );
  }
}

function readCount(database: SqliteAdapter, sql: string): number {
  const value = database.get<{ count: unknown }>(sql)?.count;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new DatabaseIntegrityError('SQLite returned an invalid restore validation count.');
  }
  return value as number;
}

function configureRestorePragmas(database: SqliteAdapter): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
  `);
  const journalMode = database.get<Record<string, unknown>>('PRAGMA journal_mode')?.journal_mode;
  if (journalMode !== 'delete') {
    throw new DatabaseIntegrityError(
      'The database restore staging journal mode could not be isolated.',
    );
  }
}

function timestampAtLeast(now: Date, ...timestamps: readonly string[]): string {
  return [now.toISOString(), ...timestamps].sort().at(-1) as string;
}

function samePolicy(left: BackupPolicy, right: BackupPolicy): boolean {
  return (
    left.enabled === right.enabled &&
    left.cadence === right.cadence &&
    left.localTimeMinute === right.localTimeMinute &&
    left.weekday === right.weekday &&
    left.retentionCount === right.retentionCount &&
    left.revision === right.revision &&
    left.updatedAt === right.updatedAt
  );
}

function sameRunState(left: StoredBackupRunState, right: StoredBackupRunState): boolean {
  return (
    left.lastAttemptAt === right.lastAttemptAt &&
    left.lastSuccessAt === right.lastSuccessAt &&
    left.lastSuccessBucket === right.lastSuccessBucket &&
    left.lastErrorCode === right.lastErrorCode &&
    left.consecutiveFailures === right.consecutiveFailures &&
    left.updatedAt === right.updatedAt
  );
}

function toRestoreInput(backup: DatabaseBackupInfo): DatabaseBackupRestoreInput {
  return {
    backupId: backup.id,
    expectedReason: backup.reason,
    expectedCreatedAt: backup.createdAt,
    expectedSizeBytes: backup.sizeBytes,
    expectedSchemaVersion: backup.schemaVersion,
  };
}

function isDatabaseBackupInfo(value: DatabaseBackupInfo): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    normalizeUuid(value.id, 'database backup id') === value.id &&
    basename(value.fileName) === value.fileName &&
    /^daily-workbench-v\d+-(?:manual|scheduled|pre-migration|pre-import)-[0-9]{8}T[0-9]{9}Z-[0-9a-f-]{36}\.sqlite3$/u.test(
      value.fileName,
    ) &&
    (value.reason === 'manual' ||
      value.reason === 'scheduled' ||
      value.reason === 'pre-migration' ||
      value.reason === 'pre-import') &&
    isIsoTimestamp(value.createdAt) &&
    Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 0 &&
    Number.isSafeInteger(value.schemaVersion) &&
    value.schemaVersion >= 0
  );
}

function normalizeUuid(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new TypeError(`The ${name} is invalid.`);
  }
  return value.toLowerCase();
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function equalDigest(left: string, right: string): boolean {
  if (!isDigest(left) || !isDigest(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

async function inspectOptionalDirectory(path: string): Promise<Stats | undefined> {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new DatabaseIntegrityError('The database restore directory is not a real directory.');
  }
  return entry;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new DatabaseIntegrityError(
      'The isolated database restore directory is not a real directory.',
    );
  }
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

async function assertMissing(path: string): Promise<void> {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (entry) {
    throw new DatabaseIntegrityError('A database restore staging artifact already exists.');
  }
}

async function assertNoSqliteSidecars(databasePath: string): Promise<void> {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    await assertMissing(`${databasePath}${suffix}`);
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all(
    SQLITE_SIDECAR_SUFFIXES.map((suffix) =>
      rm(`${databasePath}${suffix}`, { force: true }).catch(() => undefined),
    ),
  );
}

async function hashRegularFile(path: string): Promise<string> {
  const pathBefore = await lstat(path, { bigint: true });
  assertRegularFile(pathBefore);
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    assertRegularFile(before);
    if (!sameStableStat(pathBefore, before)) {
      throw new DatabaseIntegrityError(
        'A database restore staging artifact changed before it was opened.',
      );
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)) {
      throw new DatabaseIntegrityError('A database restore staging artifact is too large.');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size));
    let position = 0;
    while (position < size) {
      const length = Math.min(buffer.byteLength, size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead < 1) {
        throw new DatabaseIntegrityError(
          'A database restore staging artifact was truncated while it was checked.',
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if ((await handle.read(growthProbe, 0, 1, size)).bytesRead !== 0) {
      throw new DatabaseIntegrityError(
        'A database restore staging artifact grew while it was checked.',
      );
    }
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    assertRegularFile(after);
    assertRegularFile(pathAfter);
    if (!sameStableStat(before, after) || !sameStableStat(after, pathAfter)) {
      throw new DatabaseIntegrityError(
        'A database restore staging artifact changed while it was checked.',
      );
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertRegularFile(entry: BigIntStats): void {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1n) {
    throw new DatabaseIntegrityError('A database restore staging artifact is not a regular file.');
  }
}

function sameStableStat(left: BigIntStats, right: BigIntStats): boolean {
  const sameIdentity =
    left.dev !== 0n && left.ino !== 0n && right.dev !== 0n && right.ino !== 0n
      ? left.dev === right.dev && left.ino === right.ino
      : left.birthtimeNs !== 0n &&
        right.birthtimeNs !== 0n &&
        left.birthtimeNs === right.birthtimeNs;
  return (
    sameIdentity &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function syncRegularFile(path: string): Promise<void> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1) {
    throw new DatabaseIntegrityError(
      'The database restore durability target is not a regular file.',
    );
  }
  const flags = constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!sameStableFile(before, opened)) {
      throw new DatabaseIntegrityError(
        'The database restore staging file changed before it could be made durable.',
      );
    }
    await handle.sync();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameStableFile(opened, afterHandle) || !sameStableFile(opened, afterPath)) {
      throw new DatabaseIntegrityError(
        'The database restore staging file changed while it was made durable.',
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameStableFile(left: Stats, right: Stats): boolean {
  const sameIdentity =
    left.dev !== 0 && left.ino !== 0 && right.dev !== 0 && right.ino !== 0
      ? left.dev === right.dev && left.ino === right.ino
      : left.birthtimeMs !== 0 && right.birthtimeMs !== 0 && left.birthtimeMs === right.birthtimeMs;
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    sameIdentity &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const DEFAULT_RESTORE_DURABILITY: BackupRestoreDurability = {
  syncFile: syncRegularFile,
  syncDirectory,
};
