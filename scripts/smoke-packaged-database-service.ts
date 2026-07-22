import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WORKSPACE_COLORS } from '../src/shared/contracts';
import { DatabaseService } from '../src/main/database';
import { DEFAULT_MIGRATIONS } from '../src/main/database/default-migrations';
import { MetadataRepository } from '../src/main/database/metadata-repository';
import { MigrationRunner } from '../src/main/database/migration-runner';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
} from '../src/main/database/sqlite-adapter';

const DEFAULT_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

async function main(): Promise<void> {
  assert.ok(
    process.versions.electron,
    'Run this bundle with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.',
  );

  const root = await mkdtemp(join(tmpdir(), 'daily workbench 服务 smoke-'));
  try {
    await smokeCurrentService(join(root, 'current 数据'));
    await smokeVersionOneUpgrade(join(root, 'legacy v1 数据'));
    console.log(
      `Packaged DatabaseService workspace/migration/backup/reopen smoke test passed ` +
        `(Electron ${process.versions.electron}, Node ${process.versions.node}, ` +
        `SQLite ${process.versions.sqlite}).`,
    );
  } finally {
    await removeSmokeDirectory(root);
  }
}

async function smokeCurrentService(dataDirectory: string): Promise<void> {
  const ids = [DEFAULT_WORKSPACE_ID, SECOND_WORKSPACE_ID];
  let service: DatabaseService | undefined = new DatabaseService({
    dataDirectory,
    workspaceIdFactory: () => ids.shift() ?? '33333333-3333-4333-8333-333333333333',
  });

  try {
    const initialized = await service.open();
    assert.equal(initialized.migration.fromVersion, 0);
    assert.equal(initialized.migration.toVersion, 2);
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
        schemaVersion: 2,
        appliedMigrations: 2,
        journalMode: 'wal',
        integrityCheck: 'ok',
        backupCount: 0,
      },
    );
    assert.equal(status.sqliteVersion, process.versions.sqlite);
    assert.equal('databasePath' in status, false);

    let snapshot = await service.getWorkspaceSnapshot();
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0]?.name, '我的工作台');
    await service.updateWorkspacePreferences({
      workspaceId: DEFAULT_WORKSPACE_ID,
      patch: { theme: 'light', activeView: 'notes', browserWidth: 518 },
    });

    snapshot = await service.createWorkspace({
      name: '开发 与 探索 🧪',
      color: WORKSPACE_COLORS[2],
    });
    assert.equal(snapshot.currentWorkspaceId, SECOND_WORKSPACE_ID);
    await service.renameWorkspace({ workspaceId: SECOND_WORKSPACE_ID, name: '研发工作区 🧪' });
    await service.updateWorkspacePreferences({
      workspaceId: SECOND_WORKSPACE_ID,
      patch: { activeView: 'tasks', browserOpen: false, terminalHeight: 472 },
    });

    snapshot = await service.activateWorkspace({ workspaceId: DEFAULT_WORKSPACE_ID });
    assert.deepEqual(
      {
        theme: snapshot.preferences.theme,
        activeView: snapshot.preferences.activeView,
        browserWidth: snapshot.preferences.browserWidth,
      },
      { theme: 'light', activeView: 'notes', browserWidth: 518 },
    );
    snapshot = await service.activateWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    assert.deepEqual(
      {
        activeView: snapshot.preferences.activeView,
        browserOpen: snapshot.preferences.browserOpen,
        terminalHeight: snapshot.preferences.terminalHeight,
      },
      { activeView: 'tasks', browserOpen: false, terminalHeight: 472 },
    );

    snapshot = await service.archiveWorkspace({ workspaceId: SECOND_WORKSPACE_ID });
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.deepEqual(
      snapshot.workspaces.map(({ id }) => id),
      [DEFAULT_WORKSPACE_ID],
    );

    const created = await service.createBackup();
    assert.equal(created.reason, 'manual');
    assert.equal(created.schemaVersion, 2);
    assert.equal('path' in created, false);
    assert.deepEqual(await service.listBackups(), [created]);
    await service.close();
    service = undefined;

    const backupPath = join(dataDirectory, 'backups', created.fileName);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get()?.user_version, 2);
      assert.equal(backup.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM workspaces').get()?.count, 2);
      assert.equal(
        backup.prepare('SELECT current_workspace_id FROM workspace_app_state').get()
          ?.current_workspace_id,
        DEFAULT_WORKSPACE_ID,
      );
      assert.equal(
        backup.prepare('SELECT archived_at FROM workspaces WHERE id = ?').get(SECOND_WORKSPACE_ID)
          ?.archived_at !== null,
        true,
      );
    } finally {
      backup.close();
    }

    service = new DatabaseService({ dataDirectory });
    const reopened = await service.open();
    assert.equal(reopened.migration.fromVersion, 2);
    assert.equal(reopened.migration.toVersion, 2);
    assert.equal(reopened.migration.applied.length, 0);
    snapshot = await service.getWorkspaceSnapshot();
    assert.equal(snapshot.currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.preferences.theme, 'light');
    assert.equal((await service.getStatus()).backupCount, 1);
  } finally {
    await service?.close().catch(() => undefined);
  }
}

async function smokeVersionOneUpgrade(dataDirectory: string): Promise<void> {
  await mkdir(dataDirectory, { recursive: true });
  const database = createNodeSqliteAdapter(join(dataDirectory, 'daily-workbench.sqlite3'));
  database.open();
  configureDesktopPragmas(database);
  new MigrationRunner([DEFAULT_MIGRATIONS[0]]).apply(database);
  new MetadataRepository(database).initialize(
    new Date().toISOString(),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  database.close();

  const service = new DatabaseService({
    dataDirectory,
    workspaceIdFactory: () => DEFAULT_WORKSPACE_ID,
  });
  try {
    const upgraded = await service.open();
    assert.equal(upgraded.migration.fromVersion, 1);
    assert.equal(upgraded.migration.toVersion, 2);
    assert.equal(upgraded.preMigrationBackup?.schemaVersion, 1);
    assert.equal((await service.getWorkspaceSnapshot()).currentWorkspaceId, DEFAULT_WORKSPACE_ID);
    const backup = upgraded.preMigrationBackup;
    assert.ok(backup);
    const legacySnapshot = new DatabaseSync(join(dataDirectory, 'backups', backup.fileName), {
      readOnly: true,
    });
    try {
      assert.equal(legacySnapshot.prepare('PRAGMA user_version').get()?.user_version, 1);
      assert.equal(
        legacySnapshot
          .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'workspaces'")
          .get()?.count,
        0,
      );
    } finally {
      legacySnapshot.close();
    }
  } finally {
    await service.close().catch(() => undefined);
  }
}

async function removeSmokeDirectory(root: string): Promise<void> {
  const expectedPrefix = join(tmpdir(), 'daily workbench 服务 smoke-');
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
