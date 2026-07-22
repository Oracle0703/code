import { randomUUID } from 'node:crypto';
import { chmod, lstat, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { DatabaseBackupInfo } from '../../shared/contracts';
import { DatabaseBackupError } from './errors';
import type { SqliteAdapter, SqliteAdapterFactory } from './sqlite-adapter';
import type { BackupReason, BackupResult, DatabasePaths } from './types';

const BACKUP_FILE_PATTERN =
  /^daily-workbench-v(\d+)-(manual|pre-migration)-([0-9]{8}T[0-9]{9}Z)-([0-9a-fA-F-]{36})\.sqlite3$/u;
const DEFAULT_LIST_LIMIT = 100;

export interface BackupManagerOptions {
  readonly paths: DatabasePaths;
  readonly adapterFactory: SqliteAdapterFactory;
  readonly validateSnapshot: (database: SqliteAdapter, schemaVersion: number) => void;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class BackupManager {
  readonly #paths: DatabasePaths;
  readonly #adapterFactory: SqliteAdapterFactory;
  readonly #validateSnapshot: (database: SqliteAdapter, schemaVersion: number) => void;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor({
    paths,
    adapterFactory,
    validateSnapshot,
    now = () => new Date(),
    idFactory = randomUUID,
  }: BackupManagerOptions) {
    this.#paths = paths;
    this.#adapterFactory = adapterFactory;
    this.#validateSnapshot = validateSnapshot;
    this.#now = now;
    this.#idFactory = idFactory;
  }

  async create(
    source: SqliteAdapter,
    reason: BackupReason,
    schemaVersion: number,
  ): Promise<BackupResult> {
    let temporaryPath: string | undefined;

    try {
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
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size <= 0) {
        throw new DatabaseBackupError('The completed database backup is not a regular file.');
      }
      await rename(temporaryPath, destinationPath);

      return {
        id,
        fileName,
        path: destinationPath,
        reason,
        createdAt,
        sizeBytes: entry.size,
        schemaVersion,
        pages,
      };
    } catch (error) {
      if (temporaryPath) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
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
    const snapshot = this.#adapterFactory(path, { readOnly: true, timeoutMs: 5_000 });
    try {
      snapshot.open();
      snapshot.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');
      this.#validateSnapshot(snapshot, schemaVersion);
    } finally {
      snapshot.close();
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
    (reason !== 'manual' && reason !== 'pre-migration') ||
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
