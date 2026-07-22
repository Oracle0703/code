import assert from 'node:assert/strict';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseService } from '../src/main/database';

async function main(): Promise<void> {
  assert.ok(
    process.versions.electron,
    'Run this bundle with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.',
  );

  const root = await mkdtemp(join(tmpdir(), 'daily-workbench-service-smoke-'));
  const dataDirectory = join(root, 'data');
  let service: DatabaseService | undefined;

  try {
    service = new DatabaseService({ dataDirectory });
    const initialized = await service.open();
    assert.equal(initialized.migration.fromVersion, 0);
    assert.equal(initialized.migration.toVersion, 1);
    assert.equal(initialized.preMigrationBackup, undefined);

    const status = await service.getStatus();
    assert.deepEqual(
      {
        schemaVersion: status.schemaVersion,
        appliedMigrations: status.appliedMigrations,
        journalMode: status.journalMode,
        integrityCheck: status.integrityCheck,
        backupCount: status.backupCount,
      },
      {
        schemaVersion: 1,
        appliedMigrations: 1,
        journalMode: 'wal',
        integrityCheck: 'ok',
        backupCount: 0,
      },
    );
    assert.equal(status.sqliteVersion, process.versions.sqlite);
    assert.equal('databasePath' in status, false);

    const created = await service.createBackup();
    assert.equal(created.reason, 'manual');
    assert.equal(created.schemaVersion, 1);
    assert.equal('path' in created, false);
    assert.deepEqual(await service.listBackups(), [created]);
    await service.close();

    const snapshot = new DatabaseSync(join(dataDirectory, 'backups', created.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(snapshot.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
    } finally {
      snapshot.close();
    }

    service = new DatabaseService({ dataDirectory });
    const reopened = await service.open();
    assert.equal(reopened.migration.fromVersion, 1);
    assert.equal(reopened.migration.toVersion, 1);
    assert.equal(reopened.migration.applied.length, 0);
    assert.equal((await service.getStatus()).backupCount, 1);

    console.log(
      `Packaged DatabaseService migration/backup/reopen smoke test passed ` +
        `(Electron ${process.versions.electron}, Node ${process.versions.node}, ` +
        `SQLite ${process.versions.sqlite}).`,
    );
  } finally {
    await service?.close().catch(() => undefined);
    await removeSmokeDirectory(root);
  }
}

async function removeSmokeDirectory(root: string): Promise<void> {
  const expectedPrefix = join(tmpdir(), 'daily-workbench-service-smoke-');
  assert.ok(root.startsWith(expectedPrefix), `Refusing to clean an unexpected path: ${root}`);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 200,
  });
}

void main().catch((error: unknown) => {
  console.error('Packaged DatabaseService smoke test failed.', error);
  process.exitCode = 1;
});
