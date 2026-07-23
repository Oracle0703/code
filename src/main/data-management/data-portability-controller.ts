import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import type {
  DataExportResult,
  DataImportCommitInput,
  DataImportCommitResult,
  DataImportPreview,
  DataImportSelection,
  DataImportTargetInput,
  DatabaseBackupInfo,
  DatabaseStatus,
} from '../../shared/contracts';
import type { PortableDataRecord, PreparedImport } from '../data-portability';
import { serializePortablePackage } from '../data-portability';
import { DEFAULT_MAX_PACKAGE_BYTES } from '../data-portability/package-format';
import { ReplacementMarkerStore } from '../data-portability/replacement-marker';

export interface PortableDataDatabase {
  getStatus(): Promise<DatabaseStatus>;
  readPortableRecords(): Promise<readonly PortableDataRecord[]>;
  createPreImportBackup(): Promise<DatabaseBackupInfo>;
  validateExistingBackup(
    backupId: string,
    expectedReason: 'pre-import',
  ): Promise<DatabaseBackupInfo>;
}

export interface DataPortabilityDialogs {
  chooseExportPath(defaultFileName: string): Promise<string | undefined>;
  chooseImportPath(): Promise<string | undefined>;
}

export interface DataExportDurabilityOperations {
  readonly syncDirectory: (path: string) => Promise<void>;
}

export interface ImportQuarantineOperations {
  prepare(bytes: Uint8Array): Promise<DataImportPreview>;
  claim(input: DataImportCommitInput): Promise<PreparedImport>;
  refreshClaimed(input: DataImportTargetInput): Promise<PreparedImport>;
  cancel(input: DataImportTargetInput): Promise<void>;
  discardClaimed(input: DataImportTargetInput): Promise<void>;
  detachClaimed(input: DataImportTargetInput): void;
}

export interface DataPortabilityControllerOptions {
  readonly database: PortableDataDatabase;
  readonly dialogs: DataPortabilityDialogs;
  readonly quarantine: ImportQuarantineOperations;
  readonly markerStore: ReplacementMarkerStore;
  readonly databaseFileName?: string;
  readonly appVersion: string;
  readonly requestDestructiveConfirmation: (input: DataImportCommitInput) => Promise<boolean>;
  readonly requestReplacementApproval: () => Promise<boolean>;
  readonly prepareReplacement: () => Promise<void>;
  readonly scheduleRestart: () => Promise<void>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly exportDurability?: DataExportDurabilityOperations;
  readonly defer?: (task: () => void) => void;
  readonly onError?: (error: unknown) => void;
}

type DataPortabilityOperation = 'export' | 'choose-import' | 'commit-import';

export class DataPortabilityController {
  readonly #database: PortableDataDatabase;
  readonly #dialogs: DataPortabilityDialogs;
  readonly #quarantine: ImportQuarantineOperations;
  readonly #markerStore: ReplacementMarkerStore;
  readonly #databaseFileName: string;
  readonly #appVersion: string;
  readonly #requestDestructiveConfirmation: (input: DataImportCommitInput) => Promise<boolean>;
  readonly #requestReplacementApproval: () => Promise<boolean>;
  readonly #prepareReplacement: () => Promise<void>;
  readonly #scheduleRestart: () => Promise<void>;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #exportDurability: DataExportDurabilityOperations;
  readonly #defer: (task: () => void) => void;
  readonly #onError: (error: unknown) => void;
  #operation: DataPortabilityOperation | null = null;

