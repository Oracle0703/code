import { randomUUID } from 'node:crypto';
import type {
  AutomationAction,
  AutomationCreateInput,
  AutomationRunErrorCode,
  AutomationSetEnabledInput,
  AutomationSnapshot,
  AutomationTargetInput,
  AutomationUpdateInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  AUTOMATION_ACTIVE_GLOBAL_LIMIT,
  AUTOMATION_ENABLED_WORKSPACE_LIMIT,
  normalizeAutomationAction,
  normalizeAutomationId,
  normalizeAutomationName,
  normalizeAutomationRevision,
  normalizeAutomationSchedule,
} from '../../shared/automation-domain';
import { normalizeNoteId } from '../../shared/note-domain';
import { formatLocalTaskDate, normalizeTaskId } from '../../shared/task-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { NoteRepository } from '../notes/note-repository';
import { TaskRepository } from '../tasks/task-repository';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  AutomationConflictError,
  AutomationError,
  AutomationLimitError,
  AutomationNotFoundError,
  AutomationOperationError,
  AutomationValidationError,
} from './automation-errors';
import {
  AutomationRepository,
  type StoredAutomation,
  toAutomationItem,
} from './automation-repository';
import {
  calculateAutomationSchedule,
  normalizeAutomationOccurrenceDate,
  normalizeDefinitionRevision,
} from './automation-schedule';

const INITIAL_RETRY_DELAY_MS = 5 * 60 * 1_000;
const MAXIMUM_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;

