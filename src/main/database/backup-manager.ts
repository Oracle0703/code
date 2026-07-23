import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { DatabaseBackupInfo } from '../../shared/contracts';
import { DatabaseBackupError } from './errors';
import type { SqliteAdapter, SqliteAdapterFactory } from './sqlite-adapter';
import type { BackupReason, BackupResult, BackupRetentionResult, DatabasePaths } from './types';

const BACKUP_FILE_PATTERN =
  /^daily-workbench-v(\d+)-(manual|scheduled|pre-migration|pre-import)-([0-9]{8}T[0-9]{9}Z)-([0-9a-fA-F-]{36})\.sqlite3$/u;
const DEFAULT_LIST_LIMIT = 100;
const BACKUP_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

type BackupSidecarSuffix = (typeof BACKUP_SIDECAR_SUFFIXES)[number];
type BackupArtifactSuffix = '' | BackupSidecarSuffix;

interface ObservedBackupSidecar {
  readonly suffix: BackupSidecarSuffix;
  readonly stats: Stats;
}

export interface BackupDurabilityOperations {
  readonly syncFile: (path: string) => Promise<void>;
  readonly syncDirectory: (path: string) => Promise<void>;
}

export interface BackupManagerOptions {
  readonly paths: DatabasePaths;
  readonly adapterFactory: SqliteAdapterFactory;
  readonly validateSnapshot: (database: SqliteAdapter, schemaVersion: number) => void;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly durability?: BackupDurabilityOperations;
}

export class BackupManager {
  readonly #paths: DatabasePaths;
  readonly #adapterFactory: SqliteAdapterFactory;
  readonly #validateSnapshot: (database: SqliteAdapter, schemaVersion: number) => void;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #durability: BackupDurabilityOperations;

  constructor({
    paths,
    adapterFactory,
    validateSnapshot,
    now = () => new Date(),
    idFactory = randomUUID,
    durability = DEFAULT_BACKUP_DURABILITY,
  }: BackupManagerOptions) {
    this.#paths = paths;
    this.#adapterFactory = adapterFactory;
    this.#validateSnapshot = validateSnapshot;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#durability = durability;
  }

