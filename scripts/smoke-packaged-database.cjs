const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync, backup, constants } = require('node:sqlite');
const { stat: statPhysicalFile } = require('original-fs').promises;

const asarArgument = process.argv[2];
if (!asarArgument) {
  console.error('Expected the packaged app.asar path.');
  process.exit(1);
}

void main().catch((error) => {
  console.error('Packaged database smoke test failed.', error);
  process.exitCode = 1;
});

async function main() {
  assert.ok(
    process.versions.electron,
    'Run this script with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.',
  );
  assert.equal(typeof DatabaseSync, 'function', 'Electron must expose node:sqlite DatabaseSync.');
  assert.equal(typeof backup, 'function', 'Electron must expose the node:sqlite backup API.');

  const asarPath = path.resolve(asarArgument);
  await assertDatabaseFoundationIsPackaged(asarPath);

  const smokeDirectory = await mkdtemp(path.join(os.tmpdir(), 'daily-workbench-db-smoke-'));
  const databasePath = path.join(smokeDirectory, 'workbench-smoke.sqlite3');
  const backupPath = path.join(smokeDirectory, 'backups', 'workbench-smoke.sqlite3');
  let database;

  try {
    database = createClosedDatabase(databasePath);
    assert.equal(database.isOpen, false);
    database.open();
    configureDatabase(database);
    verifyTransactionGuardRuntime(database);
    applySmokeMigrations(database);
    verifyMigratedDatabase(database);

    // A second pass must be a no-op; this catches migrations that are not
    // version-gated and would fail when the application reopens a database.
    applySmokeMigrations(database);
    verifyMigratedDatabase(database);

    await mkdir(path.dirname(backupPath), { recursive: true });
    await backup(database, backupPath);
    assert.ok((await stat(backupPath)).size > 0, 'The SQLite backup must not be empty.');

    // Prove the backup is a point-in-time snapshot rather than another handle
    // to the live source database.
    database.prepare('INSERT INTO smoke_items (label) VALUES (?)').run('created-after-backup');
    verifyBackup(backupPath);

    database.close();
    database = undefined;

    // Reopening exercises filesystem persistence and migration idempotency.
    database = createClosedDatabase(databasePath);
    database.open();
    configureDatabase(database);
    applySmokeMigrations(database);
    assert.equal(readUserVersion(database), SMOKE_MIGRATIONS.length);
    assert.equal(readItemCount(database), 2);

    console.log(
      `Packaged database open/migrate/backup/reopen smoke test passed ` +
        `(Electron ${process.versions.electron}, Node ${process.versions.node}, ` +
        `SQLite ${process.versions.sqlite}).`,
    );
  } finally {
    if (database?.isOpen) {
      database.close();
    }
    await removeSmokeDirectory(smokeDirectory);
  }
}

const SMOKE_MIGRATIONS = [
  [
    'CREATE TABLE smoke_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
    "INSERT INTO smoke_metadata (key, value) VALUES ('schema', 'packaged-runtime')",
  ],
  [
    'CREATE TABLE smoke_items (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT',
    "INSERT INTO smoke_items (label) VALUES ('included-in-backup')",
  ],
];

function configureDatabase(database) {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA trusted_schema = OFF');
}

function createClosedDatabase(databasePath) {
  return new DatabaseSync(databasePath, {
    open: false,
    timeout: 5_000,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    allowUnknownNamedParameters: false,
    defensive: true,
  });
}

function verifyTransactionGuardRuntime(database) {
  assert.equal(typeof database.setAuthorizer, 'function');
  assert.equal(typeof database.isTransaction, 'boolean');
  database.exec("ATTACH DATABASE ':memory:' AS auxiliary");
  database.exec('BEGIN IMMEDIATE');
  database.setAuthorizer((actionCode) =>
    actionCode === constants.SQLITE_TRANSACTION ||
    actionCode === constants.SQLITE_PRAGMA ||
    actionCode === constants.SQLITE_ATTACH ||
    actionCode === constants.SQLITE_DETACH
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    assert.throws(() => database.exec('END'));
    assert.equal(database.isTransaction, true, 'Denied END must leave the outer transaction open.');
    assert.throws(() => database.exec('PRAGMA trusted_schema = ON'));
    assert.throws(() => database.exec("ATTACH DATABASE ':memory:' AS escaped"));
    assert.throws(() => database.exec('DETACH DATABASE auxiliary'));
  } finally {
    database.setAuthorizer(null);
    database.exec('ROLLBACK');
    database.exec('DETACH DATABASE auxiliary');
  }
  assert.equal(
    database.prepare('PRAGMA trusted_schema').get().trusted_schema,
    0,
    'Denied PRAGMA must preserve trusted_schema=OFF.',
  );
}

