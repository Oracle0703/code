import {
  backup,
  constants,
  DatabaseSync,
  type SQLInputValue,
  type StatementResultingChanges,
} from 'node:sqlite';
import { DatabaseStateError } from './errors';

export interface SqliteAdapterOptions {
  readonly readOnly?: boolean;
  readonly timeoutMs?: number;
}

export interface SqliteAdapter {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  readonly location: string | null;
  open(): void;
  close(): void;
  exec(sql: string): void;
  execMigration(sql: string): void;
  run(sql: string, parameters?: readonly SQLInputValue[]): StatementResultingChanges;
  get<T>(sql: string, parameters?: readonly SQLInputValue[]): T | undefined;
  all<T>(sql: string, parameters?: readonly SQLInputValue[]): T[];
  backupTo(destinationPath: string): Promise<number>;
}

export type SqliteAdapterFactory = (
  databasePath: string,
  options?: SqliteAdapterOptions,
) => SqliteAdapter;

export class NodeSqliteAdapter implements SqliteAdapter {
  readonly #database: DatabaseSync;

  constructor(databasePath: string, options: SqliteAdapterOptions = {}) {
    this.#database = new DatabaseSync(databasePath, {
      open: false,
      readOnly: options.readOnly ?? false,
      timeout: options.timeoutMs ?? 5_000,
      allowExtension: false,
      allowBareNamedParameters: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      allowUnknownNamedParameters: false,
      defensive: true,
    });
  }

  get isOpen(): boolean {
    return this.#database.isOpen;
  }

  get location(): string | null {
    return this.#database.location();
  }

  get isTransaction(): boolean {
    return this.#database.isTransaction;
  }

  open(): void {
    if (!this.#database.isOpen) {
      this.#database.open();
    }
  }

  close(): void {
    if (this.#database.isOpen) {
      this.#database.close();
    }
  }

  exec(sql: string): void {
    this.assertOpen();
    this.#database.exec(sql);
  }

  execMigration(sql: string): void {
    this.assertOpen();
    this.#database.setAuthorizer((actionCode, pragmaName, pragmaValue) => {
      const isFtsReadOnlyDataVersion =
        actionCode === constants.SQLITE_PRAGMA &&
        pragmaName === 'data_version' &&
        pragmaValue === null;
      if (
        actionCode === constants.SQLITE_TRANSACTION ||
        actionCode === constants.SQLITE_SAVEPOINT ||
        (actionCode === constants.SQLITE_PRAGMA && !isFtsReadOnlyDataVersion) ||
        actionCode === constants.SQLITE_ATTACH ||
        actionCode === constants.SQLITE_DETACH
      ) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    try {
      this.#database.exec(sql);
    } finally {
      this.#database.setAuthorizer(null);
    }
  }

  run(sql: string, parameters: readonly SQLInputValue[] = []): StatementResultingChanges {
    this.assertOpen();
    return this.#database.prepare(sql).run(...parameters);
  }

  get<T>(sql: string, parameters: readonly SQLInputValue[] = []): T | undefined {
    this.assertOpen();
    return this.#database.prepare(sql).get(...parameters) as T | undefined;
  }

  all<T>(sql: string, parameters: readonly SQLInputValue[] = []): T[] {
    this.assertOpen();
    return this.#database.prepare(sql).all(...parameters) as T[];
  }

  async backupTo(destinationPath: string): Promise<number> {
    this.assertOpen();
    return backup(this.#database, destinationPath);
  }

  private assertOpen(): void {
    if (!this.#database.isOpen) {
      throw new DatabaseStateError('The SQLite connection is not open.');
    }
  }
}

export const createNodeSqliteAdapter: SqliteAdapterFactory = (databasePath, options) =>
  new NodeSqliteAdapter(databasePath, options);

export function configureDesktopPragmas(database: SqliteAdapter): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
  `);
}
