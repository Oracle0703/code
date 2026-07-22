import { randomUUID } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  DatabaseBackupInfo,
  DatabaseStatus,
  WorkspaceCreateInput,
  WorkspacePreferences,
  WorkspacePreferencesInput,
  WorkspaceRenameInput,
  WorkspaceSnapshot,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import { WorkspaceService } from '../workspaces';
import { BackupManager, toDatabaseBackupInfo } from './backup-manager';
import { DEFAULT_MIGRATIONS } from './default-migrations';
import {
  DatabaseError,
  DatabaseIntegrityError,
  DatabaseOpenError,
  DatabasePathError,
  DatabaseStateError,
} from './errors';
import { MetadataRepository } from './metadata-repository';
import { MigrationRunner } from './migration-runner';
import { databaseFileExists, prepareDatabaseDirectories, resolveDatabasePaths } from './paths';
import {
  configureDesktopPragmas,
  createNodeSqliteAdapter,
  type SqliteAdapter,
  type SqliteAdapterFactory,
} from './sqlite-adapter';
import type {
  BackupResult,
  DatabaseHealth,
  DatabaseInitializationResult,
  Migration,
} from './types';

interface TextRow {
  value: string;
}

interface IntegrityRow {
  quick_check: string;
}

interface CheckpointRow {
  busy: unknown;
  log: unknown;
  checkpointed: unknown;
}

interface DatabaseFoundationHealth {
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly latestMigrationVersion: number;
  readonly appliedMigrations: number;
  readonly journalMode: 'wal';
  readonly foreignKeys: true;
  readonly busyTimeoutMs: number;
  readonly synchronous: 'normal';
  readonly trustedSchema: false;
  readonly integrity: 'ok';
}

export interface DatabaseServiceOptions {
  readonly dataDirectory: string;
  readonly databaseFileName?: string;
  readonly migrations?: readonly Migration[];
  readonly adapterFactory?: SqliteAdapterFactory;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly workspaceIdFactory?: () => string;
}

type ServiceState = 'closed' | 'opening' | 'open' | 'closing' | 'poisoned';

export class DatabaseService {
  readonly #paths;
  readonly #adapterFactory: SqliteAdapterFactory;
  readonly #migrationRunner: MigrationRunner;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #workspaceService: WorkspaceService;
  #state: ServiceState = 'closed';
  #database: SqliteAdapter | undefined;
  #backupManager: BackupManager | undefined;
  #initialization: DatabaseInitializationResult | undefined;
  #openPromise: Promise<DatabaseInitializationResult> | undefined;
  #closePromise: Promise<void> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #fatalOperationError: DatabaseIntegrityError | undefined;