function applySmokeMigrations(database) {
  const currentVersion = readUserVersion(database);
  assert.ok(
    currentVersion >= 0 && currentVersion <= SMOKE_MIGRATIONS.length,
    `Unexpected smoke schema version ${currentVersion}.`,
  );

  for (let index = currentVersion; index < SMOKE_MIGRATIONS.length; index += 1) {
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of SMOKE_MIGRATIONS[index]) {
        database.exec(statement);
      }
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function verifyMigratedDatabase(database) {
  assert.equal(readUserVersion(database), SMOKE_MIGRATIONS.length);
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(database.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(database.prepare('PRAGMA busy_timeout').get().timeout, 5_000);
  assert.equal(database.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(database.prepare('PRAGMA trusted_schema').get().trusted_schema, 0);
  assert.equal(
    database.prepare('SELECT sqlite_version() AS version').get().version,
    process.versions.sqlite,
  );
  assert.equal(
    database.prepare("SELECT value FROM smoke_metadata WHERE key = 'schema'").get().value,
    'packaged-runtime',
  );
  assert.equal(readItemCount(database), 1);
  assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
}

function verifyBackup(backupPath) {
  const backupDatabase = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.equal(readUserVersion(backupDatabase), SMOKE_MIGRATIONS.length);
    assert.equal(readItemCount(backupDatabase), 1);
    assert.equal(backupDatabase.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally {
    backupDatabase.close();
  }
}

function readUserVersion(database) {
  return database.prepare('PRAGMA user_version').get().user_version;
}

function readItemCount(database) {
  return database.prepare('SELECT COUNT(*) AS count FROM smoke_items').get().count;
}

async function assertDatabaseFoundationIsPackaged(asarPath) {
  assert.ok(
    (await statPhysicalFile(asarPath)).isFile(),
    'The packaged app.asar path must be a physical regular file.',
  );
  const packageMetadata = JSON.parse(await readFile(path.join(asarPath, 'package.json'), 'utf8'));
  assert.equal(typeof packageMetadata.main, 'string', 'Packaged package.json must declare main.');

  const normalizedMain = packageMetadata.main.replaceAll('\\', '/');
  const mainPath = path.resolve(asarPath, normalizedMain);
  const relativeMain = path.relative(asarPath, mainPath);
  assert.ok(
    normalizedMain.length > 0 &&
      !path.posix.isAbsolute(normalizedMain) &&
      relativeMain !== '..' &&
      !relativeMain.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeMain),
    'Packaged main entry must remain inside app.asar.',
  );

  const mainBundle = await readFile(mainPath, 'utf8');
  for (const requiredToken of [
    'node:sqlite',
    'DatabaseSync',
    'backup',
    'setAuthorizer',
    'SQLITE_TRANSACTION',
    'SQLITE_PRAGMA',
    'SQLITE_ATTACH',
    'SQLITE_DETACH',
    'database_foundation',
    'workspaces',
    'inbox',
    'notes_schedule',
    'schema_migrations',
    'CREATE TABLE app_metadata',
    'CREATE TABLE workspaces',
    'CREATE TABLE workspace_preferences',
    'CREATE TABLE workspace_app_state',
    'CREATE TABLE inbox_entries',
    'workspace:get-snapshot',
    'workspace:update-preferences',
    'inbox:get-snapshot',
    'inbox:create',
    'inbox:categorize',
    'inbox:archive',
    'inbox:undo-archive',
    'inbox:capture-requested',
    'task:get-snapshot',
    'task:create',
    'task:rename',
    'task:update-status',
    'task:update-planning',
    'task:convert-inbox',
    'note:get-snapshot',
    'note:create',
    'note:update',
    'note:archive',
    'note:convert-inbox',
    'schedule:get-snapshot',
    'schedule:create',
    'schedule:update',
    'schedule:archive',
    'CREATE TABLE tasks',
    'source_inbox_entry_id',
    'date(planned_for) IS NOT NULL',
    'tasks_require_active_workspace_insert',
    'tasks_require_archived_inbox_source_insert',
    'tasks_prevent_archived_workspace_mutation',
    'tasks_prevent_archived_workspace_delete',
    'task requires an active workspace',
    'task inbox source must be archived',
    'archived workspace tasks are immutable',
    'CREATE TABLE notes',
    'CREATE TABLE schedule_items',
    'notes_require_active_workspace_insert',
    'notes_revision_must_advance',
    'notes_archived_row_is_immutable',
    'notes_require_archived_inbox_source_insert',
    'notes_prevent_task_source_reuse',
    'tasks_prevent_note_source_reuse',
    'notes_prevent_archived_workspace_mutation',
    'notes_prevent_delete',
    'inbox_prevent_linked_note_source_restore',
    'schedule_requires_active_workspace_insert',
    'schedule_date_is_immutable',
    'schedule_revision_must_advance',
    'schedule_archived_row_is_immutable',
    'schedule_prevent_archived_workspace_mutation',
    'schedule_prevent_delete',
    'date(scheduled_for) IS NOT NULL',
    'note requires an active workspace',
    'note inbox source must be archived',
    'archived workspace notes are immutable',
    'notes cannot be permanently deleted',
    'schedule item requires an active workspace',
    'archived workspace schedule is immutable',
    'schedule items cannot be permanently deleted',
    'before-input-event',
    'isComposing',
    'current workspace must be switched before archive',
    'inbox entry requires an active workspace',
    'archived workspace inbox is immutable',
  ]) {
    assert.ok(
      mainBundle.includes(requiredToken),
      `Packaged main bundle does not contain the database runtime token ${requiredToken}.`,
    );
  }
  for (const shortcutToken of ['before-input-event', 'isComposing']) {
    assert.ok(
      countOccurrences(mainBundle, shortcutToken) >= 2,
      `Packaged main bundle does not contain both quick-capture interception paths for ${shortcutToken}.`,
    );
  }

  const preloadBundle = await readFile(path.join(asarPath, '.vite', 'build', 'preload.js'), 'utf8');
  for (const requiredToken of [
    'workspace:get-snapshot',
    'workspace:update-preferences',
    'inbox:get-snapshot',
    'inbox:create',
    'inbox:categorize',
    'inbox:archive',
    'inbox:undo-archive',
    'inbox:capture-requested',
    'task:get-snapshot',
    'task:create',
    'task:rename',
    'task:update-status',
    'task:update-planning',
    'task:convert-inbox',
    'note:get-snapshot',
    'note:create',
    'note:update',
    'note:archive',
    'note:convert-inbox',
    'schedule:get-snapshot',
    'schedule:create',
    'schedule:update',
    'schedule:archive',
  ]) {
    assert.ok(
      preloadBundle.includes(requiredToken),
      `Packaged preload bundle does not contain the required IPC token ${requiredToken}.`,
    );
  }

  const rendererBundle = await readRendererText(
    path.join(asarPath, '.vite', 'renderer', 'main_window'),
  );
  for (const forbiddenToken of [
    'daily.today.tasks',
    'task-workbench-shell',
    'task-review-wiki',
    'task-backup-server',
    'task-site-copy',
    'Daily Workbench 产品方向',
    'Electron 安全边界',
    '公司 Wiki 试点计划',
    '完成个人网站的基础优化，下一步关注内容和长期维护',
  ]) {
    assert.equal(
      rendererBundle.includes(forbiddenToken),
      false,
      `Packaged renderer still contains the legacy demo-task token ${forbiddenToken}.`,
    );
  }
}

async function readRendererText(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const content = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      content.push(await readRendererText(entryPath));
    } else if (entry.isFile() && /\.(?:css|html|js)$/u.test(entry.name)) {
      content.push(await readFile(entryPath, 'utf8'));
    }
  }
  return content.join('\n');
}

function countOccurrences(value, token) {
  return value.split(token).length - 1;
}

async function removeSmokeDirectory(smokeDirectory) {
  const expectedPrefix = path.join(os.tmpdir(), 'daily-workbench-db-smoke-');
  assert.ok(
    smokeDirectory.startsWith(expectedPrefix),
    `Refusing to clean an unexpected smoke-test path: ${smokeDirectory}`,
  );
  await rm(smokeDirectory, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 5 : 0,
    retryDelay: 200,
  });
}
