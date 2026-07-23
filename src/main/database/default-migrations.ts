import databaseFoundationSql from '../../../migrations/0001_database_foundation.sql?raw';
import workspacesSql from '../../../migrations/0002_workspaces.sql?raw';
import inboxSql from '../../../migrations/0003_inbox.sql?raw';
import tasksSql from '../../../migrations/0004_tasks.sql?raw';
import notesScheduleSql from '../../../migrations/0005_notes_schedule.sql?raw';
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
  Object.freeze({
    version: 3,
    name: 'inbox',
    sql: inboxSql,
  }),
  Object.freeze({
    version: 4,
    name: 'tasks',
    sql: tasksSql,
  }),
  Object.freeze({
    version: 5,
    name: 'notes_schedule',
    sql: notesScheduleSql,
  }),
]);
