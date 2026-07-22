const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, stat } = require('node:fs/promises');
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
    'schema_migrations',
    'CREATE TABLE app_metadata',
    'CREATE TABLE workspaces',
    'CREATE TABLE workspace_preferences',
    'CREATE TABLE workspace_app_state',
    'workspace:get-snapshot',
    'workspace:update-preferences',
    'current workspace must be switched before archive',
  ]) {
    assert.ok(
      mainBundle.includes(requiredToken),
      `Packaged main bundle does not contain the database runtime token ${requiredToken}.`,
    );
  }

  const preloadBundle = await readFile(path.join(asarPath, '.vite', 'build', 'preload.js'), 'utf8');
  for (const requiredToken of ['workspace:get-snapshot', 'workspace:update-preferences']) {
    assert.ok(
      preloadBundle.includes(requiredToken),
      `Packaged preload bundle does not contain the workspace IPC token ${requiredToken}.`,
    );
  }
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