  constructor({
    dataDirectory,
    databaseFileName,
    migrations = DEFAULT_MIGRATIONS,
    adapterFactory = createNodeSqliteAdapter,
    now = () => new Date(),
    idFactory = randomUUID,
    workspaceIdFactory = randomUUID,
  }: DatabaseServiceOptions) {
    this.#paths = resolveDatabasePaths(dataDirectory, databaseFileName);
    this.#adapterFactory = adapterFactory;
    this.#migrationRunner = new MigrationRunner(migrations);
    this.#now = now;
    this.#idFactory = idFactory;
    this.#workspaceService = new WorkspaceService({
      execute: (operation) => this.#enqueue((database) => operation(database)),
      now,
      idFactory: workspaceIdFactory,
      onFatalTransaction: (error) => this.#markPoisoned(error),
    });
  }

  async open(): Promise<DatabaseInitializationResult> {
    if (this.#state === 'open' && this.#initialization) {
      return this.#initialization;
    }
    if (this.#state === 'opening' && this.#openPromise) {
      return this.#openPromise;
    }
    if (this.#state === 'closing') {
      throw new DatabaseStateError('The database is closing.');
    }
    if (this.#state === 'poisoned' || this.#fatalOperationError) {
      throw new DatabaseStateError(
        'The database entered a fatal state and must be closed before it can reopen.',
        { cause: this.#fatalOperationError },
      );
    }

    this.#fatalOperationError = undefined;
    this.#state = 'opening';
    this.#openPromise = this.#initialize();
    try {
      const result = await this.#openPromise;
      this.#initialization = result;
      this.#state = 'open';
      return result;
    } catch (error) {
      this.#database?.close();
      this.#database = undefined;
      this.#backupManager = undefined;
      this.#initialization = undefined;
      this.#fatalOperationError = undefined;
      this.#state = 'closed';
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseOpenError('The database could not be opened.', { cause: error });
    } finally {
      this.#openPromise = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#state === 'closed') {
      return;
    }
    if (this.#state === 'opening' && this.#openPromise) {
      try {
        await this.#openPromise;
      } catch {
        return;
      }
      return this.close();
    }
    if (this.#state === 'closing' && this.#closePromise) {
      return this.#closePromise;
    }

    this.#state = 'closing';
    this.#closePromise = (async () => {
      await this.#operationTail;
      const database = this.#database;
      let closeError: unknown;
      if (database?.isOpen) {
        try {
          const checkpoint = database.get<CheckpointRow>('PRAGMA wal_checkpoint(TRUNCATE)');
          if (
            !checkpoint ||
            !isNonNegativeInteger(checkpoint.busy) ||
            !isNonNegativeInteger(checkpoint.log) ||
            !isNonNegativeInteger(checkpoint.checkpointed) ||
            checkpoint.busy !== 0
          ) {
            throw new DatabaseIntegrityError(
              'The SQLite WAL could not be fully checkpointed during shutdown.',
            );
          }
        } catch (error) {
          closeError = error;
        }
        try {
          database.close();
        } catch (error) {
          closeError ??= error;
        }
      }
      this.#database = undefined;
      this.#backupManager = undefined;
      this.#initialization = undefined;
      this.#fatalOperationError = undefined;
      this.#state = 'closed';
      this.#closePromise = undefined;
      if (closeError) {
        throw new DatabaseOpenError('The database could not be checkpointed during shutdown.', {
          cause: closeError,
        });
      }
    })();
    return this.#closePromise;
  }

  getStatus(): Promise<DatabaseStatus> {
    return this.#enqueue(async (database, backups) => {
      const health = this.#readHealth(database);
      return {
        schemaVersion: health.schemaVersion,
        appliedMigrations: health.appliedMigrations,
        sqliteVersion: health.sqliteVersion,
        journalMode: health.journalMode,
        integrityCheck: health.integrity,
        backupCount: await backups.count(),
      };
    });
  }

  createBackup(): Promise<DatabaseBackupInfo> {
    return this.#enqueue(async (database, backups) => {
      const schemaVersion = this.#migrationRunner.validateApplied(database).length;
      const result = await backups.create(database, 'manual', schemaVersion);
      return toDatabaseBackupInfo(result);
    });
  }

  listBackups(): Promise<DatabaseBackupInfo[]> {
    return this.#enqueue((_database, backups) => backups.list());
  }

  getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.getSnapshot();
  }

  createWorkspace(input: WorkspaceCreateInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.create(input);
  }

  renameWorkspace(input: WorkspaceRenameInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.rename(input);
  }

  activateWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.activate(input);
  }

  archiveWorkspace(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot> {
    return this.#workspaceService.archive(input);
  }

  updateWorkspacePreferences(input: WorkspacePreferencesInput): Promise<WorkspacePreferences> {
    return this.#workspaceService.updatePreferences(input);
  }

  async #initialize(): Promise<DatabaseInitializationResult> {
    await prepareDatabaseDirectories(this.#paths);
    const existed = await databaseFileExists(this.#paths.databasePath);
    const existingSize = existed ? (await lstat(this.#paths.databasePath)).size : 0;
    const database = this.#adapterFactory(this.#paths.databasePath, { timeoutMs: 5_000 });
    this.#database = database;

    try {
      database.open();
      await assertOpenedDatabasePath(database, this.#paths.databasePath);
      await chmod(this.#paths.databasePath, 0o600);
      configureDesktopPragmas(database);

      const backups = new BackupManager({
        paths: this.#paths,
        adapterFactory: this.#adapterFactory,
        validateSnapshot: (snapshot, version) => this.#validateSnapshot(snapshot, version),
        now: this.#now,
        idFactory: this.#idFactory,
      });
      this.#backupManager = backups;

      const plan = this.#migrationRunner.plan(database);
      let preMigrationBackup: BackupResult | undefined;
      if (existingSize > 0 && plan.pending.length > 0) {
        preMigrationBackup = await backups.create(database, 'pre-migration', plan.currentVersion);
      }

      const migration = this.#migrationRunner.apply(database);
      this.#readFoundationHealth(database);
      const openedAt = this.#now().toISOString();
      database.exec('BEGIN IMMEDIATE');
      let health: DatabaseHealth;
      try {
        new MetadataRepository(database).initializeWithinTransaction(openedAt, this.#idFactory());
        this.#workspaceService.initializeWithinTransaction(database, openedAt);
        health = this.#readHealth(database);
        database.exec('COMMIT');
      } catch (error) {
        try {
          if (database.isTransaction) {
            database.exec('ROLLBACK');
          }
        } catch {
          // Preserve the startup integrity error.
        }
        throw error;
      }

      return { health, migration, preMigrationBackup };
    } catch (error) {
      database.close();
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseOpenError('The database could not be initialized.', { cause: error });
    }
  }

  #enqueue<T>(
    operation: (database: SqliteAdapter, backups: BackupManager) => Promise<T> | T,
  ): Promise<T> {
    if (this.#state === 'poisoned' || this.#fatalOperationError) {
      return Promise.reject(
        new DatabaseStateError('The database is unavailable after a fatal transaction failure.', {
          cause: this.#fatalOperationError,
        }),
      );
    }
    if (this.#state !== 'open' || !this.#database || !this.#backupManager) {
      return Promise.reject(new DatabaseStateError('The database is not open.'));
    }

    const database = this.#database;
    const backups = this.#backupManager;
    const result = this.#operationTail.then(() => {
      if (this.#fatalOperationError) {
        throw new DatabaseStateError(
          'The database is unavailable after a fatal transaction failure.',
          { cause: this.#fatalOperationError },
        );
      }
      return operation(database, backups);
    });
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #markPoisoned(error: DatabaseIntegrityError): void {
    this.#fatalOperationError = error;
    if (this.#state === 'open') {
      this.#state = 'poisoned';
    }
  }

  #validateSnapshot(database: SqliteAdapter, expectedVersion: number): void {
    const applied = this.#migrationRunner.validateApplied(database);
    if (applied.length !== expectedVersion) {
      throw new DatabaseIntegrityError('The database backup schema version is invalid.');
    }
    assertIntegrity(database);
    if (expectedVersion > 0) {
      new MetadataRepository(database).read();
    }
    if (expectedVersion >= 2) {
      this.#workspaceService.validateSnapshot(database);
    }
  }

  #readHealth(database: SqliteAdapter): DatabaseHealth {
    const foundation = this.#readFoundationHealth(database);
    const metadata = new MetadataRepository(database).read();
    return {
      status: 'ok',
      databasePath: this.#paths.databasePath,
      ...foundation,
      databaseId: metadata.databaseId,
    };
  }

  #readFoundationHealth(database: SqliteAdapter): DatabaseFoundationHealth {
    const applied = this.#migrationRunner.validateApplied(database);
    assertIntegrity(database);

    const sqliteVersion = readTextValue(database, 'SELECT sqlite_version() AS value');
    const journalMode = readPragmaText(database, 'journal_mode').toLowerCase();
    const foreignKeys = readPragmaNumber(database, 'foreign_keys', 'foreign_keys');
    const busyTimeoutMs = readPragmaNumber(database, 'busy_timeout', 'timeout');
    const synchronous = readPragmaNumber(database, 'synchronous', 'synchronous');
    const trustedSchema = readPragmaNumber(database, 'trusted_schema', 'trusted_schema');
    if (
      journalMode !== 'wal' ||
      foreignKeys !== 1 ||
      busyTimeoutMs !== 5_000 ||
      synchronous !== 1 ||
      trustedSchema !== 0
    ) {
      throw new DatabaseIntegrityError('The database connection safety settings are invalid.');
    }

    return {
      sqliteVersion,
      schemaVersion: applied.length,
      latestMigrationVersion: this.#migrationRunner.latestVersion,
      appliedMigrations: applied.length,
      journalMode,
      foreignKeys: true,
      busyTimeoutMs,
      synchronous: 'normal',
      trustedSchema: false,
      integrity: 'ok',
    };
  }
}

async function assertOpenedDatabasePath(
  database: SqliteAdapter,
  expectedPath: string,
): Promise<void> {
  const location = database.location;
  if (!location || resolve(location) !== expectedPath) {
    throw new DatabasePathError('The opened database resolved outside its controlled path.');
  }
  const entry = await lstat(expectedPath).catch((error: unknown) => {
    throw new DatabasePathError('The opened database file could not be inspected.', {
      cause: error,
    });
  });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new DatabasePathError('The opened database path must remain a regular file.');
  }
}

