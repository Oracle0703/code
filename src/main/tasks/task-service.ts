import { randomUUID } from 'node:crypto';
import type {
  TaskConversionResult,
  TaskConvertInboxInput,
  TaskCreateInput,
  TaskPlanning,
  TaskPlanningInput,
  TaskRenameInput,
  TaskSnapshot,
  TaskStatusInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import { normalizeInboxId } from '../../shared/inbox-domain';
import {
  formatLocalTaskDate,
  normalizeTaskCivilDate,
  normalizeTaskId,
  normalizeTaskPlanning,
  normalizeTaskStatus,
  normalizeTaskTitle,
} from '../../shared/task-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { InboxRepository, type StoredInboxEntry } from '../inbox/inbox-repository';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  TaskError,
  TaskNotFoundError,
  TaskOperationError,
  TaskValidationError,
} from './task-errors';
import { TaskRepository, type StoredTask } from './task-repository';

export type TaskOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface TaskServiceOptions {
  readonly execute: TaskOperationExecutor;
  readonly now?: () => Date;
  readonly todayFactory?: () => string;
  readonly idFactory?: () => string;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

export class TaskService {
  readonly #execute: TaskOperationExecutor;
  readonly #now: () => Date;
  readonly #todayFactory: () => string;
  readonly #idFactory: () => string;
  readonly #onFatalTransaction: (error: DatabaseIntegrityError) => void;

  constructor({
    execute,
    now = () => new Date(),
    todayFactory,
    idFactory = randomUUID,
    onFatalTransaction = () => undefined,
  }: TaskServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#todayFactory = todayFactory ?? (() => formatLocalTaskDate(now()));
    this.#idFactory = idFactory;
    this.#onFatalTransaction = onFatalTransaction;
  }

  validateSnapshot(database: SqliteAdapter): void {
    new TaskRepository(database).validateIntegrity();
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<TaskSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    return this.#execute((database) => {
      this.#requireActiveWorkspace(database, workspaceId);
      return new TaskRepository(database).readSnapshot(workspaceId, this.#todayDate());
    });
  }

  create(input: TaskCreateInput): Promise<TaskSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const title = this.#title(input?.title);
    const planning = this.#planning(input?.planning);
    const taskId = this.#newTaskId();
    return this.#execute((database) =>
      this.#transaction(database, 'create a task', (tasks) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
        const todayDate = this.#todayDate();
        tasks.insert({
          id: taskId,
          workspaceId,
          title,
          plannedFor: this.#plannedFor(planning, todayDate),
          sourceInboxEntryId: null,
          timestamp,
        });
        return tasks.readSnapshot(workspaceId, todayDate);
      }),
    );
  }

  rename(input: TaskRenameInput): Promise<TaskSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const taskId = this.#inputTaskId(input?.taskId);
    const title = this.#title(input?.title);
    return this.#execute((database) =>
      this.#transaction(database, 'rename a task', (tasks) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const task = this.#requireTask(tasks, workspaceId, taskId);
        if (task.title !== title) {
          tasks.rename(
            workspaceId,
            taskId,
            title,
            this.#timestampAtLeast(task.createdAt, task.updatedAt),
          );
        }
        return tasks.readSnapshot(workspaceId, this.#todayDate());
      }),
    );
  }

  updateStatus(input: TaskStatusInput): Promise<TaskSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const taskId = this.#inputTaskId(input?.taskId);
    const status = this.#status(input?.status);
    return this.#execute((database) =>
      this.#transaction(database, 'update a task status', (tasks) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const task = this.#requireTask(tasks, workspaceId, taskId);
        if (task.status !== status) {
          tasks.updateStatus(
            workspaceId,
            taskId,
            status,
            this.#timestampAtLeast(
              task.createdAt,
              task.updatedAt,
              ...(task.completedAt ? [task.completedAt] : []),
            ),
          );
        }
        return tasks.readSnapshot(workspaceId, this.#todayDate());
      }),
    );
  }

  updatePlanning(input: TaskPlanningInput): Promise<TaskSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const taskId = this.#inputTaskId(input?.taskId);
    const planning = this.#planning(input?.planning);
    return this.#execute((database) =>
      this.#transaction(database, 'update task planning', (tasks) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const task = this.#requireTask(tasks, workspaceId, taskId);
        const todayDate = this.#todayDate();
        const plannedFor = this.#plannedFor(planning, todayDate);
        if (task.plannedFor !== plannedFor) {
          tasks.updatePlanning(
            workspaceId,
            taskId,
            plannedFor,
            this.#timestampAtLeast(
              task.createdAt,
              task.updatedAt,
              ...(task.completedAt ? [task.completedAt] : []),
            ),
          );
        }
        return tasks.readSnapshot(workspaceId, todayDate);
      }),
    );
  }

  convertInbox(input: TaskConvertInboxInput): Promise<TaskConversionResult> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const entryId = this.#inboxId(input?.entryId);
    const planning = this.#planning(input?.planning);
    const taskId = this.#newTaskId();
    return this.#execute((database) =>
      this.#transaction(database, 'convert an inbox entry', (tasks) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const inbox = new InboxRepository(database);
        const source = this.#requireActiveInbox(inbox, workspaceId, entryId);
        const timestamp = this.#timestampAtLeast(
          workspace.createdAt,
          workspace.updatedAt,
          source.createdAt,
          source.updatedAt,
        );
        const todayDate = this.#todayDate();
        inbox.archive(workspaceId, entryId, timestamp);
        tasks.insert({
          id: taskId,
          workspaceId,
          title: source.content,
          plannedFor: this.#plannedFor(planning, todayDate),
          sourceInboxEntryId: source.id,
          timestamp,
        });
        return {
          taskSnapshot: tasks.readSnapshot(workspaceId, todayDate),
          inboxSnapshot: inbox.readSnapshot(workspaceId),
        };
      }),
    );
  }

  #transaction<T>(
    database: SqliteAdapter,
    operation: string,
    callback: (repository: TaskRepository) => T,
  ): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError('A task operation encountered an active transaction.');
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(new TaskRepository(database));
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The task operation escaped its transaction.');
      }
      commitStarted = true;
      database.exec('COMMIT');
      return result;
    } catch (error) {
      const transactionActiveAtFailure = database.isTransaction;
      let rollbackError: unknown;
      try {
        if (transactionStarted && transactionActiveAtFailure) database.exec('ROLLBACK');
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
            : new AggregateError([error, rollbackError], 'The task operation rollback failed.');
        const fatalError = new DatabaseIntegrityError(
          'The task transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof TaskError || error instanceof DatabaseIntegrityError) throw error;
      throw new TaskOperationError(`The task service could not ${operation}.`, { cause: error });
    }
  }

  #requireActiveWorkspace(database: SqliteAdapter, workspaceId: string) {
    const workspace = new WorkspaceRepository(database).findActive(workspaceId);
    if (!workspace) throw new TaskNotFoundError('The task workspace is unavailable.');
    return workspace;
  }

  #requireTask(repository: TaskRepository, workspaceId: string, taskId: string): StoredTask {
    const task = repository.find(workspaceId, taskId);
    if (!task) throw new TaskNotFoundError();
    return task;
  }

  #requireActiveInbox(
    repository: InboxRepository,
    workspaceId: string,
    entryId: string,
  ): StoredInboxEntry {
    const source = repository.findActive(workspaceId, entryId);
    if (!source) throw new TaskNotFoundError('The inbox source is unavailable.');
    return source;
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new TaskValidationError('Task workspace id is invalid.', { cause: error });
    }
  }

  #newTaskId(): string {
    try {
      return normalizeTaskId(this.#idFactory());
    } catch (error) {
      throw new TaskValidationError('Generated task id is invalid.', { cause: error });
    }
  }

  #inputTaskId(value: unknown): string {
    try {
      return normalizeTaskId(value);
    } catch (error) {
      throw new TaskValidationError('Task id is invalid.', { cause: error });
    }
  }

  #inboxId(value: unknown): string {
    try {
      return normalizeInboxId(value);
    } catch (error) {
      throw new TaskValidationError('Task inbox source id is invalid.', { cause: error });
    }
  }

  #title(value: unknown): string {
    try {
      return normalizeTaskTitle(value);
    } catch (error) {
      throw new TaskValidationError('Task title is invalid.', { cause: error });
    }
  }

  #status(value: unknown) {
    try {
      return normalizeTaskStatus(value);
    } catch (error) {
      throw new TaskValidationError('Task status is invalid.', { cause: error });
    }
  }

  #planning(value: unknown): TaskPlanning {
    try {
      return normalizeTaskPlanning(value);
    } catch (error) {
      throw new TaskValidationError('Task planning value is invalid.', { cause: error });
    }
  }

  #todayDate(): string {
    try {
      return normalizeTaskCivilDate(this.#todayFactory());
    } catch (error) {
      throw new TaskValidationError('Task current date is invalid.', { cause: error });
    }
  }

  #plannedFor(planning: TaskPlanning, todayDate: string): string | null {
    return planning === 'today' ? todayDate : null;
  }

  #validNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime()))
      throw new TaskValidationError('Task timestamp is invalid.');
    return value;
  }

  #timestampAtLeast(...lowerBounds: readonly string[]): string {
    let latest = this.#validNow().toISOString();
    for (const lowerBound of lowerBounds) {
      const timestamp = new Date(lowerBound);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== lowerBound) {
        throw new TaskValidationError('Task timestamp boundary is invalid.');
      }
      if (lowerBound > latest) latest = lowerBound;
    }
    return latest;
  }
}