  constructor({
    database,
    dialogs,
    quarantine,
    markerStore,
    databaseFileName = 'daily-workbench.sqlite3',
    appVersion,
    requestDestructiveConfirmation,
    requestReplacementApproval,
    prepareReplacement,
    scheduleRestart,
    now = () => new Date(),
    idFactory = randomUUID,
    exportDurability = DEFAULT_EXPORT_DURABILITY,
    defer = (task) => setTimeout(task, 0),
    onError = () => undefined,
  }: DataPortabilityControllerOptions) {
    if (
      basename(databaseFileName) !== databaseFileName ||
      !/^[A-Za-z0-9._-]+\.sqlite3?$/u.test(databaseFileName)
    ) {
      throw new TypeError('The portable data database filename is invalid.');
    }
    this.#database = database;
    this.#dialogs = dialogs;
    this.#quarantine = quarantine;
    this.#markerStore = markerStore;
    this.#databaseFileName = databaseFileName;
    this.#appVersion = appVersion;
    this.#requestDestructiveConfirmation = requestDestructiveConfirmation;
    this.#requestReplacementApproval = requestReplacementApproval;
    this.#prepareReplacement = prepareReplacement;
    this.#scheduleRestart = scheduleRestart;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#exportDurability = exportDurability;
    this.#defer = defer;
    this.#onError = onError;
  }

  exportData(): Promise<DataExportResult> {
    return this.#exclusive('export', async () => {
      const suggestedAt = this.#readNow().toISOString();
      const defaultFileName = `daily-workbench-data-${formatFileTimestamp(suggestedAt)}.dwbx`;
      const selectedPath = await this.#dialogs.chooseExportPath(defaultFileName);
      if (!selectedPath) return { status: 'cancelled' };
      const exportedAt = this.#readNow().toISOString();
      const destinationPath = requireDataPackageExtension(selectedPath);
      const destination = await captureExportDestination(destinationPath);
      const [status, records] = await Promise.all([
        this.#database.getStatus(),
        this.#database.readPortableRecords(),
      ]);
      const bytes = serializePortablePackage({
        exportId: this.#createId(),
        exportedAt,
        sourceAppVersion: this.#appVersion,
        sourceSchemaVersion: status.schemaVersion,
        records,
      });
      await writeUserSelectedFile(destination, bytes, this.#createId(), this.#exportDurability);
      return {
        status: 'exported',
        fileName: basename(destinationPath),
        exportedAt,
        sizeBytes: bytes.byteLength,
        recordCount: records.length,
      };
    });
  }

  chooseImport(): Promise<DataImportSelection> {
    return this.#exclusive('choose-import', async () => {
      const selectedPath = await this.#dialogs.chooseImportPath();
      if (!selectedPath) return { status: 'cancelled' };
      const bytes = await readUserSelectedPackage(selectedPath);
      const preview = await this.#quarantine.prepare(bytes);
      return { status: 'ready', preview };
    });
  }

  commitImport(input: DataImportCommitInput): Promise<DataImportCommitResult> {
    return this.#exclusive('commit-import', async () => {
      let prepared = await this.#quarantine.claim(input);
      let claimed = true;
      let markerWriteStarted = false;
      let preImportBackupId: string | undefined;
      let restartRequired = false;
      try {
        const confirmed = await this.#requestDestructiveConfirmation({ ...input });
        if (!confirmed) {
          await this.#quarantine.discardClaimed({ importId: prepared.importId });
          claimed = false;
          throw new Error('The data replacement was cancelled.');
        }

        const approved = await this.#requestReplacementApproval();
        if (!approved) {
          await this.#quarantine.discardClaimed({ importId: prepared.importId });
          claimed = false;
          throw new Error('The data replacement was cancelled.');
        }

        // Renderer close approval freezes its surface. Main must now stop every
        // database-writing source before taking the exact rollback snapshot.
        restartRequired = true;
        await this.#prepareReplacement();
        prepared = await this.#quarantine.refreshClaimed({
          importId: prepared.importId,
        });
        const backup = await this.#database.createPreImportBackup();
        preImportBackupId = backup.id;
        await this.#database.validateExistingBackup(backup.id, 'pre-import');
        markerWriteStarted = true;
        await this.#markerStore.create({
          replacementId: prepared.importId,
          timestamp: this.#readNow().toISOString(),
          databaseFileName: this.#databaseFileName,
          stagingFileName: basename(prepared.stagingPath),
          rollbackFileName: `rollback-${prepared.importId}.sqlite3`,
          stagingSha256: prepared.stagingDigest,
          preImportBackupId: backup.id,
        });

        this.#quarantine.detachClaimed({ importId: prepared.importId });
        claimed = false;
        this.#scheduleRestartAfterResponse();
        return { restarting: true };
      } catch (error) {
        if (claimed) {
          if (!markerWriteStarted) {
            await this.#quarantine
              .discardClaimed({ importId: prepared.importId })
              .catch(this.#onError);
          } else {
            // A marker persistence write can durably rename the marker and then
            // fail its directory fsync. Once writing starts, never delete files
            // that a possibly committed marker may reference. If a reread proves
            // no marker exists, the claimed artifacts are safe to discard.
            try {
              const marker = await this.#markerStore.read();
              if (!marker) {
                await this.#quarantine
                  .discardClaimed({ importId: prepared.importId })
                  .catch(this.#onError);
              } else {
                if (
                  marker.replacementId !== prepared.importId ||
                  marker.stagingFileName !== basename(prepared.stagingPath) ||
                  marker.stagingSha256 !== prepared.stagingDigest ||
                  marker.preImportBackupId !== preImportBackupId
                ) {
                  this.#onError(
                    new Error(
                      'A different database replacement marker appeared during import commit.',
                    ),
                  );
                }
                this.#detachClaimedAfterMarker(prepared.importId);
              }
            } catch (readError) {
              this.#onError(readError);
              this.#detachClaimedAfterMarker(prepared.importId);
            }
          }
        }
        if (restartRequired) this.#scheduleRestartAfterResponse();
        throw error;
      }
    });
  }

  cancelImport(input: DataImportTargetInput): Promise<void> {
    if (this.#operation === 'commit-import') {
      return Promise.reject(new Error('The data import is already being committed.'));
    }
    return this.#quarantine.cancel(input);
  }

  #exclusive<T>(operation: DataPortabilityOperation, task: () => Promise<T>): Promise<T> {
    if (this.#operation) {
      return Promise.reject(new Error('Another data management operation is already running.'));
    }
    this.#operation = operation;
    return task().finally(() => {
      if (this.#operation === operation) this.#operation = null;
    });
  }

  #scheduleRestartAfterResponse(): void {
    this.#defer(() => {
      void this.#scheduleRestart().catch(this.#onError);
    });
  }

  #detachClaimedAfterMarker(importId: string): void {
    try {
      this.#quarantine.detachClaimed({ importId });
    } catch (error) {
      // A durable marker owns the artifacts now. Failure to release the
      // in-memory session must not prevent the mandatory process restart.
      this.#onError(error);
    }
  }

  #readNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new TypeError('The data portability clock returned an invalid date.');
    }
    return now;
  }

  #createId(): string {
    const value = this.#idFactory();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ) {
      throw new TypeError('The data portability id is invalid.');
    }
    return value.toLowerCase();
  }
}

