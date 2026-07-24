import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type {
  DataImportCommitInput,
  DataImportPreview,
  DataImportTargetInput,
} from '../../shared/contracts';
import {
  DEFAULT_MAX_PACKAGE_BYTES,
  parsePortablePackage,
  type ParsedPortablePackage,
  type PortablePackageLimits,
} from './package-format';
import {
  DEFAULT_MAX_IMPORT_STAGING_BYTES,
  type ImportStager,
  type ImportStagingContext,
} from './staging';

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1_000;

interface ImportSession {
  readonly importId: string;
  readonly previewDigest: string;
  readonly expiresAt: string;
  readonly packagePath: string;
  readonly packageDigest: string;
  readonly package: ParsedPortablePackage;
  readonly stagingPath: string;
  stagingDigest: string;
  claimed: boolean;
  busy: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

export interface PreparedImport {
  readonly importId: string;
  readonly packagePath: string;
  readonly packageDigest: string;
  readonly stagingPath: string;
  readonly stagingDigest: string;
}

export interface ImportQuarantineOptions {
  readonly directory: string;
  readonly stager: ImportStager;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly sessionTtlMs?: number;
  readonly packageLimits?: PortablePackageLimits;
  readonly maxStagingBytes?: number;
}

export class ImportQuarantine {
  readonly #directory: string;
  readonly #stager: ImportStager;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #sessionTtlMs: number;
  readonly #packageLimits: PortablePackageLimits;
  readonly #maxStagingBytes: number;
  readonly #sessions = new Map<string, ImportSession>();
  #preparing = false;

  constructor({
    directory,
    stager,
    now = () => new Date(),
    idFactory = randomUUID,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    packageLimits = {},
    maxStagingBytes = DEFAULT_MAX_IMPORT_STAGING_BYTES,
  }: ImportQuarantineOptions) {
    const resolvedDirectory = resolve(directory);
    if (resolvedDirectory === dirname(resolvedDirectory)) {
      throw new TypeError('The import quarantine cannot use a filesystem root.');
    }
    if (
      !Number.isSafeInteger(sessionTtlMs) ||
      sessionTtlMs < 60_000 ||
      sessionTtlMs > 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError('The import preview lifetime is invalid.');
    }
    if (
      !Number.isSafeInteger(maxStagingBytes) ||
      maxStagingBytes < 1 ||
      maxStagingBytes > DEFAULT_MAX_IMPORT_STAGING_BYTES
    ) {
      throw new TypeError('The import staging size limit is invalid.');
    }
    this.#directory = resolvedDirectory;
    this.#stager = stager;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#sessionTtlMs = sessionTtlMs;
    this.#packageLimits = packageLimits;
    this.#maxStagingBytes = maxStagingBytes;
  }

  hasActiveSession(): boolean {
    return this.#preparing || this.#sessions.size !== 0;
  }

