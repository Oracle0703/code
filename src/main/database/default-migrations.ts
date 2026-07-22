import databaseFoundationSql from '../../../migrations/0001_database_foundation.sql?raw';
import workspacesSql from '../../../migrations/0002_workspaces.sql?raw';
import type { Migration } from './types';

export const DEFAULT_MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'database_foundation',
    sql: databaseFoundationSql,
  }),
  Object.freeze({
    version: 2,
    name: 'workspaces',
    sql: workspacesSql,
  }),
]);
