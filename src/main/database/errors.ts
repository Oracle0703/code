export type DatabaseErrorCode =
  | 'DATABASE_BACKUP_FAILED'
  | 'DATABASE_INTEGRITY_FAILED'
  | 'DATABASE_MIGRATION_FAILED'
  | 'DATABASE_OPEN_FAILED'
  | 'DATABASE_PATH_INVALID'
  | 'DATABASE_STATE_INVALID';

export class DatabaseError extends Error {
  readonly code: DatabaseErrorCode;

  constructor(code: DatabaseErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class DatabasePathError extends DatabaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('DATABASE_PATH_INVALID', message, options);
  }
}

export class DatabaseStateError extends DatabaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('DATABASE_STATE_INVALID', message, options);
  }
}

export class DatabaseOpenError extends DatabaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('DATABASE_OPEN_FAILED', message, options);
  }
}

export class DatabaseMigrationError extends DatabaseError {
  readonly version?: number;

  constructor(message: string, version?: number, options?: ErrorOptions) {
    super('DATABASE_MIGRATION_FAILED', message, options);
    this.version = version;
  }
}

export class DatabaseBackupError extends DatabaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('DATABASE_BACKUP_FAILED', message, options);
  }
}

export class DatabaseIntegrityError extends DatabaseError {
  constructor(message: string, options?: ErrorOptions) {
    super('DATABASE_INTEGRITY_FAILED', message, options);
  }
}
