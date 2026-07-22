import { randomUUID } from 'node:crypto';
import {
  WORKSPACE_COLORS,
  type WorkspaceCreateInput,
  type WorkspacePreferences,
  type WorkspacePreferencesInput,
  type WorkspaceRenameInput,
  type WorkspaceSnapshot,
  type WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  normalizeWorkspaceColor,
  normalizeWorkspaceId,
  normalizeWorkspaceName,
  normalizeWorkspacePreferencesPatch,
} from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import {
  WorkspaceConflictError,
  WorkspaceError,
  WorkspaceNotFoundError,
  WorkspaceOperationError,
  WorkspaceValidationError,
} from './workspace-errors';
import { WorkspaceRepository } from './workspace-repository';

export type WorkspaceOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface WorkspaceServiceOptions {
  readonly execute: WorkspaceOperationExecutor;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

export class WorkspaceService {
  readonly #execute: WorkspaceOperationExecutor;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #onFatalTransaction: (error: DatabaseIntegrityError) => void;

  constructor({
    execute,
    now = () => new Date(),
    idFactory = randomUUID,
    onFatalTransaction = () => undefined,
  }: WorkspaceServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#onFatalTransaction = onFatalTransaction;
  }

  initialize(database: SqliteAdapter, openedAt?: string): WorkspaceSnapshot {
    return this.#transaction(database, 'initialize', (repository) =>
      this.#initializeRepository(repository, openedAt),
    );
  }

  initializeWithinTransaction(database: SqliteAdapter, openedAt: string): WorkspaceSnapshot {
    if (!database.isTransaction) {
      throw new DatabaseIntegrityError('Workspace initialization requires an active transaction.');
    }
    try {
      return this.#initializeRepository(new WorkspaceRepository(database), openedAt);
    } catch (error) {
      if (error instanceof WorkspaceError || error instanceof DatabaseIntegrityError) {
        throw error;
      }
      throw new WorkspaceOperationError('The workspace could not initialize.', { cause: error });
    }
  }

  validateSnapshot(database: SqliteAdapter): WorkspaceSnapshot {
    return new WorkspaceRepository(database).validateIntegrity();
  }

  getSnapshot(): Promise<WorkspaceSnapshot> {
    return this.#execute((database) => new WorkspaceRepository(database).readSnapshot());
  }

  create(input: WorkspaceCreateInput): Promise<WorkspaceSnapshot> {
    const name = this.#name(input?.name);
    const color = this.#color(input?.color);
    return this.#execute((database) =>
      this.#transaction(database, 'create', (repository) => {
        if (repository.activeNameExists(name)) {
          throw new WorkspaceConflictError('An active workspace already uses this name.');
        }
        const timestamp = this.#timestamp();
        const workspaceId = this.#workspaceId();
        repository.insertWorkspace({ id: workspaceId, name, color, timestamp });
        repository.setCurrent(workspaceId, timestamp);
        return repository.readSnapshot();
      }),
    );
  }

  rename(input: WorkspaceRenameInput): Promise<WorkspaceSnapshot> {
    const workspaceId = this.#workspaceIdFromInput(input?.workspaceId);
    const name = this.#name(input?.name);
    return this.#execute((database) =>
      this.#transaction(database, 'rename', (repository) => {
        const workspace = this.#requireActive(repository, workspaceId);
        if (workspace.name === name) {
          return repository.readSnapshot();
        }
        if (repository.activeNameExists(name, workspaceId)) {
          throw new WorkspaceConflictError('An active workspace already uses this name.');
        }
        repository.rename(workspaceId, name, this.#timestamp());
        return repository.readSnapshot();
      }),
    );
  }

  activate(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot> {
    const workspaceId = this.#workspaceIdFromInput(input?.workspaceId);
    return this.#execute((database) =>
      this.#transaction(database, 'activate', (repository) => {
        this.#requireActive(repository, workspaceId);
        if (repository.readCurrentWorkspaceId() !== workspaceId) {
          repository.setCurrent(workspaceId, this.#timestamp());
        }
        return repository.readSnapshot();
      }),
    );
  }

  archive(input: WorkspaceTargetInput): Promise<WorkspaceSnapshot> {
    const workspaceId = this.#workspaceIdFromInput(input?.workspaceId);
    return this.#execute((database) =>
      this.#transaction(database, 'archive', (repository) => {
        const workspace = this.#requireActive(repository, workspaceId);
        if (repository.countActive() <= 1) {
          throw new WorkspaceConflictError('The last active workspace cannot be archived.');
        }
        const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
        if (repository.readCurrentWorkspaceId() === workspaceId) {
          const fallback = repository.findFallback(workspaceId);
          if (!fallback) {
            throw new DatabaseIntegrityError('An archive fallback workspace is missing.');
          }
          repository.setCurrent(fallback.id, timestamp);
        }
        repository.archive(workspaceId, timestamp);
        return repository.readSnapshot();
      }),
    );
  }

  updatePreferences(input: WorkspacePreferencesInput): Promise<WorkspacePreferences> {
    const workspaceId = this.#workspaceIdFromInput(input?.workspaceId);
    let patch;
    try {
      patch = normalizeWorkspacePreferencesPatch(input?.patch);
    } catch (error) {
      throw new WorkspaceValidationError('Workspace preferences are invalid.', { cause: error });
    }
    return this.#execute((database) =>
      this.#transaction(database, 'update preferences', (repository) => {
        this.#requireActive(repository, workspaceId);
        const preferences = { ...repository.readPreferences(workspaceId), ...patch };
        repository.updatePreferences(workspaceId, preferences, this.#timestamp());
        return repository.readPreferences(workspaceId);
      }),
    );
  }

  #transaction<T>(
    database: SqliteAdapter,
    operation: string,
    callback: (repository: WorkspaceRepository) => T,
  ): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError(
          'A workspace operation encountered an unexpected active transaction.',
        );
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(new WorkspaceRepository(database));
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The workspace operation escaped its transaction.');
      }
      commitStarted = true;
      database.exec('COMMIT');
      return result;
    } catch (error) {
      const transactionActiveAtFailure = database.isTransaction;
      let rollbackError: unknown;
      try {
        if (transactionStarted && transactionActiveAtFailure) {
          database.exec('ROLLBACK');
        }
      } catch (caughtRollbackError) {
        rollbackError = caughtRollbackError;
      }
      const transactionRemainsActive = database.isTransaction;
      const commitOutcomeUnknown = commitStarted && !transactionActiveAtFailure;
      if (
        rollbackError !== undefined ||
        transactionRemainsActive ||
        transactionEscaped ||
        commitOutcomeUnknown
      ) {
        const cause =
          rollbackError === undefined
            ? error
            : new AggregateError(
                [error, rollbackError],
                'The workspace operation and its rollback both failed.',
              );
        const fatalError = new DatabaseIntegrityError(
          'The workspace transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof WorkspaceError || error instanceof DatabaseIntegrityError) {
        throw error;
      }
      throw new WorkspaceOperationError(`The workspace could not ${operation}.`, { cause: error });
    }
  }

  #requireActive(repository: WorkspaceRepository, workspaceId: string) {
    const workspace = repository.findActive(workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError();
    }
    return workspace;
  }

  #initializeRepository(repository: WorkspaceRepository, openedAt?: string): WorkspaceSnapshot {
    const workspaceCount = repository.countAll();
    const preferenceCount = repository.countPreferences();
    const stateCount = repository.countStateRows();
    if (workspaceCount === 0 && preferenceCount === 0 && stateCount === 0) {
      const timestamp = openedAt ? this.#validatedTimestamp(openedAt) : this.#timestamp();
      const workspaceId = this.#workspaceId();
      repository.insertWorkspace({
        id: workspaceId,
        name: '我的工作台',
        color: WORKSPACE_COLORS[0],
        timestamp,
      });
      repository.insertState(workspaceId, timestamp);
      return repository.readSnapshot();
    }
    return repository.validateIntegrity();
  }

  #workspaceId(): string {
    try {
      return normalizeWorkspaceId(this.#idFactory());
    } catch (error) {
      throw new WorkspaceValidationError('Generated workspace id is invalid.', { cause: error });
    }
  }

  #workspaceIdFromInput(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new WorkspaceValidationError('Workspace id is invalid.', { cause: error });
    }
  }

  #name(value: unknown): string {
    try {
      return normalizeWorkspaceName(value);
    } catch (error) {
      throw new WorkspaceValidationError('Workspace name is invalid.', { cause: error });
    }
  }

  #color(value: unknown) {
    try {
      return normalizeWorkspaceColor(value);
    } catch (error) {
      throw new WorkspaceValidationError('Workspace color is invalid.', { cause: error });
    }
  }

  #timestamp(): string {
    const timestamp = this.#now();
    if (!Number.isFinite(timestamp.getTime())) {
      throw new WorkspaceValidationError('Workspace timestamp is invalid.');
    }
    return timestamp.toISOString();
  }

  #timestampAtLeast(...lowerBounds: readonly string[]): string {
    const current = this.#timestamp();
    let latest = current;
    for (const lowerBound of lowerBounds) {
      const validated = this.#validatedTimestamp(lowerBound);
      if (validated > latest) {
        latest = validated;
      }
    }
    return latest;
  }

  #validatedTimestamp(value: string): string {
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
      throw new WorkspaceValidationError('Workspace timestamp is invalid.');
    }
    return value;
  }
}