  async create(
    source: SqliteAdapter,
    reason: BackupReason,
    schemaVersion: number,
  ): Promise<BackupResult> {
    let temporaryPath: string | undefined;

    try {
      await this.#assertBackupDirectory();
      const createdAt = this.#now().toISOString();
      const generatedId = this.#idFactory();
      if (!isUuid(generatedId) || !Number.isSafeInteger(schemaVersion) || schemaVersion < 0) {
        throw new DatabaseBackupError('A safe database backup identifier could not be generated.');
      }
      const id = generatedId.toLowerCase();
      const timestamp = formatTimestampForFile(createdAt);
      const fileName = `daily-workbench-v${schemaVersion}-${reason}-${timestamp}-${id}.sqlite3`;
      const destinationPath = this.#resolveBackupPath(fileName);
      const generatedTemporaryId = this.#idFactory();
      if (!isUuid(generatedTemporaryId)) {
        throw new DatabaseBackupError('A safe temporary backup identifier could not be generated.');
      }
      const temporaryId = generatedTemporaryId.toLowerCase();
      const temporaryName = `.${fileName}.${temporaryId}.partial`;
      temporaryPath = this.#resolveBackupPath(temporaryName);

      await assertMissing(temporaryPath);
      await assertMissing(destinationPath);
      const pages = await source.backupTo(temporaryPath);
      await chmod(temporaryPath, 0o600);
      await this.#validate(temporaryPath, schemaVersion);
      const entry = await lstat(temporaryPath);
      if (!isSafeRegularFile(entry)) {
        throw new DatabaseBackupError('The completed database backup is not a regular file.');
      }
      await this.#durability.syncFile(temporaryPath);
      const durableEntry = await lstat(temporaryPath);
      if (!sameStableFile(entry, durableEntry)) {
        throw new DatabaseBackupError(
          'The completed database backup changed while it was made durable.',
        );
      }
      await rename(temporaryPath, destinationPath);
      temporaryPath = undefined;

      let publishedEntry: Stats;
      try {
        await this.#validate(destinationPath, schemaVersion);
        publishedEntry = await lstat(destinationPath);
        if (
          !isSafeRegularFile(publishedEntry) ||
          !samePublishedFile(durableEntry, publishedEntry)
        ) {
          throw new DatabaseBackupError(
            'The published database backup changed before it could be verified.',
          );
        }
      } catch (error) {
        try {
          await this.#removeBackupArtifacts(destinationPath, true);
        } catch (cleanupError) {
          throw new DatabaseBackupError(
            'An invalid published database backup could not be cleaned up safely.',
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
        throw error;
      }
      await this.#durability.syncDirectory(this.#paths.backupDirectory);

      return {
        id,
        fileName,
        path: destinationPath,
        reason,
        createdAt,
        sizeBytes: publishedEntry.size,
        schemaVersion,
        pages,
      };
    } catch (error) {
      let cleanupFailure: { readonly error: unknown } | undefined;
      if (temporaryPath) {
        try {
          await this.#removeBackupArtifacts(temporaryPath, true);
        } catch (cleanupError) {
          cleanupFailure = { error: cleanupError };
        }
      }
      if (cleanupFailure) {
        throw new DatabaseBackupError(
          'An invalid temporary database backup could not be cleaned up safely.',
          { cause: new AggregateError([error, cleanupFailure.error]) },
        );
      }
      if (error instanceof DatabaseBackupError) {
        throw error;
      }
      throw new DatabaseBackupError('The database backup could not be created.', { cause: error });
    }
  }

  async list(limit = DEFAULT_LIST_LIMIT): Promise<DatabaseBackupInfo[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_LIST_LIMIT) {
      throw new DatabaseBackupError('The database backup list limit is invalid.');
    }

    try {
      return (await this.#scan())
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
    } catch (error) {
      if (error instanceof DatabaseBackupError) {
        throw error;
      }
      throw new DatabaseBackupError('Database backups could not be listed.', { cause: error });
    }
  }

  async count(): Promise<number> {
    try {
      return (await this.#scan()).length;
    } catch (error) {
      throw new DatabaseBackupError('Database backups could not be counted.', { cause: error });
    }
  }

  async validateReference(
    backupId: string,
    expectedReason: BackupReason,
  ): Promise<DatabaseBackupInfo> {
    if (!isUuid(backupId) || !isBackupReason(expectedReason)) {
      throw new DatabaseBackupError('The database backup reference is invalid.');
    }

    try {
      await this.#assertBackupDirectory();
      const normalizedId = backupId.toLowerCase();
      const entries = await readdir(this.#paths.backupDirectory, { withFileTypes: true });
      const candidates: Array<{
        entry: (typeof entries)[number];
        parsed: NonNullable<ReturnType<typeof parseBackupFileName>>;
      }> = [];
      for (const entry of entries) {
        const parsed = parseBackupFileName(entry.name);
        if (parsed?.id === normalizedId) candidates.push({ entry, parsed });
      }
      if (candidates.length !== 1) {
        throw new DatabaseBackupError('The referenced database backup is missing or ambiguous.');
      }

      const [{ entry, parsed }] = candidates;
      if (parsed.reason !== expectedReason || !entry.isFile() || entry.isSymbolicLink()) {
        throw new DatabaseBackupError('The referenced database backup metadata does not match.');
      }
      const path = this.#resolveBackupPath(entry.name);
      const before = await lstat(path);
      if (!isSafeRegularFile(before)) {
        throw new DatabaseBackupError('The referenced database backup is not a regular file.');
      }
      await this.#validate(path, parsed.schemaVersion);
      const after = await lstat(path);
      if (!sameStableFile(before, after)) {
        throw new DatabaseBackupError(
          'The referenced database backup changed while it was validated.',
        );
      }
      return {
        ...parsed,
        fileName: entry.name,
        sizeBytes: after.size,
      };
    } catch (error) {
      if (error instanceof DatabaseBackupError) throw error;
      throw new DatabaseBackupError('The referenced database backup could not be validated.', {
        cause: error,
      });
    }
  }

  async pruneScheduled(
    retentionCount: number,
    protectedBackupId?: string,
  ): Promise<BackupRetentionResult> {
    if (!Number.isSafeInteger(retentionCount) || retentionCount < 1 || retentionCount > 90) {
      throw new DatabaseBackupError('The scheduled backup retention count is invalid.');
    }
    if (protectedBackupId !== undefined && !isUuid(protectedBackupId)) {
      throw new DatabaseBackupError('The protected scheduled backup id is invalid.');
    }

    try {
      const scheduled = (await this.#scan())
        .filter(({ reason }) => reason === 'scheduled')
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
        );
      const normalizedProtectedId = protectedBackupId?.toLowerCase();
      const protectedBackup = normalizedProtectedId
        ? scheduled.find(({ id }) => id === normalizedProtectedId)
        : undefined;
      if (normalizedProtectedId && !protectedBackup) {
        throw new DatabaseBackupError(
          'The protected scheduled backup disappeared before retention cleanup.',
        );
      }
      const retainedIds = new Set<string>();
      if (protectedBackup) retainedIds.add(protectedBackup.id);
      for (const backup of scheduled) {
        if (retainedIds.size >= retentionCount) break;
        retainedIds.add(backup.id);
      }
      const expired = scheduled.filter(({ id }) => !retainedIds.has(id));
      const validateProtectedBackup = async (): Promise<void> => {
        if (normalizedProtectedId) {
          await this.validateReference(normalizedProtectedId, 'scheduled');
        }
      };
      if (expired.length > 0) {
        await validateProtectedBackup();
      }
      let deleted = 0;
      for (const backup of expired) {
        await validateProtectedBackup();
        const path = this.#resolveBackupPath(backup.fileName);
        const current = await lstat(path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (!current) {
          await this.#unlinkBackupArtifacts(path, BACKUP_SIDECAR_SUFFIXES);
          const replacement = await lstat(path).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          });
          if (replacement) {
            throw new DatabaseBackupError(
              'A scheduled backup reappeared during retention cleanup.',
            );
          }
          continue;
        }
        if (!isSafeRegularFile(current)) {
          throw new DatabaseBackupError('A scheduled backup changed before retention cleanup.');
        }
        await validateProtectedBackup();
        const finalEntry = await lstat(path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
          throw error;
        });
        if (!finalEntry || !sameStableFile(current, finalEntry)) {
          throw new DatabaseBackupError('A scheduled backup changed before retention cleanup.');
        }
        await this.#unlinkBackupArtifacts(path, ['', ...BACKUP_SIDECAR_SUFFIXES], new Set(['']));
        deleted += 1;
      }
      return {
        deleted,
        retained: retainedIds.size,
      };
    } catch (error) {
      if (error instanceof DatabaseBackupError) throw error;
      throw new DatabaseBackupError('Scheduled backup retention could not be applied.', {
        cause: error,
      });
    }
  }

  async #scan(): Promise<DatabaseBackupInfo[]> {
    const entries = await readdir(this.#paths.backupDirectory, { withFileTypes: true });
    const backups: DatabaseBackupInfo[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      const parsed = parseBackupFileName(entry.name);
      if (!parsed) {
        continue;
      }
      const path = this.#resolveBackupPath(entry.name);
      const stats = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      });
      if (
        !stats ||
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        !Number.isSafeInteger(stats.size) ||
        stats.size <= 0
      ) {
        continue;
      }
      backups.push({
        ...parsed,
        fileName: entry.name,
        sizeBytes: stats.size,
      });
    }

    return backups;
  }

