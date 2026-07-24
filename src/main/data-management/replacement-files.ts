import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, parse, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  recoveryActionFor,
  ReplacementMarkerStore,
  type DatabaseReplacementMarker,
  type ReplacementMarkerPersistence,
} from '../data-portability';

const MARKER_FILE_NAME = 'database-replacement-v1.json';
const MAXIMUM_MARKER_BYTES = 16 * 1024;
const ABANDONED_IMPORT_FILE =
  /^(?:import-[0-9a-f-]{36}\.(?:dwbx|sqlite3(?:-(?:wal|shm|journal))?)|\.import-[0-9a-f-]{36}\.(?:dwbx\.partial|sqlite3\.[0-9a-f-]{36}\.partial(?:-(?:wal|shm|journal))?))$/u;
const ABANDONED_BACKUP_RESTORE_DIRECTORY =
  /^\.backup-restore-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ABANDONED_MARKER_PARTIAL = /^\.database-replacement-v1\.json\.[0-9a-f-]{36}\.partial$/u;
const ORPHANED_ROLLBACK_FILE =
  /^rollback-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.sqlite3$/iu;
const RETAINED_RECOVERY_FILE =
  /^pre-import-recovery-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.sqlite3$/iu;

export interface FileReplacementMarkerPersistenceOptions {
  readonly dataDirectory: string;
  readonly idFactory?: () => string;
}

export class FileReplacementMarkerPersistence implements ReplacementMarkerPersistence {
  readonly #dataDirectory: string;
  readonly #markerPath: string;
  readonly #idFactory: () => string;

  constructor({ dataDirectory, idFactory = randomUUID }: FileReplacementMarkerPersistenceOptions) {
    this.#dataDirectory = resolveSafeDirectory(dataDirectory);
    this.#markerPath = resolveChild(this.#dataDirectory, MARKER_FILE_NAME);
    this.#idFactory = idFactory;
  }

