import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/main/database/database-service';
import {
  DatabaseBackupError,
  DatabaseIntegrityError,
  DatabaseStateError,
} from '../src/main/database/errors';

const FIRST_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const T0 = '2026-07-23T08:00:00.000Z';
const T1 = '2026-07-23T08:01:00.000Z';
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

describe('terminal preference persistence', () => {
  it('persists revisioned Main-only profile, native CWD, and WSL preferences', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({
      dataDirectory,
      now: () => new Date(T0),
      workspaceIdFactory: () => FIRST_WORKSPACE_ID,
    });
    await service.open();

    await expect(service.getTerminalPreferences(FIRST_WORKSPACE_ID)).resolves.toEqual({
      workspaceId: FIRST_WORKSPACE_ID,
      preferredProfileId: 'system-default',
      nativeCwdPlatform: null,
      nativeCwdPath: null,
      wslDistributionName: null,
      revision: 1,
      updatedAt: T0,
    });
    await expect(
      service.updateTerminalProfilePreference({
        workspaceId: FIRST_WORKSPACE_ID,
        preferredProfileId: 'bash',
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      preferredProfileId: 'bash',
      revision: 2,
    });
    await expect(
      service.updateTerminalWorkingDirectoryPreference({
        workspaceId: FIRST_WORKSPACE_ID,
        nativeCwdPlatform: 'linux',
        nativeCwdPath: '/tmp/工作台 project',
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({
      nativeCwdPlatform: 'linux',
      nativeCwdPath: '/tmp/工作台 project',
      revision: 3,
    });
    await expect(
      service.updateTerminalWslDistributionPreference({
        workspaceId: FIRST_WORKSPACE_ID,
        wslDistributionName: 'Ubuntu 开发',
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({
      wslDistributionName: 'Ubuntu 开发',
      revision: 4,
    });
    await expect(
      service.updateTerminalProfilePreference({
        workspaceId: FIRST_WORKSPACE_ID,
        preferredProfileId: 'zsh',
        expectedRevision: 2,
      }),
    ).rejects.toBeInstanceOf(DatabaseStateError);
    await expect(
      service.updateTerminalWorkingDirectoryPreference({
        workspaceId: FIRST_WORKSPACE_ID,
        nativeCwdPlatform: null,
        nativeCwdPath: null,
        expectedRevision: 4,
      }),
    ).resolves.toMatchObject({
      nativeCwdPlatform: null,
      nativeCwdPath: null,
      revision: 5,
    });

    const backup = await service.createBackup();
    expect(backup).toMatchObject({ schemaVersion: 9 });
    await service.close();

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      expect(
        snapshot
          .prepare(
            `SELECT preferred_profile_id, native_cwd_platform, native_cwd_path,
                    wsl_distribution_name, revision
             FROM workspace_terminal_preferences
             WHERE workspace_id = ?`,
          )
          .get(FIRST_WORKSPACE_ID),
      ).toEqual({
        preferred_profile_id: 'bash',
        native_cwd_platform: null,
        native_cwd_path: null,
        wsl_distribution_name: 'Ubuntu 开发',
        revision: 5,
      });
    } finally {
      snapshot.close();
    }

    const reopened = new DatabaseService({
      dataDirectory,
      now: () => new Date(T1),
    });
    await reopened.open();
    await expect(reopened.getTerminalPreferences(FIRST_WORKSPACE_ID)).resolves.toMatchObject({
      preferredProfileId: 'bash',
      wslDistributionName: 'Ubuntu 开发',
      revision: 5,
    });
    await reopened.close();
  });

  it('rejects invalid values, stale or archived writes, and a missing companion row', async () => {
    const dataDirectory = await createDataDirectory();
    const workspaceIds = [FIRST_WORKSPACE_ID, SECOND_WORKSPACE_ID];
    const service = new DatabaseService({
      dataDirectory,
      now: () => new Date(T0),
      workspaceIdFactory: () => workspaceIds.shift() ?? SECOND_WORKSPACE_ID,
    });
    await service.open();

    await expect(
      service.updateTerminalWorkingDirectoryPreference({
        workspaceId: FIRST_WORKSPACE_ID,
        nativeCwdPlatform: 'linux',
        nativeCwdPath: 'relative/path',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      service.updateTerminalWslDistributionPreference({
        workspaceId: FIRST_WORKSPACE_ID,
        wslDistributionName: '-unsafe',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(TypeError);

    await service.createWorkspace({ name: '第二空间', color: '#348bd4' });
    await service.archiveWorkspace({ workspaceId: FIRST_WORKSPACE_ID });
    await expect(
      service.updateTerminalProfilePreference({
        workspaceId: FIRST_WORKSPACE_ID,
        preferredProfileId: 'bash',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(DatabaseStateError);
    await service.close();

    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const database = new DatabaseSync(databasePath);
    try {
      database.exec('DROP TRIGGER workspace_terminal_preferences_prevent_delete');
      database
        .prepare('DELETE FROM workspace_terminal_preferences WHERE workspace_id = ?')
        .run(FIRST_WORKSPACE_ID);
      database.exec(`
        CREATE TRIGGER workspace_terminal_preferences_prevent_delete
        BEFORE DELETE ON workspace_terminal_preferences
        BEGIN
          SELECT RAISE(ABORT, 'terminal preferences cannot be deleted');
        END;
      `);
    } finally {
      database.close();
    }

    const corrupted = new DatabaseService({ dataDirectory });
    await expect(corrupted.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
  });

  it('rejects a same-name weakened terminal preference trigger during startup', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({
      dataDirectory,
      now: () => new Date(T0),
      workspaceIdFactory: () => FIRST_WORKSPACE_ID,
    });
    await service.open();
    await service.close();

    mutateDatabase(
      join(dataDirectory, 'daily-workbench.sqlite3'),
      `
      DROP TRIGGER workspace_terminal_preferences_revision_must_advance;
      CREATE TRIGGER workspace_terminal_preferences_revision_must_advance
      BEFORE UPDATE ON workspace_terminal_preferences
      BEGIN
        SELECT 1;
      END;
    `,
    );

    const corrupted = new DatabaseService({ dataDirectory });
    await expect(corrupted.open()).rejects.toBeInstanceOf(DatabaseIntegrityError);
  });

  it('refuses to publish a backup with a same-name weakened creation trigger', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({
      dataDirectory,
      now: () => new Date(T0),
      workspaceIdFactory: () => FIRST_WORKSPACE_ID,
    });
    await service.open();
    try {
      mutateDatabase(
        join(dataDirectory, 'daily-workbench.sqlite3'),
        `
        DROP TRIGGER workspace_terminal_preferences_create_after_workspace;
        CREATE TRIGGER workspace_terminal_preferences_create_after_workspace
        AFTER INSERT ON workspaces
        BEGIN
          SELECT 1;
        END;
      `,
      );

      await expect(service.createBackup()).rejects.toBeInstanceOf(DatabaseBackupError);
      expect(await readdir(join(dataDirectory, 'backups'))).toEqual([]);
    } finally {
      await service.close();
    }
  });
});

async function createDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-terminal-preferences-'));
  temporaryDirectories.push(directory);
  return directory;
}

function mutateDatabase(path: string, sql: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}