function assertIntegrity(database: SqliteAdapter): void {
  const quickCheck = database.all<IntegrityRow>('PRAGMA quick_check');
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new DatabaseIntegrityError('The SQLite quick check failed.');
  }
  if (database.all<Record<string, unknown>>('PRAGMA foreign_key_check').length !== 0) {
    throw new DatabaseIntegrityError('The SQLite foreign-key check failed.');
  }
}

function readTextValue(database: SqliteAdapter, sql: string): string {
  const row = database.get<TextRow>(sql);
  if (!row || typeof row.value !== 'string' || row.value.length === 0) {
    throw new DatabaseIntegrityError('SQLite returned an invalid text status value.');
  }
  return row.value;
}

function readPragmaText(database: SqliteAdapter, pragma: 'journal_mode'): string {
  const row = database.get<Record<string, unknown>>(`PRAGMA ${pragma}`);
  const value = row?.[pragma];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${pragma} value.`);
  }
  return value;
}

function readPragmaNumber(
  database: SqliteAdapter,
  pragma: 'busy_timeout' | 'foreign_keys' | 'synchronous' | 'trusted_schema',
  field: 'foreign_keys' | 'synchronous' | 'timeout' | 'trusted_schema',
): number {
  const row = database.get<Record<string, unknown>>(`PRAGMA ${pragma}`);
  const value = row?.[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DatabaseIntegrityError(`SQLite returned an invalid ${pragma} value.`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
