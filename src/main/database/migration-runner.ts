import { createHash } from 'node:crypto';
import { DatabaseMigrationError } from './errors';
import type { SqliteAdapter } from './sqlite-adapter';
import type { AppliedMigration, Migration, MigrationPlan, MigrationResult } from './types';

const MIGRATION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
}

interface FoundRow {
  found: number;
}

export const DAILY_WORKBENCH_APPLICATION_ID = 0x44574231;

export class MigrationRunner {
  readonly #migrations: readonly Migration[];

  constructor(migrations: readonly Migration[]) {
    this.#migrations = validateMigrationDefinitions(migrations);
  }

  get latestVersion(): number {
    return this.#migrations.length;
  }

  plan(database: SqliteAdapter): MigrationPlan {
    try {
      return this.#createPlan(database);
    } catch (error) {
      if (error instanceof DatabaseMigrationError) {
        throw error;
      }
      throw new DatabaseMigrationError(
        'The database migration plan could not be read.',
        undefined,
        { cause: error },
      );
    }
  }

  #createPlan(database: SqliteAdapter): MigrationPlan {
    const applied = this.readApplied(database);
    this.validateDatabaseIdentity(database, applied.length > 0);
    this.validateAppliedHistory(applied);

    const currentVersion = applied.at(-1)?.version ?? 0;
    const userVersion = readPragmaInteger(database, 'user_version');
    if (userVersion !== currentVersion) {
      throw new DatabaseMigrationError(
        'The SQLite user version does not match the migration history.',
      );
    }

    return {
      currentVersion,
      pending: this.#migrations.slice(currentVersion),
    };
  }

  apply(database: SqliteAdapter): MigrationResult {
    const plan = this.plan(database);
    if (plan.pending.length === 0) {
      return {
        fromVersion: plan.currentVersion,
        toVersion: plan.currentVersion,
        applied: [],
      };
    }

    const newlyApplied: AppliedMigration[] = [];
    let activeVersion: number | undefined;
    try {
      database.exec('BEGIN IMMEDIATE');
      if (!database.isTransaction) {
        throw new DatabaseMigrationError('SQLite did not begin the migration transaction.');
      }
      createMigrationLedger(database);

      for (const migration of plan.pending) {
        activeVersion = migration.version;
        database.execMigration(migration.sql);
        if (!database.isTransaction) {
          throw new DatabaseMigrationError(
            `Database migration ${migration.version} escaped its transaction.`,
            migration.version,
          );
        }
        const appliedAt = new Date().toISOString();
        const checksum = checksumMigration(migration);
        database.run(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
          [migration.version, migration.name, checksum, appliedAt],
        );
        database.exec(`PRAGMA user_version = ${migration.version}`);
        newlyApplied.push({
          version: migration.version,
          name: migration.name,
          checksum,
          appliedAt,
        });
      }

      database.exec(`PRAGMA application_id = ${DAILY_WORKBENCH_APPLICATION_ID}`);
      database.exec('COMMIT');
    } catch (error) {
      try {
        if (database.isTransaction) {
          database.exec('ROLLBACK');
        }
      } catch {
        // Keep the migration failure as the primary error.
      }
      throw new DatabaseMigrationError(
        activeVersion === undefined
          ? 'The database migration transaction failed.'
          : `Database migration ${activeVersion} failed.`,
        activeVersion,
        { cause: error },
      );
    }

    return {
      fromVersion: plan.currentVersion,
      toVersion: newlyApplied.at(-1)?.version ?? plan.currentVersion,
      applied: newlyApplied,
    };
  }

  readApplied(database: SqliteAdapter): AppliedMigration[] {
    const ledger = database.get<FoundRow>(
      `SELECT 1 AS found
       FROM sqlite_schema
       WHERE type = 'table' AND name = 'schema_migrations'`,
    );
    if (!ledger) {
      return [];
    }

    return database
      .all<MigrationRow>(
        `SELECT version, name, checksum, applied_at
         FROM schema_migrations
         ORDER BY version ASC`,
      )
      .map((row) => ({
        version: row.version,
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
      }));
  }

  validateApplied(database: SqliteAdapter): readonly AppliedMigration[] {
    const applied = this.readApplied(database);
    this.validateDatabaseIdentity(database, applied.length > 0);
    this.validateAppliedHistory(applied);
    const currentVersion = applied.at(-1)?.version ?? 0;
    if (readPragmaInteger(database, 'user_version') !== currentVersion) {
      throw new DatabaseMigrationError(
        'The SQLite user version does not match the migration history.',
      );
    }
    return applied;
  }

  private validateDatabaseIdentity(database: SqliteAdapter, hasHistory: boolean): void {
    const applicationId = readPragmaInteger(database, 'application_id');
    if (applicationId !== DAILY_WORKBENCH_APPLICATION_ID && !(applicationId === 0 && !hasHistory)) {
      throw new DatabaseMigrationError('The database belongs to a different application.');
    }
  }

  private validateAppliedHistory(applied: readonly AppliedMigration[]): void {
    for (const [index, row] of applied.entries()) {
      const expected = this.#migrations[index];
      if (!expected) {
        throw new DatabaseMigrationError(
          `Database schema version ${row.version} is newer than this application supports.`,
          row.version,
        );
      }
      if (row.version !== index + 1) {
        throw new DatabaseMigrationError('The migration history is not contiguous.', row.version);
      }
      if (row.name !== expected.name || row.checksum !== checksumMigration(expected)) {
        throw new DatabaseMigrationError(
          `Applied migration ${row.version} does not match the application migration.`,
          row.version,
        );
      }
      if (!isIsoTimestamp(row.appliedAt)) {
        throw new DatabaseMigrationError(
          `Applied migration ${row.version} has an invalid timestamp.`,
          row.version,
        );
      }
    }
  }
}

