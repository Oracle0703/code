import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BackupManager,
  type BackupDurabilityOperations,
} from '../src/main/database/backup-manager';
import { DatabaseBackupError } from '../src/main/database/errors';
import { createNodeSqliteAdapter } from '../src/main/database/sqlite-adapter';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('BackupManager scheduled retention', () => {
  it('recognizes new reasons and deletes only excess scheduled snapshots', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-backup-retention-'));
    directories.push(dataDirectory);
    const backupDirectory = join(dataDirectory, 'backups');
    await mkdir(backupDirectory);
    const names = [
      'daily-workbench-v7-scheduled-20260720T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.sqlite3',
      'daily-workbench-v7-scheduled-20260721T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2.sqlite3',
      'daily-workbench-v7-scheduled-20260722T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3.sqlite3',
      'daily-workbench-v7-manual-20260719T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4.sqlite3',
      'daily-workbench-v7-pre-import-20260718T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5.sqlite3',
    ];
    await Promise.all(names.map((name) => writeFile(join(backupDirectory, name), 'snapshot')));
    await Promise.all([
      writeFile(join(backupDirectory, `${names[0]}-wal`), 'orphan wal'),
      writeFile(join(backupDirectory, `${names[0]}-shm`), 'orphan shm'),
      writeFile(join(backupDirectory, `${names[0]}-journal`), 'orphan journal'),
    ]);
    const syncDirectory = vi.fn(async () => undefined);
    const manager = new BackupManager({
      paths: {
        dataDirectory,
        databasePath: join(dataDirectory, 'daily-workbench.sqlite3'),
        backupDirectory,
      },
      adapterFactory: createNodeSqliteAdapter,
      validateSnapshot: () => undefined,
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
    });

    await expect(manager.list()).resolves.toHaveLength(5);
    await expect(manager.pruneScheduled(2)).resolves.toEqual({ deleted: 1, retained: 2 });
    const remaining = await readdir(backupDirectory);
    expect(remaining).toContain(names[3]);
    expect(remaining).toContain(names[4]);
    expect(remaining).not.toContain(names[0]);
    expect(remaining).not.toContain(`${names[0]}-wal`);
    expect(remaining).not.toContain(`${names[0]}-shm`);
    expect(remaining).not.toContain(`${names[0]}-journal`);
    expect(syncDirectory).toHaveBeenCalledTimes(1);
  });

  it('always retains the just-created snapshot when older names sort in the future', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-backup-clock-rollback-'));
    directories.push(dataDirectory);
    const backupDirectory = join(dataDirectory, 'backups');
    await mkdir(backupDirectory);
    const future =
      'daily-workbench-v7-scheduled-20300101T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.sqlite3';
    const current =
      'daily-workbench-v7-scheduled-20260722T020000000Z-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2.sqlite3';
    await Promise.all([
      createValidBackup(join(backupDirectory, future)),
      createValidBackup(join(backupDirectory, current)),
    ]);
    const manager = new BackupManager({
      paths: {
        dataDirectory,
        databasePath: join(dataDirectory, 'daily-workbench.sqlite3'),
        backupDirectory,
      },
      adapterFactory: createNodeSqliteAdapter,
      validateSnapshot: () => undefined,
    });

    await expect(
      manager.pruneScheduled(1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'),
    ).resolves.toEqual({ deleted: 1, retained: 1 });
    await expect(readdir(backupDirectory)).resolves.toEqual([current]);
  });

  it('does not delete an older backup when the protected snapshot disappears after validation', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-backup-protected-race-'));
    directories.push(dataDirectory);
    const backupDirectory = join(dataDirectory, 'backups');
    await mkdir(backupDirectory);
    const older =
      'daily-workbench-v7-scheduled-20260721T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.sqlite3';
    const protectedName =
      'daily-workbench-v7-scheduled-20260722T020000000Z-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2.sqlite3';
    const protectedPath = join(backupDirectory, protectedName);
    await Promise.all([
      createValidBackup(join(backupDirectory, older)),
      createValidBackup(protectedPath),
    ]);
    let validations = 0;
    const manager = new BackupManager({
      paths: {
        dataDirectory,
        databasePath: join(dataDirectory, 'daily-workbench.sqlite3'),
        backupDirectory,
      },
      adapterFactory: createNodeSqliteAdapter,
      validateSnapshot: () => {
        validations += 1;
        if (validations === 3) {
          queueMicrotask(() => rmSync(protectedPath));
        }
      },
    });

    await expect(
      manager.pruneScheduled(1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'),
    ).rejects.toBeInstanceOf(DatabaseBackupError);
    expect(validations).toBe(3);
    expect(await readdir(backupDirectory)).toContain(older);
  });

  it('syncs completed retention deletions even when a later sidecar unlink fails', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-backup-partial-prune-'));
    directories.push(dataDirectory);
    const backupDirectory = join(dataDirectory, 'backups');
    await mkdir(backupDirectory);
    const older =
      'daily-workbench-v7-scheduled-20260721T020000000Z-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.sqlite3';
    const current =
      'daily-workbench-v7-scheduled-20260722T020000000Z-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2.sqlite3';
    await Promise.all([
      createValidBackup(join(backupDirectory, older)),
      createValidBackup(join(backupDirectory, current)),
    ]);
    await mkdir(join(backupDirectory, `${older}-wal`));
    await writeFile(join(backupDirectory, `${older}-shm`), 'orphan shm');
    const syncDirectory = vi.fn(async () => undefined);
    const manager = new BackupManager({
      paths: {
        dataDirectory,
        databasePath: join(dataDirectory, 'daily-workbench.sqlite3'),
        backupDirectory,
      },
      adapterFactory: createNodeSqliteAdapter,
      validateSnapshot: () => undefined,
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
    });

    await expect(manager.pruneScheduled(1)).rejects.toBeInstanceOf(DatabaseBackupError);
    expect(syncDirectory).toHaveBeenCalledTimes(1);
    const remaining = await readdir(backupDirectory);
    expect(remaining).not.toContain(older);
    expect(remaining).not.toContain(`${older}-shm`);
    expect(remaining).toContain(`${older}-wal`);
    expect(remaining).toContain(current);
  });
});