  async read(): Promise<unknown | undefined> {
    const parent = await inspectOptionalRealDirectory(this.#dataDirectory);
    if (!parent) return undefined;
    const contents = await readStableRegularFile(this.#markerPath, MAXIMUM_MARKER_BYTES, true);
    if (!contents) return undefined;
    if (contents.byteLength < 2) {
      throw new Error('The database replacement marker size is invalid.');
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    } catch (error) {
      throw new Error('The database replacement marker encoding is invalid.', {
        cause: error,
      });
    }
    if (!text.endsWith('\n') || text.includes('\u0000')) {
      throw new Error('The database replacement marker framing is invalid.');
    }
    try {
      return JSON.parse(text.slice(0, -1)) as unknown;
    } catch (error) {
      throw new Error('The database replacement marker is not valid JSON.', { cause: error });
    }
  }

  async write(marker: DatabaseReplacementMarker): Promise<void> {
    await preparePrivateDirectory(this.#dataDirectory);
    const temporaryId = normalizeUuid(this.#idFactory(), 'replacement marker write id');
    const temporaryPath = resolveChild(
      this.#dataDirectory,
      `.${MARKER_FILE_NAME}.${temporaryId}.partial`,
    );
    const contents = `${JSON.stringify(marker)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > MAXIMUM_MARKER_BYTES) {
      throw new Error('The database replacement marker is too large.');
    }

    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.#markerPath);
      await syncDirectory(this.#dataDirectory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remove(): Promise<void> {
    const entry = await inspectOptionalRegularFile(this.#markerPath);
    if (entry) {
      await rm(this.#markerPath);
      await syncDirectory(this.#dataDirectory);
    }
  }
}

export interface DatabaseReplacementRecoveryOptions {
  readonly dataDirectory: string;
  readonly databaseFileName?: string;
  readonly importDirectoryName?: string;
  readonly markerStore: ReplacementMarkerStore;
  readonly checkpointCurrentDatabase: () => Promise<void>;
  readonly validateInstalledDatabase: () => Promise<void>;
  readonly validatePreImportBackup: (backupId: string) => Promise<void>;
  readonly validateRecoveryDatabase: (fileName: string) => Promise<void>;
  readonly now?: () => Date;
}

export interface DatabaseReplacementRecoveryResult {
  readonly outcome: 'none' | 'committed' | 'rolled-back';
  readonly preImportBackupId?: string;
}

interface ReplacementPaths {
  readonly database: string;
  readonly rollback: string;
  readonly staging: string;
  readonly package: string;
}

export class DatabaseReplacementRecovery {
  readonly #dataDirectory: string;
  readonly #databaseFileName: string;
  readonly #importDirectory: string;
  readonly #markerStore: ReplacementMarkerStore;
  readonly #checkpointCurrentDatabase: () => Promise<void>;
  readonly #validateInstalledDatabase: () => Promise<void>;
  readonly #validatePreImportBackup: (backupId: string) => Promise<void>;
  readonly #validateRecoveryDatabase: (fileName: string) => Promise<void>;
  readonly #now: () => Date;

  constructor({
    dataDirectory,
    databaseFileName = 'daily-workbench.sqlite3',
    importDirectoryName = 'imports',
    markerStore,
    checkpointCurrentDatabase,
    validateInstalledDatabase,
    validatePreImportBackup,
    validateRecoveryDatabase,
    now = () => new Date(),
  }: DatabaseReplacementRecoveryOptions) {
    this.#dataDirectory = resolveSafeDirectory(dataDirectory);
    if (
      basename(databaseFileName) !== databaseFileName ||
      !/^[A-Za-z0-9._-]+\.sqlite3?$/u.test(databaseFileName)
    ) {
      throw new TypeError('The replacement database filename is invalid.');
    }
    if (
      basename(importDirectoryName) !== importDirectoryName ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(importDirectoryName)
    ) {
      throw new TypeError('The replacement import directory is invalid.');
    }
    this.#databaseFileName = databaseFileName;
    this.#importDirectory = resolveChild(this.#dataDirectory, importDirectoryName);
    this.#markerStore = markerStore;
    this.#checkpointCurrentDatabase = checkpointCurrentDatabase;
    this.#validateInstalledDatabase = validateInstalledDatabase;
    this.#validatePreImportBackup = validatePreImportBackup;
    this.#validateRecoveryDatabase = validateRecoveryDatabase;
    this.#now = now;
  }

  async recover(): Promise<DatabaseReplacementRecoveryResult> {
    const dataDirectory = await inspectOptionalRealDirectory(this.#dataDirectory);
    if (!dataDirectory) return { outcome: 'none' };
    let marker = await this.#markerStore.read();
    if (!marker) return this.#recoverOrphanedRollback();
    await inspectOptionalRealDirectory(this.#importDirectory);
    if (marker.databaseFileName !== this.#databaseFileName) {
      throw new Error('The replacement marker targets a different database.');
    }

    for (let transition = 0; transition < 10; transition += 1) {
      const paths = this.#resolvePaths(marker);
      switch (recoveryActionFor(marker)) {
        case 'move-old-database': {
          try {
            await this.#validatePreImportBackup(marker.preImportBackupId);
          } catch {
            marker = await this.#markerStore.transition('ready', 'rolled-back', this.#timestamp());
            break;
          }
          const [database, rollback, staging] = await Promise.all([
            inspectOptionalRegularFile(paths.database),
            inspectOptionalRegularFile(paths.rollback),
            inspectOptionalRegularFile(paths.staging),
          ]);
          if (database && !rollback) {
            try {
              await this.#assertStaging(paths.staging, marker.stagingSha256);
            } catch {
              marker = await this.#markerStore.transition(
                'ready',
                'rolled-back',
                this.#timestamp(),
              );
              break;
            }
            await this.#checkpointCurrentDatabase();
            await assertMissing(paths.rollback);
            await rename(paths.database, paths.rollback);
            await syncDirectory(this.#dataDirectory);
          } else if (!database && rollback) {
            try {
              await this.#assertStaging(paths.staging, marker.stagingSha256);
            } catch {
              marker = await this.#markerStore.transition(
                'ready',
                'rolled-back',
                this.#timestamp(),
              );
              break;
            }
          } else if (database && rollback) {
            if (!staging) {
              try {
                await this.#assertStaging(paths.database, marker.stagingSha256);
                marker = await this.#markerStore.transition(
                  'ready',
                  'old-moved',
                  this.#timestamp(),
                );
                break;
              } catch {
                // The database is not the staged import. Prefer the known
                // rollback copy over guessing which visible file is current.
              }
            }
            marker = await this.#markerStore.transition('ready', 'rolled-back', this.#timestamp());
            break;
          } else {
            throw new Error('The original database replacement state is ambiguous.');
          }
          marker = await this.#markerStore.transition('ready', 'old-moved', this.#timestamp());
          break;
        }
        case 'install-staged-database': {
          const [database, rollback, staging] = await Promise.all([
            inspectOptionalRegularFile(paths.database),
            inspectOptionalRegularFile(paths.rollback),
            inspectOptionalRegularFile(paths.staging),
          ]);
          if (database && !rollback && staging) {
            // On filesystems without directory fsync support, the phase marker may
            // persist before the preceding database-to-rollback rename. Replay it.
            try {
              await this.#assertStaging(paths.staging, marker.stagingSha256);
            } catch {
              marker = await this.#markerStore.transition(
                'old-moved',
                'rolling-back',
                this.#timestamp(),
              );
              break;
            }
            await this.#checkpointCurrentDatabase();
            await rename(paths.database, paths.rollback);
            await syncDirectory(this.#dataDirectory);
            await rename(paths.staging, paths.database);
            await Promise.all([
              syncDirectory(this.#importDirectory),
              syncDirectory(this.#dataDirectory),
            ]);
          } else if (!database && rollback && staging) {
            try {
              await this.#assertStaging(paths.staging, marker.stagingSha256);
            } catch {
              marker = await this.#markerStore.transition(
                'old-moved',
                'rolling-back',
                this.#timestamp(),
              );
              break;
            }
            await rename(paths.staging, paths.database);
            await Promise.all([
              syncDirectory(this.#importDirectory),
              syncDirectory(this.#dataDirectory),
            ]);
          } else if (database && rollback && !staging) {
            try {
              await this.#assertStaging(paths.database, marker.stagingSha256);
            } catch {
              marker = await this.#markerStore.transition(
                'old-moved',
                'rolling-back',
                this.#timestamp(),
              );
              break;
            }
          } else if ((database && !rollback && !staging) || (!database && rollback && !staging)) {
            marker = await this.#markerStore.transition(
              'old-moved',
              'rolling-back',
              this.#timestamp(),
            );
            break;
          } else if (rollback) {
            marker = await this.#markerStore.transition(
              'old-moved',
              'rolling-back',
              this.#timestamp(),
            );
            break;
          } else {
            throw new Error('The staged database replacement state is ambiguous.');
          }
          marker = await this.#markerStore.transition(
            'old-moved',
            'new-installed',
            this.#timestamp(),
          );
          break;
        }
        case 'validate-installed-database':
          try {
            await this.#assertInstalledState(paths, marker.stagingSha256, true);
            await this.#validateInstalledDatabase();
            marker = await this.#markerStore.transition(
              'new-installed',
              'validated',
              this.#timestamp(),
            );
          } catch {
            marker = await this.#markerStore.transition(
              'new-installed',
              'rolling-back',
              this.#timestamp(),
            );
          }
          break;
        case 'commit-replacement':
          try {
            await this.#assertInstalledState(paths, marker.stagingSha256, true);
            await this.#validateInstalledDatabase();
            await this.#validatePreImportBackup(marker.preImportBackupId);
            marker = await this.#markerStore.transition(
              'validated',
              'committed',
              this.#timestamp(),
            );
          } catch {
            marker = await this.#markerStore.transition(
              'validated',
              'rolling-back',
              this.#timestamp(),
            );
          }
          break;
        case 'restore-old-database': {
          await this.#finalizeRollback(marker, paths);
          marker = await this.#markerStore.transition(
            'rolling-back',
            'rolled-back',
            this.#timestamp(),
          );
          break;
        }
        case 'cleanup': {
          if (marker.phase === 'committed') {
            const retainedRecoveryPath = resolveChild(
              this.#dataDirectory,
              retainedRecoveryFileName(marker.replacementId),
            );
            const [rollback, retainedRecovery] = await Promise.all([
              inspectOptionalRegularFile(paths.rollback),
              inspectOptionalRegularFile(retainedRecoveryPath),
            ]);
            try {
              await this.#assertInstalledState(paths, marker.stagingSha256, false);
              await this.#validateInstalledDatabase();
              if (rollback) {
                await this.#publishRollbackRecovery(marker, paths.rollback);
              } else {
                await this.#validateRecoveryDatabase(
                  retainedRecoveryFileName(marker.replacementId),
                );
              }
            } catch (error) {
              if (!rollback && !retainedRecovery) throw error;
              marker = await this.#markerStore.transition(
                'committed',
                'rolling-back',
                this.#timestamp(),
              );
              break;
            }
          } else {
            await this.#finalizeRollback(marker, paths);
          }
          const outcome = marker.phase === 'committed' ? 'committed' : 'rolled-back';
          await this.#cleanup(paths);
          await this.#markerStore.removeTerminal();
          return {
            outcome,
            preImportBackupId: marker.preImportBackupId,
          };
        }
      }
    }
    throw new Error('The database replacement did not reach a terminal state.');
  }

  async #recoverOrphanedRollback(): Promise<DatabaseReplacementRecoveryResult> {
    const rollbackNames: string[] = [];
    const retainedRecoveryNames: string[] = [];
    for (const entry of await readdir(this.#dataDirectory, { withFileTypes: true })) {
      if (!ORPHANED_ROLLBACK_FILE.test(entry.name) && !RETAINED_RECOVERY_FILE.test(entry.name)) {
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('An orphaned database recovery copy is not a regular file.');
      }
      if (ORPHANED_ROLLBACK_FILE.test(entry.name)) rollbackNames.push(entry.name);
      else retainedRecoveryNames.push(entry.name);
    }
    const databasePath = resolveChild(this.#dataDirectory, this.#databaseFileName);
    const database = await inspectOptionalRegularFile(databasePath);
    if (rollbackNames.length === 0) {
      if (!database && retainedRecoveryNames.length > 0) {
        throw new Error('The main database is missing while retained recovery copies exist.');
      }
      return { outcome: 'none' };
    }
    if (rollbackNames.length !== 1) {
      throw new Error('Multiple orphaned database rollbacks require manual recovery.');
    }

    if (database) {
      throw new Error(
        'A database and an orphaned rollback both exist; automatic recovery is ambiguous.',
      );
    }
    const rollbackPath = resolveChild(this.#dataDirectory, rollbackNames[0]);
    await rename(rollbackPath, databasePath);
    await syncDirectory(this.#dataDirectory);
    try {
      await this.#validateInstalledDatabase();
    } catch (error) {
      try {
        await rename(databasePath, rollbackPath);
        await syncDirectory(this.#dataDirectory);
      } catch (rollbackError) {
        throw new AggregateError(
          [error],
          'An invalid orphaned rollback could not be preserved safely.',
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return { outcome: 'rolled-back' };
  }

  async #publishRollbackRecovery(
    marker: DatabaseReplacementMarker,
    rollbackPath: string,
  ): Promise<void> {
    const fileName = retainedRecoveryFileName(marker.replacementId);
    const destinationPath = resolveChild(this.#dataDirectory, fileName);
    await assertMissing(destinationPath);
    await this.#validateRecoveryDatabase(basename(rollbackPath));
    let published = false;
    try {
      await rename(rollbackPath, destinationPath);
      published = true;
      await syncDirectory(this.#dataDirectory);
      await this.#validateRecoveryDatabase(fileName);
    } catch (error) {
      if (!published) throw error;
      try {
        await rename(destinationPath, rollbackPath);
        await syncDirectory(this.#dataDirectory);
      } catch (rollbackError) {
        throw new AggregateError(
          [error],
          'A retained database recovery copy could not be reverted safely.',
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }

  #resolvePaths(marker: DatabaseReplacementMarker): ReplacementPaths {
    return {
      database: resolveChild(this.#dataDirectory, marker.databaseFileName),
      rollback: resolveChild(this.#dataDirectory, marker.rollbackFileName),
      staging: resolveChild(this.#importDirectory, marker.stagingFileName),
      package: resolveChild(this.#importDirectory, `import-${marker.replacementId}.dwbx`),
    };
  }

  async #assertStaging(path: string, expectedDigest: string): Promise<void> {
    const actualDigest = await hashRegularFile(path);
    if (actualDigest !== expectedDigest) {
      throw new Error('The staged database digest does not match the replacement marker.');
    }
  }

  async #assertInstalledState(
    paths: ReplacementPaths,
    expectedDigest: string,
    requireRollback: boolean,
  ): Promise<void> {
    const [database, rollback, staging] = await Promise.all([
      inspectOptionalRegularFile(paths.database),
      inspectOptionalRegularFile(paths.rollback),
      inspectOptionalRegularFile(paths.staging),
    ]);
    if (!database || staging || (requireRollback && !rollback)) {
      throw new Error('The installed database replacement state is incomplete.');
    }
    await this.#assertStaging(paths.database, expectedDigest);
  }

  async #finalizeRollback(
    marker: DatabaseReplacementMarker,
    paths: ReplacementPaths,
  ): Promise<void> {
    const recoveryFileName = retainedRecoveryFileName(marker.replacementId);
    const recoveryPath = resolveChild(this.#dataDirectory, recoveryFileName);
    const [database, rollback, retainedRecovery] = await Promise.all([
      inspectOptionalRegularFile(paths.database),
      inspectOptionalRegularFile(paths.rollback),
      inspectOptionalRegularFile(recoveryPath),
    ]);
    if (rollback) {
      // Never discard a still-usable current database in favor of an
      // unvalidated rollback file. Validation must happen while both exact
      // paths remain intact so a corrupt recovery artifact is a hard stop,
      // not a destructive replacement attempt.
      await this.#validateRecoveryDatabase(basename(paths.rollback));
      // Rename directly over the current database. If the validated source is
      // removed before this syscall, rename fails while the destination stays
      // intact; an explicit rm(destination) would turn that race into data loss.
      await rename(paths.rollback, paths.database);
      await syncDirectory(this.#dataDirectory);
    } else if (retainedRecovery) {
      await this.#validateRecoveryDatabase(recoveryFileName);
      // Apply the same no-gap replacement rule to retained recovery copies.
      await rename(recoveryPath, paths.database);
      await syncDirectory(this.#dataDirectory);
    } else {
      if (!database) {
        throw new Error('The original database is unavailable for rollback.');
      }
      if ((await hashRegularFile(paths.database)) === marker.stagingSha256) {
        throw new Error('The imported database cannot be mistaken for a completed rollback.');
      }
    }
    await this.#validateInstalledDatabase();
  }

  async #cleanup(paths: ReplacementPaths): Promise<void> {
    const disposable = [paths.staging, paths.package];
    for (const path of disposable) {
      const entry = await inspectOptionalRegularFile(path);
      if (entry) {
        await rm(path);
        await syncDirectory(dirname(path));
      }
    }
  }

  #timestamp(): string {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('The replacement recovery clock returned an invalid date.');
    }
    return now.toISOString();
  }
}

export async function cleanupAbandonedImportArtifacts(
  dataDirectory: string,
  importDirectoryName = 'imports',
): Promise<number> {
  const parent = resolveSafeDirectory(dataDirectory);
  const parentEntry = await lstat(parent).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!parentEntry) return 0;
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new Error('The database replacement data path is not a real directory.');
  }
  if (
    basename(importDirectoryName) !== importDirectoryName ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(importDirectoryName)
  ) {
    throw new TypeError('The abandoned import directory is invalid.');
  }
  const directory = resolveChild(parent, importDirectoryName);
  const entry = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('The import quarantine is not a real directory.');
  }

  let removed = 0;
  if (entry) {
    for (const candidate of await readdir(directory, { withFileTypes: true })) {
      const path = resolveChild(directory, candidate.name);
      if (ABANDONED_IMPORT_FILE.test(candidate.name)) {
        if (!candidate.isFile() || candidate.isSymbolicLink()) {
          throw new Error('An abandoned import artifact is not a regular file.');
        }
        await rm(path);
        removed += 1;
        continue;
      }
      if (!ABANDONED_BACKUP_RESTORE_DIRECTORY.test(candidate.name)) continue;
      if (!candidate.isDirectory() || candidate.isSymbolicLink()) {
        throw new Error('An abandoned backup restore path is not a real directory.');
      }
      await inspectOptionalRealDirectory(path);
      await rm(path, { recursive: true });
      removed += 1;
    }
  }
  for (const candidate of await readdir(parent, { withFileTypes: true })) {
    if (!ABANDONED_MARKER_PARTIAL.test(candidate.name)) continue;
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      throw new Error('An abandoned replacement marker is not a regular file.');
    }
    await rm(resolveChild(parent, candidate.name));
    removed += 1;
  }
  return removed;
}

async function preparePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('A replacement path is not a real directory.');
  }
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

function resolveSafeDirectory(path: string): string {
  const result = resolve(path);
  if (result === parse(result).root) {
    throw new TypeError('A filesystem root cannot be used for database replacement.');
  }
  return result;
}

function resolveChild(parent: string, fileName: string): string {
  if (basename(fileName) !== fileName) {
    throw new TypeError('A database replacement filename is invalid.');
  }
  const path = resolve(parent, fileName);
  if (dirname(path) !== parent) {
    throw new TypeError('A database replacement path escaped its controlled directory.');
  }
  return path;
}

async function inspectOptionalRegularFile(path: string) {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('A database replacement artifact is not a regular file.');
  }
  return entry;
}

async function inspectOptionalRealDirectory(path: string) {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error('A database replacement directory is not a real directory.');
  }
  return entry;
}

async function assertMissing(path: string): Promise<void> {
  if (await inspectOptionalRegularFile(path)) {
    throw new Error('A database replacement artifact already exists.');
  }
}

function retainedRecoveryFileName(replacementId: string): string {
  const normalizedId = normalizeUuid(replacementId, 'retained recovery id');
  return `pre-import-recovery-${normalizedId}.sqlite3`;
}

async function hashRegularFile(path: string): Promise<string> {
  const beforePath = await lstat(path);
  if (!isRegularFile(beforePath) || beforePath.size < 1) {
    throw new Error('A database replacement artifact is missing or empty.');
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const handle = await open(path, flags);
  const hash = createHash('sha256');
  try {
    const opened = await handle.stat();
    if (!isRegularFile(opened) || !sameFileIdentity(beforePath, opened)) {
      throw new Error('A database replacement artifact changed before it was opened.');
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const length = Math.min(buffer.byteLength, opened.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead < 1) {
        throw new Error('A database replacement artifact ended while it was checked.');
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameStableFile(opened, afterHandle) || !sameStableFile(opened, afterPath)) {
      throw new Error('A database replacement artifact changed while it was checked.');
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readStableRegularFile(
  path: string,
  maximumBytes: number,
  allowMissing = false,
): Promise<Buffer | undefined> {
  let beforePath;
  try {
    beforePath = await lstat(path);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (!isRegularFile(beforePath) || beforePath.size < 1 || beforePath.size > maximumBytes) {
    throw new Error('A database replacement artifact has an invalid size or type.');
  }

  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (
      !isRegularFile(opened) ||
      opened.size > maximumBytes ||
      !sameFileIdentity(beforePath, opened)
    ) {
      throw new Error('A database replacement artifact changed before it was opened.');
    }
    const contents = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents,
        offset,
        contents.byteLength - offset,
        offset,
      );
      if (bytesRead < 1) {
        throw new Error('A database replacement artifact ended while it was read.');
      }
      offset += bytesRead;
    }
    const trailingByte = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytesRead } = await handle.read(trailingByte, 0, 1, opened.size);
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      trailingBytesRead !== 0 ||
      !sameStableFile(opened, afterHandle) ||
      !sameStableFile(opened, afterPath)
    ) {
      throw new Error('A database replacement artifact changed while it was read.');
    }
    return contents;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface StableFileStats {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function isRegularFile(entry: StableFileStats): boolean {
  return entry.isFile() && !entry.isSymbolicLink();
}

function sameFileIdentity(left: StableFileStats, right: StableFileStats): boolean {
  if (left.dev !== 0 && left.ino !== 0 && right.dev !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
  );
}

function sameStableFile(left: StableFileStats, right: StableFileStats): boolean {
  return (
    isRegularFile(right) &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizeUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError(`The ${name} is invalid.`);
  }
  return value.toLowerCase();
}