export function checksumMigration(migration: Migration): string {
  const canonicalSql = stripTrailingSqliteWhitespace(migration.sql.replace(/\r\n?/gu, '\n'));
  return createHash('sha256')
    .update(`${migration.version}\0${migration.name}\0${canonicalSql}`, 'utf8')
    .digest('hex');
}

function stripTrailingSqliteWhitespace(value: string): string {
  let end = value.length;
  while (end > 0) {
    const codePoint = value.charCodeAt(end - 1);
    if (codePoint !== 0x20 && (codePoint < 0x09 || codePoint > 0x0d)) {
      break;
    }
    end -= 1;
  }
  return value.slice(0, end);
}

function validateMigrationDefinitions(migrations: readonly Migration[]): readonly Migration[] {
  const names = new Set<string>();
  return Object.freeze(
    migrations.map((migration, index) => {
      const expectedVersion = index + 1;
      if (migration.version !== expectedVersion || !Number.isSafeInteger(migration.version)) {
        throw new DatabaseMigrationError(
          `Migration versions must be contiguous from 1; expected ${expectedVersion}.`,
          migration.version,
        );
      }
      if (!MIGRATION_NAME_PATTERN.test(migration.name)) {
        throw new DatabaseMigrationError(
          `Migration ${migration.version} has an invalid name.`,
          migration.version,
        );
      }
      if (names.has(migration.name)) {
        throw new DatabaseMigrationError(
          `Migration ${migration.version} repeats an earlier name.`,
          migration.version,
        );
      }
      names.add(migration.name);
      if (migration.sql.trim().length === 0) {
        throw new DatabaseMigrationError(
          `Migration ${migration.version} has no SQL.`,
          migration.version,
        );
      }
      return Object.freeze({ ...migration });
    }),
  );
}

function createMigrationLedger(database: SqliteAdapter): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL CHECK (version > 0),
      name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 64),
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

function readPragmaInteger(
  database: SqliteAdapter,
  pragma: 'application_id' | 'user_version',
): number {
  const row = database.get<Record<string, unknown>>(`PRAGMA ${pragma}`);
  const value = row?.[pragma];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DatabaseMigrationError(`SQLite returned an invalid ${pragma} value.`);
  }
  return value;
}

function isIsoTimestamp(value: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
