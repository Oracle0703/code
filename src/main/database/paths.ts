import { chmod, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve } from 'node:path';
import { DatabasePathError } from './errors';
import type { DatabasePaths } from './types';

const DEFAULT_DATABASE_FILE = 'daily-workbench.sqlite3';
const SAFE_DATABASE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.sqlite3?$/;

function assertContained(parent: string, candidate: string, label: string): void {
  if (dirname(candidate) !== parent) {
    throw new DatabasePathError(`${label} must stay inside the application data directory.`);
  }
}

export function resolveDatabasePaths(
  dataDirectory: string,
  databaseFileName = DEFAULT_DATABASE_FILE,
): DatabasePaths {
  if (!isAbsolute(dataDirectory)) {
    throw new DatabasePathError('The application data directory must be an absolute path.');
  }

  const resolvedDataDirectory = resolve(dataDirectory);
  if (resolvedDataDirectory === parse(resolvedDataDirectory).root) {
    throw new DatabasePathError(
      'The filesystem root cannot be used as the application data directory.',
    );
  }

  if (
    basename(databaseFileName) !== databaseFileName ||
    !SAFE_DATABASE_FILE.test(databaseFileName)
  ) {
    throw new DatabasePathError(
      'The database filename must be a plain .sqlite or .sqlite3 filename without path segments.',
    );
  }

  const databasePath = resolve(resolvedDataDirectory, databaseFileName);
  const backupDirectory = resolve(resolvedDataDirectory, 'backups');
  assertContained(resolvedDataDirectory, databasePath, 'The database path');
  assertContained(resolvedDataDirectory, backupDirectory, 'The backup directory');

  return {
    dataDirectory: resolvedDataDirectory,
    databasePath,
    backupDirectory,
  };
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new DatabasePathError(`${label} must be a real directory, not a file or symbolic link.`);
  }
}

async function restrictDirectory(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(path, 0o700);
  }
}

export async function prepareDatabaseDataDirectory(paths: DatabasePaths): Promise<void> {
  try {
    await mkdir(paths.dataDirectory, { recursive: true, mode: 0o700 });
    await assertDirectory(paths.dataDirectory, 'The application data path');
    await restrictDirectory(paths.dataDirectory);
  } catch (error) {
    if (error instanceof DatabasePathError) {
      throw error;
    }
    throw new DatabasePathError('The database data directory could not be prepared.', {
      cause: error,
    });
  }
}

export async function prepareDatabaseBackupDirectory(paths: DatabasePaths): Promise<void> {
  try {
    const backupEntry = await lstat(paths.backupDirectory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });

    if (backupEntry) {
      if (!backupEntry.isDirectory() || backupEntry.isSymbolicLink()) {
        throw new DatabasePathError(
          'The backup path must be a real directory, not a file or symbolic link.',
        );
      }
    } else {
      await mkdir(paths.backupDirectory, { mode: 0o700 });
    }
    await assertDirectory(paths.backupDirectory, 'The backup path');
    await restrictDirectory(paths.backupDirectory);
  } catch (error) {
    if (error instanceof DatabasePathError) {
      throw error;
    }
    throw new DatabasePathError('The database backup directory could not be prepared.', {
      cause: error,
    });
  }
}

export async function prepareDatabaseDirectories(paths: DatabasePaths): Promise<void> {
  await prepareDatabaseDataDirectory(paths);
  await prepareDatabaseBackupDirectory(paths);
}

export async function databaseFileExists(databasePath: string): Promise<boolean> {
  try {
    const entry = await lstat(databasePath);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new DatabasePathError('The database path must be a regular file.');
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    if (error instanceof DatabasePathError) {
      throw error;
    }
    throw new DatabasePathError('The database file could not be inspected.', { cause: error });
  }
}