  async #validate(path: string, schemaVersion: number): Promise<void> {
    const before = await lstat(path);
    if (!isSafeRegularFile(before)) {
      throw new DatabaseBackupError('The database backup validation target is not a regular file.');
    }
    const preexistingSidecars = await this.#readBackupSidecars(path);
    if (preexistingSidecars.length > 0) {
      throw new DatabaseBackupError(
        'The database backup has active SQLite sidecars and cannot be validated safely.',
      );
    }

    const snapshot = this.#adapterFactory(path, { readOnly: true, timeoutMs: 5_000 });
    const validationFailures: unknown[] = [];
    try {
      snapshot.open();
      snapshot.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
      this.#validateSnapshot(snapshot, schemaVersion);
    } catch (error) {
      validationFailures.push(error);
    } finally {
      try {
        snapshot.close();
      } catch (error) {
        validationFailures.push(error);
      }
    }

    const after = await lstat(path).catch((error: unknown) => {
      validationFailures.push(error);
      return undefined;
    });
    if (!after || !sameStableFile(before, after)) {
      throw new DatabaseBackupError(
        'The database backup changed while its SQLite snapshot was validated.',
        { cause: combineFailures(validationFailures) },
      );
    }

    const generatedSidecars = await this.#readBackupSidecars(path);
    try {
      await this.#removeValidatedSidecars(path, generatedSidecars);
    } catch (error) {
      throw new DatabaseBackupError('SQLite validation sidecars could not be cleaned up safely.', {
        cause: combineFailures([...validationFailures, error]),
      });
    }

