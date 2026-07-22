import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabasePathError } from '../src/main/database/errors';
import {
  databaseFileExists,
  prepareDatabaseDirectories,
  resolveDatabasePaths,
} from '../src/main/database/paths';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
      ),
  );
});

describe('database paths', () => {
  it('resolves only controlled files beneath an absolute data directory', async () => {
    const directory = await createTemporaryDirectory();
    const paths = resolveDatabasePaths(join(directory, 'data'));
    await prepareDatabaseDirectories(paths);

    expect(paths.databasePath).toBe(join(directory, 'data', 'daily-workbench.sqlite3'));
    expect(paths.backupDirectory).toBe(join(directory, 'data', 'backups'));
    expect(await databaseFileExists(paths.databasePath)).toBe(false);
  });

  it('rejects relative, root, and path-bearing database inputs', async () => {
    expect(() => resolveDatabasePaths('relative/data')).toThrow(DatabasePathError);
    expect(() => resolveDatabasePaths(parse(process.cwd()).root)).toThrow(DatabasePathError);

    const directory = await createTemporaryDirectory();
    for (const fileName of ['../escape.sqlite3', 'nested/data.sqlite3', 'unsafe.db', '.sqlite3']) {
      expect(() => resolveDatabasePaths(directory, fileName)).toThrow(DatabasePathError);
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symbolic-link data directories and database files',
    async () => {
      const directory = await createTemporaryDirectory();
      const linkedTarget = join(directory, 'linked-target');
      const linkedData = join(directory, 'linked-data');
      await mkdir(linkedTarget);
      await symlink(linkedTarget, linkedData, 'dir');
      await expect(prepareDatabaseDirectories(resolveDatabasePaths(linkedData))).rejects.toThrow(
        DatabasePathError,
      );
      await expect(lstat(join(linkedTarget, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });

      const realData = join(directory, 'real-data');
      const realPaths = resolveDatabasePaths(realData);
      await prepareDatabaseDirectories(realPaths);

      const target = join(directory, 'target.sqlite3');
      await writeFile(target, 'not-a-database');
      await symlink(target, realPaths.databasePath, 'file');
      await expect(databaseFileExists(realPaths.databasePath)).rejects.toThrow(DatabasePathError);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'tightens existing data and backup directories to owner-only permissions',
    async () => {
      const directory = await createTemporaryDirectory();
      const paths = resolveDatabasePaths(join(directory, 'data'));
      await prepareDatabaseDirectories(paths);
      await chmod(paths.dataDirectory, 0o777);
      await chmod(paths.backupDirectory, 0o777);

      await prepareDatabaseDirectories(paths);

      expect((await stat(paths.dataDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.backupDirectory)).mode & 0o777).toBe(0o700);
    },
  );
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-paths-'));
  temporaryDirectories.push(directory);
  return directory;
}