async function readUserSelectedPackage(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!isSafePackageFile(before)) {
    throw new Error('The selected data package is not a safe regular file.');
  }

  let handle: FileHandle | undefined;
  try {
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (!isSafePackageFile(opened) || !sameFileIdentity(before, opened)) {
      throw new Error('The selected data package changed before it could be opened.');
    }

    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead < 1) {
        throw new Error('The selected data package ended while it was being read.');
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
      throw new Error('The selected data package changed while it was being read.');
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface PackageFileStats {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface ExportDestination {
  readonly path: string;
  readonly existing: PackageFileStats | undefined;
}

function isSafePackageFile(entry: PackageFileStats): boolean {
  return (
    entry.isFile() &&
    !entry.isSymbolicLink() &&
    entry.size >= 1 &&
    entry.size <= DEFAULT_MAX_PACKAGE_BYTES
  );
}

function sameFileIdentity(left: PackageFileStats, right: PackageFileStats): boolean {
  if (left.dev !== 0 && left.ino !== 0 && right.dev !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function sameStableFile(left: PackageFileStats, right: PackageFileStats): boolean {
  return (
    isSafePackageFile(right) &&
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function captureExportDestination(path: string): Promise<ExportDestination> {
  const destination = resolve(path);
  const existing = await readOptionalFileStats(destination);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('The export destination is not a safe regular file.');
  }
  return { path: destination, existing };
}

async function readOptionalFileStats(path: string): Promise<PackageFileStats | undefined> {
  return lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
}

async function assertExportDestinationUnchanged(destination: ExportDestination): Promise<void> {
  const current = await readOptionalFileStats(destination.path);
  if (!destination.existing) {
    if (current) {
      throw new Error('The export destination was created after overwrite approval was requested.');
    }
    return;
  }
  if (
    !current ||
    !current.isFile() ||
    current.isSymbolicLink() ||
    !sameStableIdentity(destination.existing, current)
  ) {
    throw new Error('The export destination changed after overwrite approval was requested.');
  }
}

function sameStableIdentity(left: PackageFileStats, right: PackageFileStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function writeUserSelectedFile(
  destination: ExportDestination,
  bytes: Buffer,
  temporaryId: string,
  durability: DataExportDurabilityOperations,
): Promise<void> {
  const parent = dirname(destination.path);
  const temporaryPath = resolve(parent, `.${basename(destination.path)}.${temporaryId}.partial`);
  if (dirname(temporaryPath) !== parent) {
    throw new Error('The export staging path escaped its destination directory.');
  }
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    const staged = await lstat(temporaryPath);
    if (!isSafePackageFile(staged) || staged.size !== bytes.byteLength) {
      throw new Error('The completed data export is not a safe regular file.');
    }
    await assertExportDestinationUnchanged(destination);
    await rename(temporaryPath, destination.path);
    await verifyPublishedExport(destination.path, staged, bytes, durability, parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function verifyPublishedExport(
  path: string,
  staged: PackageFileStats,
  expected: Buffer,
  durability: DataExportDurabilityOperations,
  parent: string,
): Promise<void> {
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, flags);
    const opened = await handle.stat();
    if (
      !isSafePackageFile(opened) ||
      opened.size !== expected.byteLength ||
      !samePublishedFile(staged, opened)
    ) {
      throw new Error('The published data export changed before it could be verified.');
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expected.byteLength));
    let offset = 0;
    while (offset < expected.byteLength) {
      const length = Math.min(buffer.byteLength, expected.byteLength - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (
        bytesRead !== length ||
        !buffer.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))
      ) {
        throw new Error('The published data export contents do not match the export.');
      }
      offset += bytesRead;
    }
    const trailingByte = Buffer.allocUnsafe(1);
    if ((await handle.read(trailingByte, 0, 1, expected.byteLength)).bytesRead !== 0) {
      throw new Error('The published data export grew while it was being verified.');
    }
    await durability.syncDirectory(parent);
    const [afterHandle, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (!sameStableFile(opened, afterHandle) || !sameStableFile(opened, afterPath)) {
      throw new Error('The published data export changed while it was made durable.');
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function samePublishedFile(staged: PackageFileStats, published: PackageFileStats): boolean {
  const hasStableIdentity =
    staged.dev !== 0 && staged.ino !== 0 && published.dev !== 0 && published.ino !== 0;
  return (
    staged.size === published.size &&
    staged.mtimeMs === published.mtimeMs &&
    (hasStableIdentity
      ? staged.dev === published.dev && staged.ino === published.ino
      : staged.birthtimeMs === published.birthtimeMs)
  );
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const DEFAULT_EXPORT_DURABILITY: DataExportDurabilityOperations = {
  syncDirectory,
};

function requireDataPackageExtension(path: string): string {
  const extension = extname(path);
  if (extension.toLowerCase() !== '.dwbx') {
    throw new Error('The export destination must use the .dwbx extension.');
  }
  return path;
}

function formatFileTimestamp(timestamp: string): string {
  return timestamp
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace(/\.\d{3}Z$/u, 'Z');
}
