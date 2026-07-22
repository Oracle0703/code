import { randomUUID } from 'node:crypto';
import { DatabaseIntegrityError } from './errors';
import type { SqliteAdapter } from './sqlite-adapter';
import type { DatabaseMetadata } from './types';

interface MetadataRow {
  key: unknown;
  value: unknown;
}

const METADATA_KEYS = ['database_id', 'created_at', 'last_opened_at'] as const;

export class MetadataRepository {
  readonly #database: SqliteAdapter;

  constructor(database: SqliteAdapter) {
    this.#database = database;
  }

  initialize(now: string = new Date().toISOString(), id: string = randomUUID()): DatabaseMetadata {
    if (!isIsoTimestamp(now) || !isUuid(id)) {
      throw new DatabaseIntegrityError('Database metadata inputs are invalid.');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#insertIfMissing('database_id', id, now);
      this.#insertIfMissing('created_at', now, now);
      this.#database.run(
        `INSERT INTO app_metadata (key, value, updated_at)
         VALUES ('last_opened_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [now, now],
      );
      const metadata = this.read();
      this.#database.exec('COMMIT');
      return metadata;
    } catch (error) {
      try {
        if (this.#database.isTransaction) {
          this.#database.exec('ROLLBACK');
        }
      } catch {
        // Preserve the original repository error.
      }
      throw new DatabaseIntegrityError('Database metadata could not be initialized.', {
        cause: error,
      });
    }
  }

  read(): DatabaseMetadata {
    const rows = this.#database.all<MetadataRow>(
      `SELECT key, value
       FROM app_metadata
       WHERE key IN ('database_id', 'created_at', 'last_opened_at')`,
    );
    const values = new Map<string, string>();
    for (const row of rows) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string') {
        throw new DatabaseIntegrityError('Database metadata contains invalid value types.');
      }
      values.set(row.key, row.value);
    }
    const databaseId = values.get(METADATA_KEYS[0]);
    const createdAt = values.get(METADATA_KEYS[1]);
    const lastOpenedAt = values.get(METADATA_KEYS[2]);

    if (
      !databaseId ||
      !isUuid(databaseId) ||
      !createdAt ||
      !isIsoTimestamp(createdAt) ||
      !lastOpenedAt ||
      !isIsoTimestamp(lastOpenedAt)
    ) {
      throw new DatabaseIntegrityError('Database metadata is incomplete or invalid.');
    }

    return { databaseId, createdAt, lastOpenedAt };
  }

  #insertIfMissing(key: string, value: string, updatedAt: string): void {
    this.#database.run(
      `INSERT INTO app_metadata (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
      [key, value, updatedAt],
    );
  }
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