    const finalEntry = await lstat(path).catch((error: unknown) => {
      validationFailures.push(error);
      return undefined;
    });
    const remainingSidecars = await this.#readBackupSidecars(path);
    if (!finalEntry || !sameStableFile(after, finalEntry) || remainingSidecars.length > 0) {
      throw new DatabaseBackupError(
        'The database backup changed after its SQLite snapshot was validated.',
        { cause: combineFailures(validationFailures) },
      );
    }
    if (validationFailures.length > 0) {
      throw validationFailures.length === 1
        ? validationFailures[0]
        : new AggregateError(validationFailures);
    }
  }

  async #assertBackupDirectory(): Promise<void> {
    const entry = await lstat(this.#paths.backupDirectory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new DatabaseBackupError('The database backup directory is not a real directory.');
    }
  }

  #resolveBackupPath(fileName: string): string {
    if (basename(fileName) !== fileName) {
      throw new DatabaseBackupError('The generated database backup filename is invalid.');
    }
    const path = resolve(this.#paths.backupDirectory, fileName);
    if (dirname(path) !== this.#paths.backupDirectory) {
      throw new DatabaseBackupError('The generated database backup path escaped its directory.');
    }
    return path;
  }

  async #removeBackupArtifacts(path: string, includeMainFile: boolean): Promise<void> {
    await this.#unlinkBackupArtifacts(
      path,
      includeMainFile ? ['', ...BACKUP_SIDECAR_SUFFIXES] : BACKUP_SIDECAR_SUFFIXES,
    );
  }

  async #removeValidatedSidecars(
    path: string,
    sidecars: readonly ObservedBackupSidecar[],
  ): Promise<void> {
    for (const sidecar of sidecars) {
      if (!isSafeValidationSidecar(sidecar)) {
        throw new DatabaseBackupError(
          'An unexpected SQLite sidecar appeared during backup validation.',
        );
      }
    }
    const currentSidecars = await this.#readBackupSidecars(path);
    if (
      currentSidecars.length !== sidecars.length ||
      currentSidecars.some((sidecar, index) => {
        const expected = sidecars[index];
        return (
          !expected ||
          sidecar.suffix !== expected.suffix ||
          !sameObservedFile(sidecar.stats, expected.stats)
        );
      })
    ) {
      throw new DatabaseBackupError('A SQLite sidecar changed before backup validation cleanup.');
    }
    await this.#unlinkBackupArtifacts(
      path,
      sidecars.map(({ suffix }) => suffix),
      new Set(sidecars.map(({ suffix }) => suffix)),
    );
  }

  async #readBackupSidecars(path: string): Promise<ObservedBackupSidecar[]> {
    const name = basename(path);
    if (this.#resolveBackupPath(name) !== path) {
      throw new DatabaseBackupError('The database backup sidecar path is invalid.');
    }
    const sidecars: ObservedBackupSidecar[] = [];
    for (const suffix of BACKUP_SIDECAR_SUFFIXES) {
      const sidecarPath = this.#resolveBackupPath(`${name}${suffix}`);
      const stats = await lstat(sidecarPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (stats) sidecars.push({ suffix, stats });
    }
    return sidecars;
  }

  async #unlinkBackupArtifacts(
    path: string,
    suffixes: readonly BackupArtifactSuffix[],
    requiredSuffixes: ReadonlySet<BackupArtifactSuffix> = new Set(),
  ): Promise<void> {
    const name = basename(path);
    if (this.#resolveBackupPath(name) !== path) {
      throw new DatabaseBackupError('The database backup cleanup path is invalid.');
    }
    const cleanupPaths = [
      ...suffixes.filter((suffix) => suffix !== ''),
      ...suffixes.filter((suffix) => suffix === ''),
    ].map((suffix) => ({
      path: this.#resolveBackupPath(`${name}${suffix}`),
      suffix,
    }));
    const failures: unknown[] = [];
    let removed = false;
    // Leave the discoverable main backup until every exact sidecar has been attempted.
    for (const artifact of cleanupPaths) {
      try {
        await unlink(artifact.path);
        removed = true;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          requiredSuffixes.has(artifact.suffix)
        ) {
          failures.push(error);
        }
      }
    }
    if (removed) {
      await this.#durability.syncDirectory(this.#paths.backupDirectory).catch((error: unknown) => {
        failures.push(error);
      });
    }
    if (failures.length > 0) {
      throw new DatabaseBackupError('Database backup artifacts could not be removed.', {
        cause: new AggregateError(failures),
      });
    }
  }
}

