import { randomUUID } from 'node:crypto';
import type {
  ScheduleCreateInput,
  ScheduleKind,
  ScheduleSnapshot,
  ScheduleTargetInput,
  ScheduleUpdateInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  formatLocalScheduleDate,
  normalizeScheduleCivilDate,
  normalizeScheduleId,
  normalizeScheduleKind,
  normalizeScheduleRange,
  normalizeScheduleRevision,
  normalizeScheduleTitle,
} from '../../shared/schedule-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  ScheduleConflictError,
  ScheduleError,
  ScheduleNotFoundError,
  ScheduleOperationError,
  ScheduleValidationError,
} from './schedule-errors';
import { ScheduleRepository, type StoredScheduleItem } from './schedule-repository';

export type ScheduleOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface ScheduleServiceOptions {
  readonly execute: ScheduleOperationExecutor;
  readonly now?: () => Date;
  readonly todayFactory?: () => string;
  readonly idFactory?: () => string;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

export class ScheduleService {
  readonly #execute: ScheduleOperationExecutor;
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
  }: ScheduleServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#todayFactory = todayFactory ?? (() => formatLocalScheduleDate(now()));
    this.#idFactory = idFactory;
    this.#onFatalTransaction = onFatalTransaction;
  }

  validateSnapshot(database: SqliteAdapter): void {
    new ScheduleRepository(database).validateIntegrity();
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<ScheduleSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    return this.#execute((database) => {
      this.#requireActiveWorkspace(database, workspaceId);
      const todayDate = this.#todayDate();
      return new ScheduleRepository(database).readSnapshot(workspaceId, todayDate);
    });
  }

  create(input: ScheduleCreateInput): Promise<ScheduleSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const expectedDate = this.#expectedDate(input?.expectedDate);
    const title = this.#title(input?.title);
    const kind = this.#kind(input?.kind);
    const range = this.#range(input?.startMinute, input?.endMinute);
    const scheduleId = this.#newScheduleId();
    return this.#execute((database) =>
      this.#transaction(database, 'create a schedule item', (schedule) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const todayDate = this.#requireExpectedDate(expectedDate);
        const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
        schedule.insert({
          id: scheduleId,
          workspaceId,
          title,
          kind,
          scheduledFor: todayDate,
          ...range,
          timestamp,
        });
        return schedule.readSnapshot(workspaceId, todayDate);
      }),
    );
  }

  update(input: ScheduleUpdateInput): Promise<ScheduleSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const scheduleId = this.#inputScheduleId(input?.scheduleId);
    const expectedDate = this.#expectedDate(input?.expectedDate);
    const expectedRevision = this.#revision(input?.expectedRevision);
    const title = this.#title(input?.title);
    const kind = this.#kind(input?.kind);
    const range = this.#range(input?.startMinute, input?.endMinute);
    return this.#execute((database) =>
      this.#transaction(database, 'update a schedule item', (schedule) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const todayDate = this.#requireExpectedDate(expectedDate);
        const item = this.#requireActiveItem(schedule, workspaceId, scheduleId, todayDate);
        this.#requireRevision(item, expectedRevision);
        if (
          item.title !== title ||
          item.kind !== kind ||
          item.startMinute !== range.startMinute ||
          item.endMinute !== range.endMinute
        ) {
          schedule.update(
            workspaceId,
            scheduleId,
            todayDate,
            expectedRevision,
            title,
            kind,
            range.startMinute,
            range.endMinute,
            this.#timestampAtLeast(item.createdAt, item.updatedAt),
          );
        }
        return schedule.readSnapshot(workspaceId, todayDate);
      }),
    );
  }

  archive(input: ScheduleTargetInput): Promise<ScheduleSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const scheduleId = this.#inputScheduleId(input?.scheduleId);
    const expectedDate = this.#expectedDate(input?.expectedDate);
    const expectedRevision = this.#revision(input?.expectedRevision);
    return this.#execute((database) =>
      this.#transaction(database, 'archive a schedule item', (schedule) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const todayDate = this.#requireExpectedDate(expectedDate);
        const item = this.#requireActiveItem(schedule, workspaceId, scheduleId, todayDate);
        this.#requireRevision(item, expectedRevision);
        schedule.archive(
          workspaceId,
          scheduleId,
          todayDate,
          expectedRevision,
          this.#timestampAtLeast(item.createdAt, item.updatedAt),
        );
        return schedule.readSnapshot(workspaceId, todayDate);
      }),
    );
  }

  #transaction<T>(
    database: SqliteAdapter,
    operation: string,
    callback: (repository: ScheduleRepository) => T,
  ): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError('A schedule operation encountered an active transaction.');
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(new ScheduleRepository(database));
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The schedule operation escaped its transaction.');
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
            : new AggregateError([error, rollbackError], 'The schedule operation rollback failed.');
        const fatalError = new DatabaseIntegrityError(
          'The schedule transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof ScheduleError || error instanceof DatabaseIntegrityError) throw error;
      throw new ScheduleOperationError(`The schedule service could not ${operation}.`, {
        cause: error,
      });
    }
  }

  #requireActiveWorkspace(database: SqliteAdapter, workspaceId: string) {
    const workspace = new WorkspaceRepository(database).findActive(workspaceId);
    if (!workspace) throw new ScheduleNotFoundError('The schedule workspace is unavailable.');
    return workspace;
  }

  #requireActiveItem(
    repository: ScheduleRepository,
    workspaceId: string,
    scheduleId: string,
    todayDate: string,
  ): StoredScheduleItem {
    const item = repository.findActive(workspaceId, scheduleId, todayDate);
    if (!item) throw new ScheduleNotFoundError();
    return item;
  }

  #requireRevision(item: StoredScheduleItem, expectedRevision: number): void {
    if (item.revision !== expectedRevision) throw new ScheduleConflictError();
  }

  #requireExpectedDate(expectedDate: string): string {
    const todayDate = this.#todayDate();
    if (expectedDate !== todayDate) {
      throw new ScheduleConflictError('The current schedule date changed. Reload today first.');
    }
    return todayDate;
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new ScheduleValidationError('Schedule workspace id is invalid.', { cause: error });
    }
  }

  #newScheduleId(): string {
    try {
      return normalizeScheduleId(this.#idFactory());
    } catch (error) {
      throw new ScheduleValidationError('Generated schedule item id is invalid.', { cause: error });
    }
  }

  #inputScheduleId(value: unknown): string {
    try {
      return normalizeScheduleId(value);
    } catch (error) {
      throw new ScheduleValidationError('Schedule item id is invalid.', { cause: error });
    }
  }

  #expectedDate(value: unknown): string {
    try {
      return normalizeScheduleCivilDate(value);
    } catch (error) {
      throw new ScheduleValidationError('Schedule expected date is invalid.', { cause: error });
    }
  }

  #todayDate(): string {
    try {
      return normalizeScheduleCivilDate(this.#todayFactory());
    } catch (error) {
      throw new ScheduleValidationError('Schedule current date is invalid.', { cause: error });
    }
  }

  #title(value: unknown): string {
    try {
      return normalizeScheduleTitle(value);
    } catch (error) {
      throw new ScheduleValidationError('Schedule title is invalid.', { cause: error });
    }
  }

  #kind(value: unknown): ScheduleKind {
    try {
      return normalizeScheduleKind(value);
    } catch (error) {
      throw new ScheduleValidationError('Schedule kind is invalid.', { cause: error });
    }
  }

  #range(startMinute: unknown, endMinute: unknown) {
    try {
      return normalizeScheduleRange(startMinute, endMinute);
    } catch (error) {
      throw new ScheduleValidationError('Schedule time range is invalid.', { cause: error });
    }
  }

  #revision(value: unknown): number {
    try {
      return normalizeScheduleRevision(value);
    } catch (error) {
      throw new ScheduleValidationError('Schedule revision is invalid.', { cause: error });
    }
  }

  #validNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new ScheduleValidationError('Schedule timestamp is invalid.');
    }
    return value;
  }

  #timestampAtLeast(...lowerBounds: readonly string[]): string {
    let latest = this.#validNow().toISOString();
    for (const lowerBound of lowerBounds) {
      const timestamp = new Date(lowerBound);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== lowerBound) {
        throw new ScheduleValidationError('Schedule timestamp boundary is invalid.');
      }
      if (lowerBound > latest) latest = lowerBound;
    }
    return latest;
  }
}
