export interface DatabasePaths {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly backupDirectory: string;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface MigrationPlan {
  readonly currentVersion: number;
  readonly pending: readonly Migration[];
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly AppliedMigration[];
}

export type BackupReason = 'manual' | 'pre-migration';

export interface BackupResult {
  readonly id: string;
  readonly fileName: string;
  readonly path: string;
  readonly reason: BackupReason;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly schemaVersion: number;
  readonly pages: number;
}

export interface DatabaseMetadata {
  readonly databaseId: string;
  readonly createdAt: string;
  readonly lastOpenedAt: string;
}

export interface DatabaseHealth {
  readonly status: 'ok';
  readonly databasePath: string;
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
  readonly databaseId: string;
}

export interface DatabaseInitializationResult {
  readonly health: DatabaseHealth;
  readonly migration: MigrationResult;
  readonly preMigrationBackup?: BackupResult;
}
