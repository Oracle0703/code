import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { ParsedPortablePackage } from './package-format';

export const DEFAULT_MAX_IMPORT_STAGING_BYTES = 512 * 1024 * 1024;

export interface ImportStagingContext {
  readonly importId: string;
  readonly package: ParsedPortablePackage;
  readonly destinationPath: string;
  readonly replaceExisting?: boolean;
}

export interface ImportStagingDriver {
  build(packageData: ParsedPortablePackage, temporaryPath: string): Promise<void>;
  validate(stagingPath: string, packageData: ParsedPortablePackage): Promise<void>;
}

export interface ImportStager {
  stage(context: ImportStagingContext): Promise<void>;
  validate(context: ImportStagingContext): Promise<void>;
}

export interface ImportStagingDurability {
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

export interface AtomicImportStagerOptions {
  readonly directory: string;
  readonly driver: ImportStagingDriver;
  readonly idFactory?: () => string;
  readonly durability?: ImportStagingDurability;
}

export class AtomicImportStager implements ImportStager {
  readonly #directory: string;
  readonly #driver: ImportStagingDriver;
  readonly #idFactory: () => string;
  readonly #durability: ImportStagingDurability;

  constructor({
    directory,
    driver,
    idFactory = randomUUID,
    durability = DEFAULT_STAGING_DURABILITY,
  }: AtomicImportStagerOptions) {
    this.#directory = resolve(directory);
    this.#driver = driver;
    this.#idFactory = idFactory;
    this.#durability = durability;
  }

  async stage(context: ImportStagingContext): Promise<void> {
    const destination = this.#resolveDestination(context.destinationPath);
    if (context.replaceExisting !== undefined && typeof context.replaceExisting !== 'boolean') {
      throw new TypeError('The import staging replacement mode is invalid.');
    }
    const replaceExisting = context.replaceExisting === true;
    const temporaryId = this.#idFactory();
    if (!isUuid(temporaryId)) throw new TypeError('The import staging id is invalid.');
    const temporaryPath = resolve(
      this.#directory,
      `.${basename(destination)}.${temporaryId.toLowerCase()}.partial`,
    );
    if (dirname(temporaryPath) !== this.#directory) {
      throw new TypeError('The import staging path escaped its controlled directory.');
    }
    if (replaceExisting) {
      await assertRegularFile(destination);
      await assertNoSqliteSidecars(destination);
    } else {
      await assertMissing(destination);
      await assertNoSqliteSidecars(destination);
    }
    await assertMissing(temporaryPath);
    await assertNoSqliteSidecars(temporaryPath);
    let installed = false;
    try {
      await this.#driver.build(context.package, temporaryPath);
      await assertRegularFile(temporaryPath);
      await chmod(temporaryPath, 0o600);
      await this.#driver.validate(temporaryPath, context.package);
      await assertRegularFile(temporaryPath);
      await assertNoSqliteSidecars(temporaryPath);
      await this.#durability.syncFile(temporaryPath);
      if (replaceExisting) {
        await assertRegularFile(destination);
        await assertNoSqliteSidecars(destination);
      } else {
        await assertMissing(destination);
        await assertNoSqliteSidecars(destination);
      }
      await rename(temporaryPath, destination);
      installed = true;
      await this.#durability.syncDirectory(this.#directory);
      await this.#driver.validate(destination, context.package);
      await assertRegularFile(destination);
      await assertNoSqliteSidecars(destination);
      await this.#durability.syncFile(destination);
      await this.#durability.syncDirectory(this.#directory);
    } catch (error) {
      await Promise.all([
        rm(temporaryPath, { force: true }).catch(() => undefined),
        removeSqliteSidecars(temporaryPath),
        installed ? rm(destination, { force: true }).catch(() => undefined) : undefined,
        installed ? removeSqliteSidecars(destination) : undefined,
      ]);
      await this.#durability.syncDirectory(this.#directory).catch(() => undefined);
      throw error;
    }
  }

  async validate(context: ImportStagingContext): Promise<void> {
    const destination = this.#resolveDestination(context.destinationPath);
    await assertRegularFile(destination);
    await this.#driver.validate(destination, context.package);
    await assertRegularFile(destination);
    await assertNoSqliteSidecars(destination);
    await this.#durability.syncFile(destination);
    await this.#durability.syncDirectory(this.#directory);
  }

  #resolveDestination(path: string): string {
    const destination = resolve(path);
    if (
      dirname(destination) !== this.#directory ||
      !/^import-[0-9a-f-]{36}\.sqlite3$/u.test(basename(destination))
    ) {
      throw new TypeError('The import staging destination is invalid.');
    }
    return destination;
  }
}

async function assertMissing(path: string): Promise<void> {
  const entry = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (entry) throw new Error('The import staging file already exists.');
}

async function assertRegularFile(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size < 1) {
    throw new Error('The staged import is not a regular file.');
  }
}

async function assertNoSqliteSidecars(databasePath: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal'] as const) {
    await assertMissing(`${databasePath}${suffix}`);
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all(
    ['-wal', '-shm', '-journal'].map((suffix) =>
      rm(`${databasePath}${suffix}`, { force: true }).catch(() => undefined),
    ),
  );
}

async function syncRegularFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const entry = await handle.stat();
    if (!entry.isFile() || entry.size < 1) {
      throw new Error('The staged import is not a regular file.');
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

const DEFAULT_STAGING_DURABILITY: ImportStagingDurability = {
  syncFile: syncRegularFile,
  syncDirectory,
};

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
