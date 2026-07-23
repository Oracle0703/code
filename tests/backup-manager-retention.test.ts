import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
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
    const manager = new BackupManager({
      paths: {
        dataDirectory,
        databasePath: join(dataDirectory, 'daily-workbench.sqlite3'),
        backupDirectory,
      },
      adapterFactory: createNodeSqliteAdapter,
      validateSnapshot: () => undefined,
    });

    await expect(manager.list()).resolves.toHaveLength(5);
    await expect(manager.pruneScheduled(2)).resolves.toEqual({ deleted: 1, retained: 2 });
    const remaining = await readdir(backupDirectory);
    expect(remaining).toContain(names[3]);
    expect(remaining).toContain(names[4]);
    expect(remaining).not.toContain(names[0]);
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
    const context = await createBackupContext({
      durability: {
        syncFile: async () => {
          throw new Error('injected file fsync failure');
        },
        syncDirectory: async () => undefined,
      },
    });
    try {
      await expect(context.manager.create(context.source, 'pre-import', 0)).rejects.toBeInstanceOf(
        DatabaseBackupError,
      );
      await expect(readdir(context.backupDirectory)).resolves.toEqual([]);
    } finally {
      context.source.close();
    }
  });

  it('removes a published target whose final SQLite validation fails', async () => {
    let validations = 0;
    const syncDirectory = vi.fn(async () => undefined);
    const context = await createBackupContext({
      durability: {
        syncFile: async () => undefined,
        syncDirectory,
      },
      onValidate: () => {
        validations += 1;
        if (validations === 2) throw new Error('injected final validation failure');
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
});

async function createBackupContext({
  durability,
  onValidate = () => undefined,
}: {
  readonly durability: BackupDurabilityOperations;
  readonly onValidate?: () => void;
}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-backup-create-'));
  directories.push(dataDirectory);
  const backupDirectory = join(dataDirectory, 'backups');
  await mkdir(backupDirectory);
  const source = createNodeSqliteAdapter(join(dataDirectory, 'source.sqlite3'));
  source.open();
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
      onValidate();
      expect(schemaVersion).toBe(0);
      expect(database.get<{ value: string }>('SELECT value FROM backup_probe')).toEqual({
        value: 'durable',
      });
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