export type AutomationOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface AutomationServiceOptions {
  readonly execute: AutomationOperationExecutor;
  readonly now?: () => Date;
  readonly automationIdFactory?: () => string;
  readonly taskIdFactory?: () => string;
  readonly noteIdFactory?: () => string;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

export interface AutomationRunInput {
  readonly automationId: string;
  readonly expectedRevision: number;
  readonly occurrenceDate: string;
  readonly scheduledFor: string;
}

export type AutomationRunResult =
  | {
      readonly status: 'success';
      readonly workspaceId: string;
      readonly outputKind: 'task' | 'note';
    }
  | {
      readonly status: 'failed';
      readonly workspaceId: string;
      readonly outputKind: null;
      readonly errorCode: AutomationRunErrorCode;
    }
  | {
      readonly status: 'skipped';
      readonly workspaceId: string | null;
      readonly outputKind: null;
    };

export class AutomationService {
  readonly #execute: AutomationOperationExecutor;
  readonly #now: () => Date;
  readonly #automationIdFactory: () => string;
  readonly #taskIdFactory: () => string;
  readonly #noteIdFactory: () => string;
  readonly #onFatalTransaction: (error: DatabaseIntegrityError) => void;

  constructor({
    execute,
    now = () => new Date(),
    automationIdFactory = randomUUID,
    taskIdFactory = randomUUID,
    noteIdFactory = randomUUID,
    onFatalTransaction = () => undefined,
  }: AutomationServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#automationIdFactory = automationIdFactory;
    this.#taskIdFactory = taskIdFactory;
    this.#noteIdFactory = noteIdFactory;
    this.#onFatalTransaction = onFatalTransaction;
  }

  validateSnapshot(database: SqliteAdapter): void {
    new AutomationRepository(database).validateSnapshot();
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<AutomationSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    return this.#execute((database) => {
      this.#requireActiveWorkspace(database, workspaceId);
      return this.#readSnapshot(new AutomationRepository(database), workspaceId, this.#validNow());
    });
  }

  create(input: AutomationCreateInput): Promise<AutomationSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const name = this.#name(input?.name);
    const schedule = this.#schedule(input?.schedule);
    const action = this.#action(input?.action);
    const automationId = this.#newAutomationId();
    return this.#execute((database) =>
      this.#transaction(database, 'create an automation', () => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const repository = new AutomationRepository(database);
        if (repository.countActiveGlobal() >= AUTOMATION_ACTIVE_GLOBAL_LIMIT) {
          throw new AutomationLimitError(
            `Daily Workbench can keep at most ${AUTOMATION_ACTIVE_GLOBAL_LIMIT} active automations.`,
          );
        }
        const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
        repository.insert({
          id: automationId,
          workspaceId,
          name,
          schedule,
          action,
          timestamp,
        });
        return this.#readSnapshot(repository, workspaceId, this.#validNow());
      }),
    );
  }

  update(input: AutomationUpdateInput): Promise<AutomationSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const automationId = this.#inputAutomationId(input?.automationId);
    const expectedRevision = this.#revision(input?.expectedRevision);
    const name = this.#name(input?.name);
    const schedule = this.#schedule(input?.schedule);
    const action = this.#action(input?.action);
    return this.#execute((database) =>
      this.#transaction(database, 'update an automation', () => {
        this.#requireActiveWorkspace(database, workspaceId);
        const repository = new AutomationRepository(database);
        const current = this.#requireAutomation(repository, workspaceId, automationId);
        this.#requireRevision(current, expectedRevision);
        if (current.action.kind !== action.kind) {
          throw new AutomationConflictError(
            'An automation action kind cannot be changed after creation.',
          );
        }
        if (
          current.name !== name ||
          !sameSchedule(current.schedule, schedule) ||
          !sameAction(current.action, action)
        ) {
          const timestamp = this.#timestampAtLeast(current.createdAt, current.updatedAt);
          if (
            !repository.update(
              workspaceId,
              automationId,
              expectedRevision,
              name,
              schedule,
              action,
              timestamp,
            )
          ) {
            throw new AutomationConflictError();
          }
        }
        return this.#readSnapshot(repository, workspaceId, this.#validNow());
      }),
    );
  }

  setEnabled(input: AutomationSetEnabledInput): Promise<AutomationSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const automationId = this.#inputAutomationId(input?.automationId);
    const expectedRevision = this.#revision(input?.expectedRevision);
    if (typeof input?.enabled !== 'boolean') {
      return Promise.reject(new AutomationValidationError('Automation enabled state is invalid.'));
    }
    const enabled = input.enabled;
    return this.#execute((database) =>
      this.#transaction(
        database,
        enabled ? 'enable an automation' : 'disable an automation',
        () => {
          this.#requireActiveWorkspace(database, workspaceId);
          const repository = new AutomationRepository(database);
          const current = this.#requireAutomation(repository, workspaceId, automationId);
          this.#requireRevision(current, expectedRevision);
          if (current.enabled !== enabled) {
            if (
              enabled &&
              repository.countEnabled(workspaceId) >= AUTOMATION_ENABLED_WORKSPACE_LIMIT
            ) {
              throw new AutomationLimitError(
                `A workspace can enable at most ${AUTOMATION_ENABLED_WORKSPACE_LIMIT} automations.`,
              );
            }
            const timestamp = this.#timestampAtLeast(current.createdAt, current.updatedAt);
            if (
              !repository.setEnabled(
                workspaceId,
                automationId,
                expectedRevision,
                enabled,
                timestamp,
              )
            ) {
              throw new AutomationConflictError();
            }
          }
          return this.#readSnapshot(repository, workspaceId, this.#validNow());
        },
      ),
    );
  }

  archive(input: AutomationTargetInput): Promise<AutomationSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const automationId = this.#inputAutomationId(input?.automationId);
    const expectedRevision = this.#revision(input?.expectedRevision);
    return this.#execute((database) =>
      this.#transaction(database, 'archive an automation', () => {
        this.#requireActiveWorkspace(database, workspaceId);
        const repository = new AutomationRepository(database);
        const current = this.#requireAutomation(repository, workspaceId, automationId);
        this.#requireRevision(current, expectedRevision);
        const timestamp = this.#timestampAtLeast(current.createdAt, current.updatedAt);
        if (!repository.archive(workspaceId, automationId, expectedRevision, timestamp)) {
          throw new AutomationConflictError();
        }
        return this.#readSnapshot(repository, workspaceId, this.#validNow());
      }),
    );
  }

  readSchedulerEntries(): Promise<readonly StoredAutomation[]> {
    return this.#execute((database) => new AutomationRepository(database).readEnabled());
  }

  runOccurrence(input: AutomationRunInput): Promise<AutomationRunResult> {
    const automationId = this.#inputAutomationId(input?.automationId);
    const expectedRevision = normalizeDefinitionRevision(input?.expectedRevision);
    const occurrenceDate = normalizeAutomationOccurrenceDate(input?.occurrenceDate);
    const scheduledFor = this.#isoTimestamp(input?.scheduledFor, 'automation scheduled time');
    return this.#execute((database) => {
      const repository = new AutomationRepository(database);
      const initial = repository.findEnabled(automationId);
      if (!initial || initial.revision !== expectedRevision) {
        return {
          status: 'skipped',
          workspaceId: initial?.workspaceId ?? null,
          outputKind: null,
        };
      }
      const now = this.#validNow();
      const decision = this.#scheduleDecision(initial, now);
      if (
        !decision.due ||
        decision.occurrenceDate !== occurrenceDate ||
        decision.scheduledFor !== scheduledFor ||
        repository.hasOccurrence(automationId, occurrenceDate)
      ) {
        return { status: 'skipped', workspaceId: initial.workspaceId, outputKind: null };
      }

      const attemptedAt = this.#timestampAtLeast(
        initial.updatedAt,
        initial.runState.updatedAt,
        scheduledFor,
      );
      try {
        return this.#transaction(database, 'run an automation', () => {
          const currentRepository = new AutomationRepository(database);
          const current = currentRepository.findEnabled(automationId);
          if (
            !current ||
            current.revision !== expectedRevision ||
            currentRepository.hasOccurrence(automationId, occurrenceDate)
          ) {
            return {
              status: 'skipped',
              workspaceId: current?.workspaceId ?? initial.workspaceId,
              outputKind: null,
            } as const;
          }
          const currentDecision = this.#scheduleDecision(current, this.#validNow());
          if (
            !currentDecision.due ||
            currentDecision.occurrenceDate !== occurrenceDate ||
            currentDecision.scheduledFor !== scheduledFor
          ) {
            return {
              status: 'skipped',
              workspaceId: current.workspaceId,
              outputKind: null,
            } as const;
          }
          const workspace = this.#requireActiveWorkspace(database, current.workspaceId);
          const completedAt = this.#timestampAtLeast(
            attemptedAt,
            workspace.createdAt,
            workspace.updatedAt,
            current.updatedAt,
            current.runState.updatedAt,
            scheduledFor,
          );
          const output = this.#createOutput(database, current, completedAt);
          currentRepository.recordSuccess({
            automationId,
            occurrenceDate,
            scheduledFor,
            definitionRevision: expectedRevision,
            attemptedAt,
            completedAt,
            outputKind: output.kind,
            outputId: output.id,
          });
          return {
            status: 'success',
            workspaceId: current.workspaceId,
            outputKind: output.kind,
          } as const;
        });
      } catch (error) {
        if (error instanceof DatabaseIntegrityError) throw error;
        const current = repository.findEnabled(automationId);
        if (!current || current.revision !== expectedRevision) {
          return { status: 'skipped', workspaceId: initial.workspaceId, outputKind: null };
        }
        const completedAt = this.#timestampAtLeast(
          attemptedAt,
          current.updatedAt,
          current.runState.updatedAt,
        );
        const failureCount =
          current.runState.lastAttemptOccurrence === occurrenceDate &&
          current.runState.lastErrorCode !== null
            ? current.runState.consecutiveFailures + 1
            : 1;
        const exponent = Math.min(failureCount - 1, 16);
        const retryDelay = Math.min(MAXIMUM_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** exponent);
        const nextRetryAt = new Date(Date.parse(completedAt) + retryDelay).toISOString();
        this.#transaction(database, 'record an automation failure', () => {
          repository.recordFailure({
            automationId,
            occurrenceDate,
            attemptedAt,
            completedAt,
            errorCode: 'action-failed',
            nextRetryAt,
          });
        });
        return {
          status: 'failed',
          workspaceId: current.workspaceId,
          outputKind: null,
          errorCode: 'action-failed',
        };
      }
    });
  }

  #createOutput(
    database: SqliteAdapter,
    automation: StoredAutomation,
    timestamp: string,
  ): { readonly kind: 'task' | 'note'; readonly id: string } {
    if (automation.action.kind === 'create-today-task') {
      const id = this.#newTaskId();
      new TaskRepository(database).insert({
        id,
        workspaceId: automation.workspaceId,
        title: automation.action.title,
        plannedFor: formatLocalTaskDate(this.#validNow()),
        sourceInboxEntryId: null,
        timestamp,
      });
      return { kind: 'task', id };
    }
    const id = this.#newNoteId();
    new NoteRepository(database).insert({
      id,
      workspaceId: automation.workspaceId,
      title: automation.action.title,
      body: automation.action.body,
      sourceInboxEntryId: null,
      timestamp,
    });
    return { kind: 'note', id };
  }

  #readSnapshot(
    repository: AutomationRepository,
    workspaceId: string,
    now: Date,
  ): AutomationSnapshot {
    return {
      workspaceId,
      items: repository.readWorkspace(workspaceId).map((automation) => {
        const decision = this.#scheduleDecision(automation, now);
        return toAutomationItem(automation, decision.nextRunAt);
      }),
    };
  }

  #scheduleDecision(automation: StoredAutomation, now: Date) {
    return calculateAutomationSchedule(
      automation.schedule,
      {
        enabled: automation.enabled,
        effectiveAt: automation.effectiveAt,
        lastSuccessOccurrence: automation.runState.lastSuccessOccurrence,
        lastAttemptOccurrence: automation.runState.lastAttemptOccurrence,
        lastErrorCode: automation.runState.lastErrorCode,
        nextRetryAt: automation.runState.nextRetryAt,
      },
      now,
    );
  }

  #transaction<T>(database: SqliteAdapter, operation: string, callback: () => T): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError(
          'An automation operation encountered an active transaction.',
        );
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback();
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The automation operation escaped its transaction.');
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
            : new AggregateError(
                [error, rollbackError],
                'The automation operation rollback failed.',
              );
        const fatalError = new DatabaseIntegrityError(
          'The automation transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof AutomationError || error instanceof DatabaseIntegrityError) throw error;
      throw new AutomationOperationError(`The automation service could not ${operation}.`, {
        cause: error,
      });
    }
  }

  #requireActiveWorkspace(database: SqliteAdapter, workspaceId: string) {
    const workspace = new WorkspaceRepository(database).findActive(workspaceId);
    if (!workspace) {
      throw new AutomationNotFoundError('The automation workspace is unavailable.');
    }
    return workspace;
  }

  #requireAutomation(
    repository: AutomationRepository,
    workspaceId: string,
    automationId: string,
  ): StoredAutomation {
    const automation = repository.findActive(workspaceId, automationId);
    if (!automation) throw new AutomationNotFoundError();
    return automation;
  }

  #requireRevision(automation: StoredAutomation, expectedRevision: number): void {
    if (automation.revision !== expectedRevision) throw new AutomationConflictError();
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new AutomationValidationError('Automation workspace id is invalid.', { cause: error });
    }
  }

  #newAutomationId(): string {
    try {
      return normalizeAutomationId(this.#automationIdFactory());
    } catch (error) {
      throw new AutomationValidationError('Generated automation id is invalid.', {
        cause: error,
      });
    }
  }

  #inputAutomationId(value: unknown): string {
    try {
      return normalizeAutomationId(value);
    } catch (error) {
      throw new AutomationValidationError('Automation id is invalid.', { cause: error });
    }
  }

  #newTaskId(): string {
    try {
      return normalizeTaskId(this.#taskIdFactory());
    } catch (error) {
      throw new AutomationValidationError('Generated automation task id is invalid.', {
        cause: error,
      });
    }
  }

  #newNoteId(): string {
    try {
      return normalizeNoteId(this.#noteIdFactory());
    } catch (error) {
      throw new AutomationValidationError('Generated automation note id is invalid.', {
        cause: error,
      });
    }
  }

  #name(value: unknown): string {
    try {
      return normalizeAutomationName(value);
    } catch (error) {
      throw new AutomationValidationError('Automation name is invalid.', { cause: error });
    }
  }

  #schedule(value: unknown) {
    try {
      return normalizeAutomationSchedule(value);
    } catch (error) {
      throw new AutomationValidationError('Automation schedule is invalid.', { cause: error });
    }
  }

  #action(value: unknown): AutomationAction {
    try {
      return normalizeAutomationAction(value);
    } catch (error) {
      throw new AutomationValidationError('Automation action is invalid.', { cause: error });
    }
  }

  #revision(value: unknown): number {
    try {
      return normalizeAutomationRevision(value);
    } catch (error) {
      throw new AutomationValidationError('Automation revision is invalid.', { cause: error });
    }
  }

  #validNow(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new AutomationValidationError('Automation clock is invalid.');
    }
    return now;
  }

  #timestampAtLeast(...lowerBounds: readonly string[]): string {
    let latest = this.#validNow().toISOString();
    for (const lowerBound of lowerBounds) {
      const timestamp = this.#isoTimestamp(lowerBound, 'automation timestamp boundary');
      if (timestamp > latest) latest = timestamp;
    }
    return latest;
  }

  #isoTimestamp(value: unknown, name: string): string {
    if (typeof value !== 'string') {
      throw new AutomationValidationError(`${name} is invalid.`);
    }
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
      throw new AutomationValidationError(`${name} is invalid.`);
    }
    return value;
  }
}

function sameSchedule(
  left: StoredAutomation['schedule'],
  right: StoredAutomation['schedule'],
): boolean {
  return (
    left.cadence === right.cadence &&
    left.localTimeMinute === right.localTimeMinute &&
    left.weekday === right.weekday
  );
}

function sameAction(left: AutomationAction, right: AutomationAction): boolean {
  return (
    left.kind === right.kind &&
    left.title === right.title &&
    (left.kind === 'create-today-task' ||
      (right.kind === 'create-note' && left.body === right.body))
  );
}
