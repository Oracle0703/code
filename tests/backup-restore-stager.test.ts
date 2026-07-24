import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/main/database/database-service';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { DatabaseBackupError, DatabaseIntegrityError } from '../src/main/database/errors';
import {
  createNodeSqliteAdapter,
  type SqliteAdapterFactory,
} from '../src/main/database/sqlite-adapter';

const RESTORE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTOMATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOCUS_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TODAY = '2026-07-24';
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

describe('database backup restore staging', () => {
  it('copies an exact backup without changing it and normalizes only the staged database', async () => {
    const dataDirectory = await createDataDirectory();
    let now = new Date('2026-07-24T08:00:00.000Z');
    const service = new DatabaseService({
      dataDirectory,
      now: () => now,
      taskTodayFactory: () => TODAY,
      scheduleTodayFactory: () => TODAY,
      focusTodayFactory: () => TODAY,
      automationIdFactory: () => AUTOMATION_ID,
      focusIdFactory: () => FOCUS_ID,
    });
    await service.open();
    const workspace = await service.getWorkspaceSnapshot();
    const workspaceId = workspace.currentWorkspaceId;
    await service.createInboxEntry({
      workspaceId,
      content: '仅存在于恢复点',
      category: 'note',
    });
    await service.createAutomation({
      workspaceId,
      name: '恢复后必须停用',
      schedule: { cadence: 'daily', localTimeMinute: 9 * 60, weekday: null },
      action: { kind: 'create-today-task', title: '不应自动执行' },
    });
    await service.setAutomationEnabled({
      workspaceId,
      automationId: AUTOMATION_ID,
      expectedRevision: 1,
      enabled: true,
    });
    await service.startFocusSession({ workspaceId });
    const backup = await service.createBackup();
    const backupPath = join(dataDirectory, 'backups', backup.fileName);
    const sourceBytes = await readFile(backupPath);

    now = new Date('2026-07-24T08:02:00.000Z');
    const originalSchedule = await service.getBackupSchedulerState();
    const policy = await service.updateBackupPolicy({
      enabled: true,
      cadence: 'weekly',
      localTimeMinute: 10 * 60 + 15,
      weekday: 5,
      retentionCount: 27,
      expectedRevision: originalSchedule.policy.revision,
    });
    await service.recordBackupAttempt('2026-07-24T08:03:00.000Z');
    await service.recordBackupResult({
      attemptedAt: '2026-07-24T08:03:00.000Z',
      completedAt: '2026-07-24T08:03:01.000Z',
      successfulBucket: 'weekly:2026-07-24',
    });
    const localSchedule = await service.getBackupSchedulerState();
    expect(localSchedule.policy).toEqual(policy);
    await service.createInboxEntry({
      workspaceId,
      content: '晚于恢复点',
      category: 'task',
    });

    now = new Date('2026-07-24T08:05:00.000Z');
    const prepared = await service.prepareBackupRestore(toRestoreInput(backup), RESTORE_ID);
    expect(prepared).toEqual({
      restoreId: RESTORE_ID,
      backup,
      sourceDigest: sha256(sourceBytes),
      stagingFileName: `import-${RESTORE_ID}.sqlite3`,
      stagingDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(prepared).not.toHaveProperty('path');
    await expect(readFile(backupPath)).resolves.toEqual(sourceBytes);

    const stagingPath = join(dataDirectory, 'imports', prepared.stagingFileName);
    expect(readStagingState(stagingPath)).toMatchObject({
      schemaVersion: 11,
      inboxContents: ['仅存在于恢复点'],
      automation: {
        enabled: 0,
        effective_at: null,
        revision: 3,
      },
      focus: {
        state: 'paused',
        remaining_seconds: 1_200,
        deadline_at: null,
        revision: 2,
      },
      preferences: {
        browser_open: 0,
        terminal_open: 0,
      },
      policy: {
        enabled: 1,
        cadence: 'weekly',
        local_time_minute: 615,
        weekday: 5,
        retention_count: 27,
        revision: policy.revision,
        updated_at: policy.updatedAt,
      },
      runState: {
        last_attempt_at: '2026-07-24T08:03:00.000Z',
        last_success_at: '2026-07-24T08:03:01.000Z',
        last_success_bucket: 'weekly:2026-07-24',
        last_error_code: null,
        consecutive_failures: 0,
        updated_at: '2026-07-24T08:03:01.000Z',
      },
    });
    await expectSqliteSidecarsMissing(stagingPath);

    now = new Date('2026-07-24T08:30:00.000Z');
    const refreshed = await service.refreshBackupRestore(prepared);
    expect(refreshed.sourceDigest).toBe(prepared.sourceDigest);
    expect(refreshed.stagingDigest).not.toBe(prepared.stagingDigest);
    expect(readStagingState(stagingPath).focus).toMatchObject({
      state: 'completed',
      remaining_seconds: 0,
      deadline_at: null,
      revision: 2,
      completed_at: '2026-07-24T08:30:00.000Z',
    });
    await expect(readFile(backupPath)).resolves.toEqual(sourceBytes);
    await expectSqliteSidecarsMissing(stagingPath);

    await service.discardBackupRestore(refreshed);
    await expect(readFile(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expectSqliteSidecarsMissing(stagingPath);
    await service.close();
  });

  it('migrates only a v10 copy to v11 and rejects any stale metadata claim', async () => {
    const dataDirectory = await createDataDirectory();
    const legacy = new DatabaseService({
      dataDirectory,
      migrations: DEFAULT_MIGRATIONS.slice(0, 10),
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });
    await legacy.open();
    const backup = await legacy.createBackup();
    await legacy.close();
    const backupPath = join(dataDirectory, 'backups', backup.fileName);
    const sourceBytes = await readFile(backupPath);

    let nestedMigrationBackupAttempted = false;
    const adapterFactory: SqliteAdapterFactory = (path, options) => {
      const adapter = createNodeSqliteAdapter(path, options);
      const backupTo = adapter.backupTo.bind(adapter);
      adapter.backupTo = (destinationPath) => {
        if (destinationPath.replaceAll('\\', '/').includes('/imports/')) {
          nestedMigrationBackupAttempted = true;
          throw new Error('A retained restore copy must not create a nested pre-migration backup.');
        }
        return backupTo(destinationPath);
      };
      return adapter;
    };
    const current = new DatabaseService({
      dataDirectory,
      now: () => new Date('2026-07-24T12:00:00.000Z'),
      adapterFactory,
    });
    await current.open();
    await expect(
      current.prepareBackupRestore(
        { ...toRestoreInput(backup), expectedSizeBytes: backup.sizeBytes + 1 },
        RESTORE_ID,
      ),
    ).rejects.toBeInstanceOf(DatabaseBackupError);
    await expect(readFile(backupPath)).resolves.toEqual(sourceBytes);

    const prepared = await current.prepareBackupRestore(toRestoreInput(backup), RESTORE_ID);
    expect(nestedMigrationBackupAttempted).toBe(false);
    const stagingPath = join(dataDirectory, 'imports', prepared.stagingFileName);
    expect(readStagingState(stagingPath).schemaVersion).toBe(11);
    expect(readSchemaVersion(backupPath)).toBe(10);
    await expect(readFile(backupPath)).resolves.toEqual(sourceBytes);
    await current.discardBackupRestore(prepared);
    await current.close();
  });

  it('runs a v0 copy through full isolated initialization and removes its temporary data tree', async () => {
    const dataDirectory = await createDataDirectory();
    await mkdir(dataDirectory, { recursive: true });
    const databasePath = join(dataDirectory, 'daily-workbench.sqlite3');
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE legacy_probe (value TEXT NOT NULL) STRICT;
      INSERT INTO legacy_probe (value) VALUES ('kept through migration');
    `);
    legacy.close();

    const service = new DatabaseService({
      dataDirectory,
      now: () => new Date('2026-07-24T12:00:00.000Z'),
    });
    const initialization = await service.open();
    expect(initialization.preMigrationBackup).toMatchObject({
      reason: 'pre-migration',
      schemaVersion: 0,
    });
    const backup = (await service.listBackups()).find(
      ({ reason, schemaVersion }) => reason === 'pre-migration' && schemaVersion === 0,
    );
    expect(backup).toBeDefined();
    const backupPath = join(dataDirectory, 'backups', backup!.fileName);
    const sourceBytes = await readFile(backupPath);

    const prepared = await service.prepareBackupRestore(toRestoreInput(backup!), RESTORE_ID);
    const stagingPath = join(dataDirectory, 'imports', prepared.stagingFileName);
    const staging = new DatabaseSync(stagingPath, { readOnly: true });
    try {
      expect(staging.prepare('PRAGMA user_version').get()).toEqual({ user_version: 11 });
      expect(staging.prepare('SELECT value FROM legacy_probe').get()).toEqual({
        value: 'kept through migration',
      });
      expect(staging.prepare('SELECT COUNT(*) AS count FROM workspaces').get()).toEqual({
        count: 1,
      });
      expect(
        staging.prepare('SELECT current_workspace_id FROM workspace_app_state').get(),
      ).toHaveProperty('current_workspace_id');
      expect(
        staging.prepare("SELECT value FROM app_metadata WHERE key = 'database_id'").get(),
      ).toHaveProperty('value');
    } finally {
      staging.close();
    }
    expect(await readdir(join(dataDirectory, 'imports'))).toEqual([prepared.stagingFileName]);
    await expect(readFile(backupPath)).resolves.toEqual(sourceBytes);
    await service.discardBackupRestore(prepared);
    await service.close();
  });

  it('refuses to refresh after the source backup is atomically replaced with different valid bytes', async () => {
    const dataDirectory = await createDataDirectory();
    const taskId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    let now = new Date('2026-07-24T09:00:00.000Z');
    const service = new DatabaseService({
      dataDirectory,
      now: () => now,
      taskIdFactory: () => taskId,
      taskTodayFactory: () => TODAY,
    });
    await service.open();
    const workspaceId = (await service.getWorkspaceSnapshot()).currentWorkspaceId;
    await service.createTask({
      workspaceId,
      title: 'source content alpha',
      planning: 'day-0',
    });
    const original = await service.createBackup();
    const originalPath = join(dataDirectory, 'backups', original.fileName);
    const originalBytes = await readFile(originalPath);
    const prepared = await service.prepareBackupRestore(toRestoreInput(original), RESTORE_ID);
    const stagingPath = join(dataDirectory, 'imports', prepared.stagingFileName);
    const stagingBytes = await readFile(stagingPath);

    now = new Date('2026-07-24T09:01:00.000Z');
    await service.renameTask({
      workspaceId,
      taskId,
      title: 'source content omega',
    });
    const replacement = await service.createBackup();
    const replacementBytes = await readFile(join(dataDirectory, 'backups', replacement.fileName));
    expect(replacementBytes).not.toEqual(originalBytes);
    expect(replacementBytes.byteLength).toBe(original.sizeBytes);

    const temporaryReplacementPath = join(dataDirectory, 'backups', '.restore-source-replacement');
    await writeFile(temporaryReplacementPath, replacementBytes, { mode: 0o600 });
    await rename(temporaryReplacementPath, originalPath);
    expect(await service.validateExistingBackup(original.id, original.reason)).toEqual(original);

    await expect(service.refreshBackupRestore(prepared)).rejects.toThrow(
      'The database backup restore source changed after it was prepared.',
    );
    await expect(readFile(stagingPath)).resolves.toEqual(stagingBytes);
    expect((await readFile(originalPath)).byteLength).toBe(original.sizeBytes);
    expect(await readdir(join(dataDirectory, 'imports'))).toEqual([prepared.stagingFileName]);

    await service.close();
  });

  it('refuses to refresh or discard a staged file whose prepared digest no longer matches', async () => {
    const dataDirectory = await createDataDirectory();
    const service = new DatabaseService({ dataDirectory });
    await service.open();
    const backup = await service.createBackup();
    const backupPath = join(dataDirectory, 'backups', backup.fileName);
    const sourceBytes = await readFile(backupPath);
    const prepared = await service.prepareBackupRestore(toRestoreInput(backup), RESTORE_ID);
    const stagingPath = join(dataDirectory, 'imports', prepared.stagingFileName);
    const tampered = Buffer.from('unknown replacement data');
    await writeFile(stagingPath, tampered);

    await expect(service.refreshBackupRestore(prepared)).rejects.toBeInstanceOf(
      DatabaseIntegrityError,
    );
    await expect(readFile(stagingPath)).resolves.toEqual(tampered);
    await expect(service.discardBackupRestore(prepared)).rejects.toBeInstanceOf(
      DatabaseIntegrityError,
    );
    await expect(readFile(stagingPath)).resolves.toEqual(tampered);
    await expect(readFile(backupPath)).resolves.toEqual(sourceBytes);
    expect(await readdir(join(dataDirectory, 'imports'))).toEqual([prepared.stagingFileName]);
    await service.close();
  });
});

function toRestoreInput(backup: {
  readonly id: string;
  readonly reason: 'manual' | 'scheduled' | 'pre-migration' | 'pre-import';
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly schemaVersion: number;
}) {
  return {
    backupId: backup.id,
    expectedReason: backup.reason,
    expectedCreatedAt: backup.createdAt,
    expectedSizeBytes: backup.sizeBytes,
    expectedSchemaVersion: backup.schemaVersion,
  };
}

function readStagingState(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      schemaVersion: (database.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version,
      inboxContents: (
        database
          .prepare('SELECT content FROM inbox_entries ORDER BY created_at, id')
          .all() as Array<{
          content: string;
        }>
      ).map(({ content }) => content),
      automation: database
        .prepare(
          `SELECT enabled, effective_at, revision
           FROM automations
           WHERE id = ?`,
        )
        .get(AUTOMATION_ID),
      focus: database
        .prepare(
          `SELECT state, remaining_seconds, deadline_at, revision, completed_at
           FROM focus_sessions
           WHERE id = ?`,
        )
        .get(FOCUS_ID),
      preferences: database
        .prepare(
          `SELECT browser_open, terminal_open
           FROM workspace_preferences
           ORDER BY workspace_id
           LIMIT 1`,
        )
        .get(),
      policy: database.prepare('SELECT * FROM backup_policy WHERE singleton = 1').get(),
      runState: database.prepare('SELECT * FROM backup_run_state WHERE singleton = 1').get(),
    };
  } finally {
    database.close();
  }
}

function readSchemaVersion(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

async function expectSqliteSidecarsMissing(path: string): Promise<void> {
  await Promise.all(
    ['-wal', '-shm', '-journal'].map((suffix) =>
      expect(readFile(`${path}${suffix}`)).rejects.toMatchObject({ code: 'ENOENT' }),
    ),
  );
}

async function createDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'daily-workbench-restore-staging-'));
  temporaryDirectories.push(directory);
  return join(directory, 'data');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