describe('BackupManager durable publication', () => {
  it('syncs and revalidates a backup before publishing it durably', async () => {
    const order: string[] = [];
    const context = await createBackupContext({
      durability: {
        syncFile: async (path) => {
          order.push('sync-file');
          await syncFile(path);
        },
        syncDirectory: async (path) => {
          order.push('sync-directory');
          await syncDirectory(path);
        },
      },
      onValidate: () => order.push('validate'),
    });
    try {
      const backup = await context.manager.create(context.source, 'pre-import', 0);

      expect(order).toEqual(['validate', 'sync-file', 'validate', 'sync-directory']);
      await expect(readdir(context.backupDirectory)).resolves.toEqual([backup.fileName]);
      await expect(
        context.manager.validateReference(backup.id, 'pre-import'),
      ).resolves.toMatchObject({
        id: backup.id,
        reason: 'pre-import',
        schemaVersion: 0,
        sizeBytes: backup.sizeBytes,
      });
    } finally {
      context.source.close();
    }
  });

  it('removes a partial backup when the file fsync fails', async () => {
    const syncDirectory = vi.fn(async () => undefined);
    const context = await createBackupContext({
      durability: {
        syncFile: async () => {
          throw new Error('injected file fsync failure');
        },
        syncDirectory,
      },
    });
    try {
      await expect(context.manager.create(context.source, 'pre-import', 0)).rejects.toBeInstanceOf(
        DatabaseBackupError,
      );
      expect(syncDirectory).toHaveBeenCalledTimes(1);
      await expect(readdir(context.backupDirectory)).resolves.toEqual([]);
    } finally {
      context.source.close();
    }
  });

  it('removes a published target whose final SQLite validation fails', async () => {
    let validations = 0;
    let backupDirectory = '';
    const syncDirectory = vi.fn(async () => undefined);
    const context = await createBackupContext({
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
      onValidate: () => {
        validations += 1;
        if (validations === 2) {
          const destinationName = readdirSync(backupDirectory).find((name) =>
            name.endsWith('.sqlite3'),
          );
          expect(destinationName).toBeDefined();
          for (const suffix of ['-wal', '-shm', '-journal']) {
            writeFileSync(join(backupDirectory, `${destinationName}${suffix}`), suffix);
          }
          throw new Error('injected final validation failure');
        }
      },
    });
    backupDirectory = context.backupDirectory;
    try {
      await expect(context.manager.create(context.source, 'pre-import', 0)).rejects.toBeInstanceOf(
        DatabaseBackupError,
      );
      expect(syncDirectory).toHaveBeenCalledTimes(1);
      await expect(readdir(context.backupDirectory)).resolves.toEqual([]);
    } finally {
      context.source.close();
    }
  });

  it('keeps a verified backup discoverable when directory fsync reports failure', async () => {
    const context = await createBackupContext({
      durability: {
        syncFile: async () => undefined,
        syncDirectory: async () => {
          throw new Error('injected directory fsync failure');
        },
      },
    });
    try {
      await expect(context.manager.create(context.source, 'pre-import', 0)).rejects.toBeInstanceOf(
        DatabaseBackupError,
      );
      const [backup] = await context.manager.list();
      expect(backup).toMatchObject({ reason: 'pre-import', schemaVersion: 0 });
      await expect(context.manager.validateReference(backup.id, 'pre-import')).resolves.toEqual(
        backup,
      );
    } finally {
      context.source.close();
    }
  });

  it('cleans read-only WAL sidecars after a successful referenced-backup validation', async () => {
    const syncDirectory = vi.fn(async () => undefined);
    const context = await createBackupContext({
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
      walMode: true,
    });
    try {
      const backup = await context.manager.create(context.source, 'pre-import', 0);
      await expect(readdir(context.backupDirectory)).resolves.toEqual([backup.fileName]);
      const syncsBeforeReference = syncDirectory.mock.calls.length;

      await expect(
        context.manager.validateReference(backup.id, 'pre-import'),
      ).resolves.toMatchObject({
        id: backup.id,
        fileName: backup.fileName,
      });
      await expect(readdir(context.backupDirectory)).resolves.toEqual([backup.fileName]);
      expect(syncDirectory).toHaveBeenCalledTimes(syncsBeforeReference + 1);
    } finally {
      context.source.close();
    }
  });

  it('cleans read-only WAL sidecars after referenced-backup validation fails', async () => {
    let failReferenceValidation = false;
    const syncDirectory = vi.fn(async () => undefined);
    const context = await createBackupContext({
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
      onValidate: () => {
        if (failReferenceValidation) throw new Error('injected reference validation failure');
      },
      walMode: true,
    });
    try {
      const backup = await context.manager.create(context.source, 'pre-import', 0);
      failReferenceValidation = true;
      const syncsBeforeReference = syncDirectory.mock.calls.length;

      await expect(
        context.manager.validateReference(backup.id, 'pre-import'),
      ).rejects.toBeInstanceOf(DatabaseBackupError);
      await expect(readdir(context.backupDirectory)).resolves.toEqual([backup.fileName]);
      expect(syncDirectory).toHaveBeenCalledTimes(syncsBeforeReference + 1);
    } finally {
      context.source.close();
    }
  });

  it('does not delete sidecars that existed before referenced-backup validation', async () => {
    const syncDirectory = vi.fn(async () => undefined);
    const context = await createBackupContext({
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
      walMode: true,
    });
    try {
      const backup = await context.manager.create(context.source, 'pre-import', 0);
      const walPath = join(context.backupDirectory, `${backup.fileName}-wal`);
      const shmPath = join(context.backupDirectory, `${backup.fileName}-shm`);
      await Promise.all([
        writeFile(walPath, 'external wal data'),
        writeFile(shmPath, 'external shm'),
      ]);
      const syncsBeforeReference = syncDirectory.mock.calls.length;

      await expect(
        context.manager.validateReference(backup.id, 'pre-import'),
      ).rejects.toBeInstanceOf(DatabaseBackupError);
      await expect(readdir(context.backupDirectory)).resolves.toEqual([
        backup.fileName,
        `${backup.fileName}-shm`,
        `${backup.fileName}-wal`,
      ]);
      await expect(readFile(walPath, 'utf8')).resolves.toBe('external wal data');
      await expect(readFile(shmPath, 'utf8')).resolves.toBe('external shm');
      expect(syncDirectory).toHaveBeenCalledTimes(syncsBeforeReference);
    } finally {
      context.source.close();
    }
  });

  it('fails conservatively when a real WAL appears after referenced-backup validation', async () => {
    let injectConcurrentWal = false;
    let walPath = '';
    const syncDirectory = vi.fn(async () => undefined);
    const context = await createBackupContext({
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
      onValidate: () => {
        if (!injectConcurrentWal) return;
        queueMicrotask(() => {
          writeFileSync(walPath, 'concurrent external wal data');
        });
      },
      walMode: true,
    });
    try {
      const backup = await context.manager.create(context.source, 'pre-import', 0);
      walPath = join(context.backupDirectory, `${backup.fileName}-wal`);
      injectConcurrentWal = true;
      const syncsBeforeReference = syncDirectory.mock.calls.length;

      await expect(
        context.manager.validateReference(backup.id, 'pre-import'),
      ).rejects.toBeInstanceOf(DatabaseBackupError);
      await expect(readFile(walPath, 'utf8')).resolves.toBe('concurrent external wal data');
      expect(syncDirectory).toHaveBeenCalledTimes(syncsBeforeReference);
    } finally {
      context.source.close();
    }
  });
});