  async prepare(bytes: Uint8Array): Promise<DataImportPreview> {
    if (this.#preparing) {
      throw new Error('Another import preview is already being prepared.');
    }
    if (this.#sessions.size !== 0) {
      throw new Error('The existing import preview must be cancelled before preparing another.');
    }
    this.#preparing = true;
    try {
      const parsed = parsePortablePackage(bytes, this.#packageLimits);
      await this.#prepareDirectory();
      const now = this.#readNow();
      const importId = this.#createId();
      const expiresAt = new Date(now.getTime() + this.#sessionTtlMs).toISOString();
      const packageDigest = parsed.packageSha256;
      const previewDigest = digestPreview(importId, packageDigest, expiresAt);
      const packagePath = this.#resolveFile(`import-${importId}.dwbx`);
      const packagePartialPath = this.#resolveFile(`.import-${importId}.dwbx.partial`);
      const stagingPath = this.#resolveFile(`import-${importId}.sqlite3`);
      const stagingContext = {
        importId,
        package: parsed,
        destinationPath: stagingPath,
      };

      await Promise.all([
        assertMissing(packagePath),
        assertMissing(packagePartialPath),
        assertMissing(stagingPath),
      ]);
      try {
        await writeDurableFile(packagePartialPath, bytes);
        await rename(packagePartialPath, packagePath);
        await syncDirectory(this.#directory);
        await this.#stager.stage(stagingContext);
        const stagingDigest = await this.#hashAndValidateStaging(stagingContext);
        const session: ImportSession = {
          importId,
          previewDigest,
          expiresAt,
          packagePath,
          packageDigest,
          package: parsed,
          stagingPath,
          stagingDigest,
          claimed: false,
          busy: false,
        };
        this.#sessions.set(importId, session);
        this.#armExpiry(session);
        return toPreview(parsed, importId, previewDigest, expiresAt);
      } catch (error) {
        await Promise.all([
          rm(packagePartialPath, { force: true }).catch(() => undefined),
          rm(packagePath, { force: true }).catch(() => undefined),
          rm(stagingPath, { force: true }).catch(() => undefined),
          removeSqliteSidecars(stagingPath),
        ]);
        await syncDirectory(this.#directory).catch(() => undefined);
        throw error;
      }
    } finally {
      this.#preparing = false;
    }
  }

  async claim(input: DataImportCommitInput): Promise<PreparedImport> {
    validateUuid(input.importId, 'import id');
    validateDigest(input.previewDigest, 'import preview digest');
    const session = this.#sessions.get(input.importId);
    if (!session || session.claimed || session.busy) {
      throw new Error('The import preview is no longer available.');
    }
    if (new Date(session.expiresAt) <= this.#readNow()) {
      await this.cancel({ importId: input.importId });
      throw new Error('The import preview expired.');
    }
    if (!equalDigest(session.previewDigest, input.previewDigest)) {
      throw new Error('The import preview changed before it could be committed.');
    }
    this.#clearExpiry(session);
    session.busy = true;
    try {
      const packageDigest = await hashRegularFile(session.packagePath, DEFAULT_MAX_PACKAGE_BYTES);
      if (!equalDigest(packageDigest, session.packageDigest)) {
        throw new Error('The staged import changed after preview.');
      }
      const stagingDigest = await this.#hashAndValidateStaging({
        importId: session.importId,
        package: session.package,
        destinationPath: session.stagingPath,
      });
      if (!equalDigest(stagingDigest, session.stagingDigest)) {
        throw new Error('The staged import changed after preview.');
      }
      session.claimed = true;
      return toPreparedImport(session);
    } catch (error) {
      await this.#discardSessionArtifacts(session);
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async refreshClaimed(input: DataImportTargetInput): Promise<PreparedImport> {
    validateUuid(input.importId, 'import id');
    const session = this.#sessions.get(input.importId);
    if (!session || !session.claimed || session.busy) {
      throw new Error('The import has not been claimed for refresh.');
    }
    session.busy = true;
    try {
      const packageDigest = await hashRegularFile(session.packagePath, DEFAULT_MAX_PACKAGE_BYTES);
      if (!equalDigest(packageDigest, session.packageDigest)) {
        throw new Error('The claimed import changed before it could be refreshed.');
      }
      await assertNoSqliteSidecars(session.stagingPath);
      const currentDigest = await hashRegularFile(session.stagingPath, this.#maxStagingBytes);
      if (!equalDigest(currentDigest, session.stagingDigest)) {
        throw new Error('The claimed import changed before it could be refreshed.');
      }
      const context = {
        importId: session.importId,
        package: session.package,
        destinationPath: session.stagingPath,
        replaceExisting: true,
      };
      await this.#stager.stage(context);
      session.stagingDigest = await this.#hashAndValidateStaging(context);
      return toPreparedImport(session);
    } finally {
      session.busy = false;
    }
  }

  async cancel(input: { readonly importId: string }): Promise<void> {
    validateUuid(input.importId, 'import id');
    const session = this.#sessions.get(input.importId);
    if (!session) return;
    if (session.claimed || session.busy) {
      throw new Error('The import has already been claimed for replacement.');
    }
    await this.#discardSessionArtifacts(session);
  }

  async sweepExpired(): Promise<number> {
    const now = this.#readNow();
    const expired = [...this.#sessions.values()].filter(
      ({ expiresAt, claimed }) => !claimed && new Date(expiresAt) <= now,
    );
    await Promise.all(expired.map(({ importId }) => this.cancel({ importId })));
    return expired.length;
  }

  detachClaimed(input: { readonly importId: string }): void {
    validateUuid(input.importId, 'import id');
    const session = this.#sessions.get(input.importId);
    if (!session || !session.claimed || session.busy) {
      throw new Error('The import has not been claimed for replacement.');
    }
    this.#clearExpiry(session);
    this.#sessions.delete(input.importId);
  }

  async discardClaimed(input: { readonly importId: string }): Promise<void> {
    validateUuid(input.importId, 'import id');
    const session = this.#sessions.get(input.importId);
    if (!session || !session.claimed || session.busy) {
      throw new Error('The import has not been claimed for discard.');
    }
    await this.#discardSessionArtifacts(session);
  }

  async #discardSessionArtifacts(session: ImportSession): Promise<void> {
    this.#clearExpiry(session);
    if (this.#sessions.get(session.importId) === session) {
      this.#sessions.delete(session.importId);
    }
    await Promise.all([
      rm(session.packagePath, { force: true }).catch(() => undefined),
      rm(session.stagingPath, { force: true }).catch(() => undefined),
      removeSqliteSidecars(session.stagingPath),
    ]);
    await syncDirectory(this.#directory).catch(() => undefined);
  }

  async #hashAndValidateStaging(context: ImportStagingContext): Promise<string> {
    await assertNoSqliteSidecars(context.destinationPath);
    const beforeDigest = await hashRegularFile(context.destinationPath, this.#maxStagingBytes);
    await this.#stager.validate(context);
    await assertNoSqliteSidecars(context.destinationPath);
    await syncRegularFile(context.destinationPath);
    await syncDirectory(this.#directory);
    const afterDigest = await hashRegularFile(context.destinationPath, this.#maxStagingBytes);
    if (!equalDigest(beforeDigest, afterDigest)) {
      throw new Error('The staged import changed while it was being validated.');
    }
    return afterDigest;
  }
  #armExpiry(session: ImportSession): void {
    this.#clearExpiry(session);
    session.expiryTimer = setTimeout(() => {
      void this.cancel({ importId: session.importId }).catch(() => undefined);
    }, this.#sessionTtlMs);
    session.expiryTimer.unref?.();
  }

  #clearExpiry(session: ImportSession): void {
    if (session.expiryTimer === undefined) return;
    clearTimeout(session.expiryTimer);
    delete session.expiryTimer;
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(this.#directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('The import quarantine must be a real directory.');
    }
    if (process.platform !== 'win32') await chmod(this.#directory, 0o700);
  }

  #resolveFile(fileName: string): string {
    if (basename(fileName) !== fileName) {
      throw new TypeError('The import quarantine filename is invalid.');
    }
    const path = resolve(this.#directory, fileName);
    if (dirname(path) !== this.#directory) {
      throw new TypeError('The import quarantine path escaped its controlled directory.');
    }
    return path;
  }

  #createId(): string {
    const value = this.#idFactory();
    validateUuid(value, 'generated import id');
    return value.toLowerCase();
  }

  #readNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError('The import quarantine clock returned an invalid date.');
    }
    return value;
  }
}

function toPreview(
  parsed: ParsedPortablePackage,
  importId: string,
  previewDigest: string,
  expiresAt: string,
): DataImportPreview {
  const { manifest } = parsed;
  return {
    importId,
    previewDigest,
    expiresAt,
    exportedAt: manifest.exportedAt,
    sourceAppVersion: manifest.sourceAppVersion,
    sourceSchemaVersion: manifest.sourceSchemaVersion,
    currentWorkspaceName: parsed.currentWorkspaceName,
    counts: manifest.counts,
    includesArchivedData: manifest.counts.archivedWorkspaces > 0,
    includesBrowserData: manifest.counts.browserTabs > 0 || manifest.counts.browserBookmarks > 0,
  };
}

function digestPreview(importId: string, packageDigest: string, expiresAt: string): string {
  return createHash('sha256')
    .update(
      `daily-workbench-import-preview-v1\0${importId}\0${packageDigest}\0${expiresAt}`,
      'utf8',
    )
    .digest('hex');
}

function toPreparedImport(session: ImportSession): PreparedImport {
  return {
    importId: session.importId,
    packagePath: session.packagePath,
    packageDigest: session.packageDigest,
    stagingPath: session.stagingPath,
    stagingDigest: session.stagingDigest,
  };
}

async function writeDurableFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(path: string, maximumBytes: number): Promise<string> {
  const pathBefore = await lstat(path, { bigint: true });
  assertBoundedRegularFile(pathBefore, maximumBytes);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    assertBoundedRegularFile(before, maximumBytes);
    assertSameFile(before, pathBefore);
    const expectedSize = Number(before.size);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize));
    let position = 0;
    while (position < expectedSize) {
      const length = Math.min(buffer.byteLength, expectedSize - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead < 1) {
        throw new Error('An import staging artifact was truncated while being checked.');
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const growthProbe = Buffer.allocUnsafe(1);
    if ((await handle.read(growthProbe, 0, 1, expectedSize)).bytesRead !== 0) {
      throw new Error('An import staging artifact grew while being checked.');
    }
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    assertBoundedRegularFile(after, maximumBytes);
    assertBoundedRegularFile(pathAfter, maximumBytes);
    if (!sameStableStat(before, after) || !sameStableStat(after, pathAfter)) {
      throw new Error('An import staging artifact changed while it was being checked.');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function syncRegularFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size < 1) {
      throw new Error('An import staging artifact is not a regular file.');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertBoundedRegularFile(entry: BigIntStats, maximumBytes: number): void {
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.size < 1n ||
    entry.size > BigInt(maximumBytes) ||
    entry.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error('An import staging artifact is not a bounded regular file.');
  }
}

function assertSameFile(left: BigIntStats, right: BigIntStats): void {
  if (!sameStableStat(left, right)) {
    throw new Error('An import staging artifact changed before it could be checked.');
  }
}

function sameStableStat(left: BigIntStats, right: BigIntStats): boolean {
  const hasStableIdentity =
    left.dev !== 0n && left.ino !== 0n && right.dev !== 0n && right.ino !== 0n;
  return (
    (!hasStableIdentity || (left.dev === right.dev && left.ino === right.ino)) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all(
    ['-wal', '-shm', '-journal'].map((suffix) =>
      rm(`${databasePath}${suffix}`, { force: true }).catch(() => undefined),
    ),
  );
}

async function assertNoSqliteSidecars(databasePath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal'] as const) {
    await assertMissing(`${databasePath}${suffix}`);
  }
}

async function assertMissing(path: string): Promise<void> {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (entry) throw new Error('An import quarantine artifact already exists.');
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex');
  const rightBytes = Buffer.from(right, 'hex');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateUuid(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new TypeError(`The ${name} is invalid.`);
  }
}

function validateDigest(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`The ${name} is invalid.`);
  }
}
