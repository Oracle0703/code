import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReplacementMarkerStore } from '../src/main/data-portability';
import {
  cleanupAbandonedImportArtifacts,
  DatabaseReplacementRecovery,
  FileReplacementMarkerPersistence,
} from '../src/main/data-management';

const temporaryDirectories: string[] = [];
const REPLACEMENT_ID = '11111111-1111-4111-8111-111111111111';
const BACKUP_ID = '22222222-2222-4222-8222-222222222222';
const WRITE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-07-23T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('database replacement files', () => {
  it('atomically installs a verified staged database and cleans terminal artifacts', async () => {
    const context = await createContext();
    const checkpoint = vi.fn(async () => undefined);
    const validate = vi.fn(async () => {
      expect(await readFile(context.databasePath, 'utf8')).toBe('new database');
    });
    const validateBackup = vi.fn(async (backupId: string) => {
      expect(backupId).toBe(BACKUP_ID);
    });
    const validateRecovery = vi.fn(async (fileName: string) => {
      expect(await readFile(join(context.dataDirectory, fileName), 'utf8')).toBe('old database');
    });
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: checkpoint,
      validateInstalledDatabase: validate,
      validatePreImportBackup: validateBackup,
      validateRecoveryDatabase: validateRecovery,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toEqual({
      outcome: 'committed',
      preImportBackupId: BACKUP_ID,
    });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(3);
    expect(validateBackup).toHaveBeenCalledTimes(2);
    expect(validateRecovery).toHaveBeenCalledTimes(2);
    expect(await readFile(context.databasePath, 'utf8')).toBe('new database');
    await expect(context.persistence.read()).resolves.toBeUndefined();
    await expect(readFile(context.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(context.rollbackPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await readFile(
        join(context.dataDirectory, `pre-import-recovery-${REPLACEMENT_ID}.sqlite3`),
        'utf8',
      ),
    ).toBe('old database');
    await expect(readFile(context.packagePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the original database when installed validation fails', async () => {
    const context = await createContext();
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => {
        if ((await readFile(context.databasePath, 'utf8')) === 'new database') {
          throw new Error('invalid staged database');
        }
      },
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
    await expect(context.persistence.read()).resolves.toBeUndefined();
  });

  it('abandons a ready replacement when its pre-import backup is unavailable', async () => {
    const context = await createContext();
    const checkpoint = vi.fn(async () => undefined);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: checkpoint,
      validateInstalledDatabase: async () => {
        expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
      },
      validatePreImportBackup: async () => {
        throw new Error('pre-import backup is missing');
      },
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('recognizes a crash after the old database move but before its phase write', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    const checkpoint = vi.fn(async () => undefined);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: checkpoint,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'committed' });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(await readFile(context.databasePath, 'utf8')).toBe('new database');
  });

  it('recognizes an installed database when the ready marker update was lost', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await rename(context.stagingPath, context.databasePath);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'committed' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('new database');
  });

  it('prefers rollback when a ready marker sees both databases and stale staging', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await writeFile(context.databasePath, 'uncertain installed database');
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('replays an old-database move when its phase marker persisted first', async () => {
    const context = await createContext();
    await context.store.transition('ready', 'old-moved', NOW);
    const checkpoint = vi.fn(async () => undefined);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: checkpoint,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'committed' });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(await readFile(context.databasePath, 'utf8')).toBe('new database');
  });

  it('safely abandons a ready marker whose staging file was not durable', async () => {
    const context = await createContext();
    await rm(context.stagingPath);
    const checkpoint = vi.fn(async () => undefined);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: checkpoint,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
    await expect(context.persistence.read()).resolves.toBeUndefined();
  });

  it('restores a moved original when a ready marker has no staged database', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await rm(context.stagingPath);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
    await expect(context.persistence.read()).resolves.toBeUndefined();
  });

  it('restores a moved original when ready staging no longer matches its marker', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await writeFile(context.stagingPath, 'tampered staged database');
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('rolls back an old-moved marker when staging is invalid before the move', async () => {
    const context = await createContext();
    await context.store.transition('ready', 'old-moved', NOW);
    await writeFile(context.stagingPath, 'tampered staged database');
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('finishes rollback when old-moved persisted but staging disappeared after the move', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rm(context.stagingPath);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('prefers rollback when old-moved has both databases and stale staging', async () => {
    const context = await createContext();
    await context.store.transition('ready', 'old-moved', NOW);
    await writeFile(context.rollbackPath, 'old database');
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('rolls back a mismatched installed file after a crash before its phase write', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await writeFile(context.databasePath, 'different valid database');
    const validate = vi.fn(async () => {
      expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
    });
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: validate,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('does not commit a validated marker when the installed database disappeared', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'validated', NOW);
    await rm(context.databasePath);
    const validate = vi.fn(async () => {
      expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
    });
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: validate,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('rolls back a validated replacement when its pre-import backup disappeared', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'validated', NOW);
    const validateBackup = vi.fn(async () => {
      throw new Error('pre-import backup is missing');
    });
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: validateBackup,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(validateBackup).toHaveBeenCalledExactlyOnceWith(BACKUP_ID);
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('rechecks a committed marker before deleting the only rollback database', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'validated', NOW);
    await context.store.transition('validated', 'committed', NOW);
    await writeFile(context.databasePath, 'tampered installed database');
    const validate = vi.fn(async () => {
      expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
    });
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: validate,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it('does not reconsult the original backup after replacement is committed', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'validated', NOW);
    await context.store.transition('validated', 'committed', NOW);
    const validateBackup = vi.fn(async () => {
      throw new Error('pre-import backup is corrupt');
    });
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: validateBackup,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'committed' });
    expect(validateBackup).not.toHaveBeenCalled();
    expect(await readFile(context.databasePath, 'utf8')).toBe('new database');
    expect(
      await readFile(
        join(context.dataDirectory, `pre-import-recovery-${REPLACEMENT_ID}.sqlite3`),
        'utf8',
      ),
    ).toBe('old database');
  });

  it('publishes the rollback as a retained recovery copy after backup validation', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'validated', NOW);
    let originalBackupStillAvailable = true;
    const recoveryFileName = `pre-import-recovery-${REPLACEMENT_ID}.sqlite3`;
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => {
        expect(originalBackupStillAvailable).toBe(true);
        originalBackupStillAvailable = false;
      },
      validateRecoveryDatabase: async (fileName) => {
        expect(await readFile(join(context.dataDirectory, fileName), 'utf8')).toBe('old database');
      },
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'committed' });
    expect(originalBackupStillAvailable).toBe(false);
    expect(await readFile(join(context.dataDirectory, recoveryFileName), 'utf8')).toBe(
      'old database',
    );
    await expect(readFile(context.rollbackPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes committed cleanup after the retained rollback rename persisted first', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'validated', NOW);
    await context.store.transition('validated', 'committed', NOW);
    const recoveryFileName = `pre-import-recovery-${REPLACEMENT_ID}.sqlite3`;
    await rename(context.rollbackPath, join(context.dataDirectory, recoveryFileName));
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => {
        throw new Error('the original pre-import backup disappeared');
      },
      validateRecoveryDatabase: async (fileName) => {
        expect(fileName).toBe(recoveryFileName);
      },
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'committed' });
    await expect(context.persistence.read()).resolves.toBeUndefined();
    expect(await readFile(join(context.dataDirectory, recoveryFileName), 'utf8')).toBe(
      'old database',
    );
  });

  it('restores retained recovery when the committed database disappears', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'validated', NOW);
    await context.store.transition('validated', 'committed', NOW);
    const recoveryFileName = `pre-import-recovery-${REPLACEMENT_ID}.sqlite3`;
    const recoveryPath = join(context.dataDirectory, recoveryFileName);
    await rename(context.rollbackPath, recoveryPath);
    await rm(context.databasePath);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => {
        expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
      },
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async (fileName) => {
        expect(fileName).toBe(recoveryFileName);
        expect(await readFile(recoveryPath, 'utf8')).toBe('old database');
      },
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    await expect(readFile(context.databasePath, 'utf8')).resolves.toBe('old database');
    await expect(readFile(recoveryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(context.persistence.read()).resolves.toBeUndefined();
  });

  it('finishes a rollback when the rolled-back marker persisted before its rename', async () => {
    const context = await createContext();
    await rename(context.databasePath, context.rollbackPath);
    await context.store.transition('ready', 'old-moved', NOW);
    await rename(context.stagingPath, context.databasePath);
    await context.store.transition('old-moved', 'new-installed', NOW);
    await context.store.transition('new-installed', 'rolling-back', NOW);
    await context.store.transition('rolling-back', 'rolled-back', NOW);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
    expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
  });

  it.each(['ready', 'rolling-back', 'rolled-back'] as const)(
    'preserves the current database when a %s marker references a corrupt rollback',
    async (phase) => {
      const context = await createContext();
      await writeFile(context.rollbackPath, 'corrupt rollback database');
      if (phase === 'rolling-back' || phase === 'rolled-back') {
        await context.store.transition('ready', 'old-moved', NOW);
        await context.store.transition('old-moved', 'new-installed', NOW);
        await context.store.transition('new-installed', 'rolling-back', NOW);
      }
      if (phase === 'rolled-back') {
        await context.store.transition('rolling-back', 'rolled-back', NOW);
      }
      const validateInstalled = vi.fn(async () => undefined);
      const recovery = new DatabaseReplacementRecovery({
        dataDirectory: context.dataDirectory,
        markerStore: context.store,
        checkpointCurrentDatabase: async () => undefined,
        validateInstalledDatabase: validateInstalled,
        validatePreImportBackup: async () => undefined,
        validateRecoveryDatabase: async (fileName) => {
          expect(fileName).toBe(`rollback-${REPLACEMENT_ID}.sqlite3`);
          expect(await readFile(context.rollbackPath, 'utf8')).toBe('corrupt rollback database');
          throw new Error('rollback validation failed');
        },
        now: () => new Date(NOW),
      });

      await expect(recovery.recover()).rejects.toThrow(/rollback validation failed/u);
      expect(validateInstalled).not.toHaveBeenCalled();
      await expect(readFile(context.databasePath, 'utf8')).resolves.toBe('old database');
      await expect(readFile(context.rollbackPath, 'utf8')).resolves.toBe(
        'corrupt rollback database',
      );
      await expect(context.store.read()).resolves.toMatchObject({
        phase: phase === 'ready' ? 'rolled-back' : phase,
      });
    },
  );

  it.each(['ready', 'rolling-back', 'rolled-back'] as const)(
    'preserves the current database when a %s rollback disappears after validation',
    async (phase) => {
      const context = await createContext();
      await writeFile(context.rollbackPath, 'validated rollback database');
      if (phase === 'rolling-back' || phase === 'rolled-back') {
        await context.store.transition('ready', 'old-moved', NOW);
        await context.store.transition('old-moved', 'new-installed', NOW);
        await context.store.transition('new-installed', 'rolling-back', NOW);
      }
      if (phase === 'rolled-back') {
        await context.store.transition('rolling-back', 'rolled-back', NOW);
      }
      const recovery = new DatabaseReplacementRecovery({
        dataDirectory: context.dataDirectory,
        markerStore: context.store,
        checkpointCurrentDatabase: async () => undefined,
        validateInstalledDatabase: async () => undefined,
        validatePreImportBackup: async () => undefined,
        validateRecoveryDatabase: async (fileName) => {
          expect(fileName).toBe(`rollback-${REPLACEMENT_ID}.sqlite3`);
          expect(await readFile(context.rollbackPath, 'utf8')).toBe('validated rollback database');
          await rm(context.rollbackPath);
        },
        now: () => new Date(NOW),
      });

      await expect(recovery.recover()).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(context.databasePath, 'utf8')).resolves.toBe('old database');
      await expect(context.store.read()).resolves.toMatchObject({
        phase: phase === 'ready' ? 'rolled-back' : phase,
      });
    },
  );

  it('preserves the current database when retained recovery disappears after validation', async () => {
    const context = await createContext();
    await context.store.transition('ready', 'rolled-back', NOW);
    const recoveryFileName = `pre-import-recovery-${REPLACEMENT_ID}.sqlite3`;
    const recoveryPath = join(context.dataDirectory, recoveryFileName);
    await writeFile(recoveryPath, 'validated retained recovery database');
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: context.dataDirectory,
      markerStore: context.store,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async (fileName) => {
        expect(fileName).toBe(recoveryFileName);
        expect(await readFile(recoveryPath, 'utf8')).toBe('validated retained recovery database');
        await rm(recoveryPath);
      },
      now: () => new Date(NOW),
    });

    await expect(recovery.recover()).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(context.databasePath, 'utf8')).resolves.toBe('old database');
    await expect(context.store.read()).resolves.toMatchObject({ phase: 'rolled-back' });
  });

  it.each(['rolling-back', 'rolled-back'] as const)(
    'restores a retained recovery copy from the %s phase',
    async (phase) => {
      const context = await createContext();
      await rename(context.databasePath, context.rollbackPath);
      await context.store.transition('ready', 'old-moved', NOW);
      await rename(context.stagingPath, context.databasePath);
      await context.store.transition('old-moved', 'new-installed', NOW);
      await context.store.transition('new-installed', 'rolling-back', NOW);
      if (phase === 'rolled-back') {
        await context.store.transition('rolling-back', 'rolled-back', NOW);
      }
      const recoveryFileName = `pre-import-recovery-${REPLACEMENT_ID}.sqlite3`;
      const recoveryPath = join(context.dataDirectory, recoveryFileName);
      await rename(context.rollbackPath, recoveryPath);
      const recovery = new DatabaseReplacementRecovery({
        dataDirectory: context.dataDirectory,
        markerStore: context.store,
        checkpointCurrentDatabase: async () => undefined,
        validateInstalledDatabase: async () => {
          expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
        },
        validatePreImportBackup: async () => undefined,
        validateRecoveryDatabase: async (fileName) => {
          expect(fileName).toBe(recoveryFileName);
          expect(await readFile(recoveryPath, 'utf8')).toBe('old database');
        },
        now: () => new Date(NOW),
      });

      await expect(recovery.recover()).resolves.toMatchObject({ outcome: 'rolled-back' });
      expect(await readFile(context.databasePath, 'utf8')).toBe('old database');
      await expect(readFile(recoveryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects a marker containing malformed UTF-8', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-marker-utf8-'));
    temporaryDirectories.push(dataDirectory);
    await writeFile(
      join(dataDirectory, 'database-replacement-v1.json'),
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0x80, 0x22, 0x7d, 0x0a]),
    );
    const persistence = new FileReplacementMarkerPersistence({ dataDirectory });

    await expect(persistence.read()).rejects.toThrow(/encoding is invalid/u);
  });

  it('restores a unique orphaned rollback before abandoned import cleanup', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-orphan-rollback-'));
    temporaryDirectories.push(dataDirectory);
    const rollbackPath = join(dataDirectory, `rollback-${REPLACEMENT_ID}.sqlite3`);
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    await writeFile(rollbackPath, 'old database');
    const markerStore = new ReplacementMarkerStore(
      new FileReplacementMarkerPersistence({ dataDirectory }),
    );
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory,
      markerStore,
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => {
        expect(await readFile(databasePath, 'utf8')).toBe('old database');
      },
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
    });

    await expect(recovery.recover()).resolves.toEqual({ outcome: 'rolled-back' });
    expect(await readFile(databasePath, 'utf8')).toBe('old database');
    await expect(readFile(rollbackPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('hard-stops when a markerless database and rollback are both present', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-orphan-ambiguous-'));
    temporaryDirectories.push(dataDirectory);
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const rollbackPath = join(dataDirectory, `rollback-${REPLACEMENT_ID}.sqlite3`);
    await Promise.all([
      writeFile(databasePath, 'visible database'),
      writeFile(rollbackPath, 'old database'),
    ]);
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory,
      markerStore: new ReplacementMarkerStore(
        new FileReplacementMarkerPersistence({ dataDirectory }),
      ),
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => undefined,
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
    });

    await expect(recovery.recover()).rejects.toThrow(/automatic recovery is ambiguous/u);
    expect(await readFile(databasePath, 'utf8')).toBe('visible database');
    expect(await readFile(rollbackPath, 'utf8')).toBe('old database');
  });

  it('returns an invalid orphaned rollback to its recoverable filename', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-orphan-invalid-'));
    temporaryDirectories.push(dataDirectory);
    const rollbackPath = join(dataDirectory, `rollback-${REPLACEMENT_ID}.sqlite3`);
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    await writeFile(rollbackPath, 'invalid old database');
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory,
      markerStore: new ReplacementMarkerStore(
        new FileReplacementMarkerPersistence({ dataDirectory }),
      ),
      checkpointCurrentDatabase: async () => undefined,
      validateInstalledDatabase: async () => {
        throw new Error('rollback validation failed');
      },
      validatePreImportBackup: async () => undefined,
      validateRecoveryDatabase: async () => undefined,
    });

    await expect(recovery.recover()).rejects.toThrow(/rollback validation failed/u);
    expect(await readFile(rollbackPath, 'utf8')).toBe('invalid old database');
    await expect(readFile(databasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a completely absent data directory as a clean first launch', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'daily-workbench-fresh-parent-'));
    temporaryDirectories.push(parent);
    const missingDataDirectory = join(parent, 'data');
    const recovery = new DatabaseReplacementRecovery({
      dataDirectory: missingDataDirectory,
      markerStore: new ReplacementMarkerStore(
        new FileReplacementMarkerPersistence({
          dataDirectory: missingDataDirectory,
        }),
      ),
      checkpointCurrentDatabase: async () => {
        throw new Error('fresh launch must not checkpoint');
      },
      validateInstalledDatabase: async () => {
        throw new Error('fresh launch must not validate');
      },
      validatePreImportBackup: async () => {
        throw new Error('fresh launch must not validate a backup');
      },
      validateRecoveryDatabase: async () => {
        throw new Error('fresh launch must not validate recovery data');
      },
    });

    await expect(recovery.recover()).resolves.toEqual({ outcome: 'none' });
    await expect(cleanupAbandonedImportArtifacts(missingDataDirectory)).resolves.toBe(0);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a symbolic-link data directory before reading a marker',
    async () => {
      const parent = await mkdtemp(join(tmpdir(), 'daily-workbench-recovery-symlink-'));
      temporaryDirectories.push(parent);
      const target = join(parent, 'target');
      const linkedData = join(parent, 'data');
      await mkdir(target);
      await writeFile(join(target, 'database-replacement-v1.json'), '{}\n');
      await symlink(target, linkedData, 'dir');
      const recovery = new DatabaseReplacementRecovery({
        dataDirectory: linkedData,
        markerStore: new ReplacementMarkerStore(
          new FileReplacementMarkerPersistence({ dataDirectory: linkedData }),
        ),
        checkpointCurrentDatabase: async () => undefined,
        validateInstalledDatabase: async () => undefined,
        validatePreImportBackup: async () => undefined,
        validateRecoveryDatabase: async () => undefined,
      });

      await expect(recovery.recover()).rejects.toThrow(/not a real directory/u);
      expect(await readFile(join(target, 'database-replacement-v1.json'), 'utf8')).toBe('{}\n');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects an import-directory symlink before following staged paths',
    async () => {
      const context = await createContext();
      const importDirectory = join(context.dataDirectory, 'imports');
      const outside = await mkdtemp(join(tmpdir(), 'daily-workbench-outside-imports-'));
      temporaryDirectories.push(outside);
      await rm(importDirectory, { recursive: true });
      await Promise.all([
        writeFile(join(outside, `import-${REPLACEMENT_ID}.sqlite3`), 'outside stage'),
        writeFile(join(outside, `import-${REPLACEMENT_ID}.dwbx`), 'outside package'),
      ]);
      await symlink(outside, importDirectory, 'dir');
      const recovery = new DatabaseReplacementRecovery({
        dataDirectory: context.dataDirectory,
        markerStore: context.store,
        checkpointCurrentDatabase: async () => undefined,
        validateInstalledDatabase: async () => undefined,
        validatePreImportBackup: async () => undefined,
        validateRecoveryDatabase: async () => undefined,
      });

      await expect(recovery.recover()).rejects.toThrow(/not a real directory/u);
      expect(await readFile(join(outside, `import-${REPLACEMENT_ID}.sqlite3`), 'utf8')).toBe(
        'outside stage',
      );
    },
  );

  it('removes only recognized abandoned quarantine artifacts', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-import-cleanup-'));
    temporaryDirectories.push(dataDirectory);
    const importDirectory = join(dataDirectory, 'imports');
    await mkdir(importDirectory);
    const restoreDirectory = join(importDirectory, `.backup-restore-${REPLACEMENT_ID}-${WRITE_ID}`);
    const unrelatedDirectory = join(importDirectory, 'keep-directory');
    await Promise.all([mkdir(restoreDirectory), mkdir(unrelatedDirectory)]);
    await Promise.all([
      writeFile(join(restoreDirectory, 'daily-workbench.sqlite3'), 'restore copy'),
      writeFile(join(unrelatedDirectory, 'keep.txt'), 'unrelated directory'),
      writeFile(join(importDirectory, `import-${REPLACEMENT_ID}.dwbx`), 'package'),
      writeFile(join(importDirectory, `import-${REPLACEMENT_ID}.sqlite3`), 'database'),
      writeFile(join(importDirectory, `import-${REPLACEMENT_ID}.sqlite3-journal`), 'journal'),
      writeFile(
        join(importDirectory, `.import-${REPLACEMENT_ID}.sqlite3.${WRITE_ID}.partial-wal`),
        'wal',
      ),
      writeFile(join(importDirectory, 'keep-me.txt'), 'unrelated'),
      writeFile(join(importDirectory, `import-${REPLACEMENT_ID}.dwbx-journal`), 'lookalike'),
      writeFile(
        join(dataDirectory, `.database-replacement-v1.json.${WRITE_ID}.partial`),
        'partial marker',
      ),
    ]);

    await expect(cleanupAbandonedImportArtifacts(dataDirectory)).resolves.toBe(6);
    await expect(readFile(join(restoreDirectory, 'daily-workbench.sqlite3'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
    expect(await readFile(join(importDirectory, 'keep-me.txt'), 'utf8')).toBe('unrelated');
    expect(await readFile(join(unrelatedDirectory, 'keep.txt'), 'utf8')).toBe(
      'unrelated directory',
    );
    expect(
      await readFile(join(importDirectory, `import-${REPLACEMENT_ID}.dwbx-journal`), 'utf8'),
    ).toBe('lookalike');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects an abandoned backup-restore directory symlink without following it',
    async () => {
      const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-restore-cleanup-link-'));
      temporaryDirectories.push(dataDirectory);
      const importDirectory = join(dataDirectory, 'imports');
      const outside = await mkdtemp(join(tmpdir(), 'daily-workbench-restore-cleanup-outside-'));
      temporaryDirectories.push(outside);
      await mkdir(importDirectory);
      await writeFile(join(outside, 'preserve.txt'), 'outside');
      await symlink(
        outside,
        join(importDirectory, `.backup-restore-${REPLACEMENT_ID}-${WRITE_ID}`),
        'dir',
      );

      await expect(cleanupAbandonedImportArtifacts(dataDirectory)).rejects.toThrow(
        /not a real directory/u,
      );
      await expect(readFile(join(outside, 'preserve.txt'), 'utf8')).resolves.toBe('outside');
    },
  );
});

async function createContext() {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'daily-workbench-replacement-'));
  temporaryDirectories.push(dataDirectory);
  const importDirectory = join(dataDirectory, 'imports');
  await mkdir(importDirectory);
  const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
  const stagingPath = join(importDirectory, `import-${REPLACEMENT_ID}.sqlite3`);
  const packagePath = join(importDirectory, `import-${REPLACEMENT_ID}.dwbx`);
  const rollbackPath = join(dataDirectory, `rollback-${REPLACEMENT_ID}.sqlite3`);
  await Promise.all([
    writeFile(databasePath, 'old database'),
    writeFile(stagingPath, 'new database'),
    writeFile(packagePath, 'package'),
  ]);
  const persistence = new FileReplacementMarkerPersistence({
    dataDirectory,
    idFactory: () => WRITE_ID,
  });
  const store = new ReplacementMarkerStore(persistence);
  await store.create({
    replacementId: REPLACEMENT_ID,
    timestamp: NOW,
    databaseFileName: 'daily-workbench.sqlite3',
    stagingFileName: `import-${REPLACEMENT_ID}.sqlite3`,
    rollbackFileName: `rollback-${REPLACEMENT_ID}.sqlite3`,
    stagingSha256: createHash('sha256').update('new database').digest('hex'),
    preImportBackupId: BACKUP_ID,
  });
  return {
    dataDirectory,
    databasePath,
    stagingPath,
    packagePath,
    rollbackPath,
    persistence,
    store,
  };
}