async function createBackupContext({
  durability,
  onValidate = () => undefined,
  walMode = false,
}: {
  readonly durability: BackupDurabilityOperations;
  readonly onValidate?: () => void;
  readonly walMode?: boolean;
}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-backup-create-'));
  directories.push(dataDirectory);
  const backupDirectory = join(dataDirectory, 'backups');
  await mkdir(backupDirectory);
  const source = createNodeSqliteAdapter(join(dataDirectory, 'source.sqlite3'));
  source.open();
  if (walMode) source.exec('PRAGMA journal_mode = WAL;');
  source.exec(`
    CREATE TABLE backup_probe (value TEXT NOT NULL) STRICT;
    INSERT INTO backup_probe (value) VALUES ('durable');
  `);
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'];
  const manager = new BackupManager({
    paths: {
      dataDirectory,
      databasePath: join(dataDirectory, 'daily-workbench.sqlite3'),
      backupDirectory,
    },
    adapterFactory: createNodeSqliteAdapter,
    validateSnapshot: (database, schemaVersion) => {
      expect(schemaVersion).toBe(0);
      expect(database.get<{ value: string }>('SELECT value FROM backup_probe')).toEqual({
        value: 'durable',
      });
      onValidate();
    },
    now: () => new Date('2026-07-23T12:00:00.000Z'),
    idFactory: () => ids.shift() ?? 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    durability,
  });
  return { backupDirectory, manager, source };
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

async function createValidBackup(path: string): Promise<void> {
  const database = createNodeSqliteAdapter(path);
  try {
    database.open();
    database.exec(`
      CREATE TABLE backup_probe (value TEXT NOT NULL) STRICT;
      INSERT INTO backup_probe (value) VALUES ('valid');
    `);
  } finally {
    database.close();
  }
}