export function toDatabaseBackupInfo(result: BackupResult): DatabaseBackupInfo {
  return {
    id: result.id,
    fileName: result.fileName,
    createdAt: result.createdAt,
    sizeBytes: result.sizeBytes,
    reason: result.reason,
    schemaVersion: result.schemaVersion,
  };
}

function parseBackupFileName(
  fileName: string,
): Omit<DatabaseBackupInfo, 'fileName' | 'sizeBytes'> | undefined {
  const match = BACKUP_FILE_PATTERN.exec(fileName);
  if (!match) {
    return undefined;
  }
  const schemaVersion = Number(match[1]);
  const reason = match[2];
  const createdAt = parseTimestampFromFile(match[3]);
  const id = match[4];
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 0 ||
    (reason !== 'manual' &&
      reason !== 'scheduled' &&
      reason !== 'pre-migration' &&
      reason !== 'pre-import') ||
    !createdAt ||
    !isUuid(id)
  ) {
    return undefined;
  }
  return { id: id.toLowerCase(), reason, schemaVersion, createdAt };
}

function formatTimestampForFile(timestamp: string): string {
  return timestamp.replaceAll('-', '').replaceAll(':', '').replace('.', '');
}

function parseTimestampFromFile(timestamp: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(timestamp);
  if (!match) {
    return undefined;
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso ? iso : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isBackupReason(value: string): value is BackupReason {
  return (
    value === 'manual' ||
    value === 'scheduled' ||
    value === 'pre-migration' ||
    value === 'pre-import'
  );
}

function isSafeRegularFile(entry: Stats): boolean {
  return (
    entry.isFile() && !entry.isSymbolicLink() && Number.isSafeInteger(entry.size) && entry.size > 0
  );
}

function isSafeValidationSidecar(sidecar: ObservedBackupSidecar): boolean {
  if (
    !sidecar.stats.isFile() ||
    sidecar.stats.isSymbolicLink() ||
    !Number.isSafeInteger(sidecar.stats.size) ||
    sidecar.stats.size < 0
  ) {
    return false;
  }
  if (sidecar.suffix === '-wal' || sidecar.suffix === '-journal') {
    return sidecar.stats.size === 0;
  }
  return sidecar.stats.size === 32_768;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 && left.ino !== 0 && right.dev !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size && left.birthtimeMs === right.birthtimeMs;
}

function sameObservedFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    !left.isSymbolicLink() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameStableFile(left: Stats, right: Stats): boolean {
  return (
    isSafeRegularFile(left) &&
    isSafeRegularFile(right) &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function combineFailures(failures: readonly unknown[]): unknown {
  if (failures.length === 0) return undefined;
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures);
}

function samePublishedFile(left: Stats, right: Stats): boolean {
  return (
    isSafeRegularFile(left) &&
    isSafeRegularFile(right) &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

async function syncRegularFile(path: string): Promise<void> {
  const before = await lstat(path);
  if (!isSafeRegularFile(before)) {
    throw new DatabaseBackupError('The database backup durability target is not a regular file.');
  }
  const flags = constants.O_RDWR | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (!sameStableFile(before, opened)) {
      throw new DatabaseBackupError('The database backup changed before it could be made durable.');
    }
    await handle.sync();
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameStableFile(opened, afterHandle) || !sameStableFile(opened, afterPath)) {
      throw new DatabaseBackupError('The database backup changed while it was made durable.');
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const DEFAULT_BACKUP_DURABILITY: BackupDurabilityOperations = {
  syncFile: syncRegularFile,
  syncDirectory,
};

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  throw new DatabaseBackupError('A generated database backup filename already exists.');
}
