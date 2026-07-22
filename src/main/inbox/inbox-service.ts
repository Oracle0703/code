import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  InboxArchiveResult,
  InboxCategorizeInput,
  InboxCreateInput,
  InboxSnapshot,
  InboxTargetInput,
  InboxUndoInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import {
  INBOX_UNDO_WINDOW_MS,
  normalizeInboxCategory,
  normalizeInboxContent,
  normalizeInboxId,
  normalizeInboxUndoToken,
} from '../../shared/inbox-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  InboxError,
  InboxNotFoundError,
  InboxOperationError,
  InboxUndoUnavailableError,
  InboxValidationError,
} from './inbox-errors';
import { InboxRepository, type StoredInboxEntry } from './inbox-repository';

export type InboxOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface InboxServiceOptions {
  readonly execute: InboxOperationExecutor;
  readonly now?: () => Date;
  readonly monotonicNowMs?: () => number;
  readonly idFactory?: () => string;
  readonly undoTokenFactory?: () => string;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

interface UndoRecord {
  readonly workspaceId: string;
  readonly entryId: string;
  readonly archivedAt: string;
  readonly expiresAtMonotonicMs: number;
}

export class InboxService {
  readonly #execute: InboxOperationExecutor;
  readonly #now: () => Date;
  readonly #monotonicNowMs: () => number;
  readonly #idFactory: () => string;
  readonly #undoTokenFactory: () => string;
  readonly #onFatalTransaction: (error: DatabaseIntegrityError) => void;
  readonly #undoRecords = new Map<string, UndoRecord>();

  constructor({
    execute,
    now = () => new Date(),
    monotonicNowMs = () => performance.now(),
    idFactory = randomUUID,
    undoTokenFactory = randomUUID,
    onFatalTransaction = () => undefined,
  }: InboxServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#monotonicNowMs = monotonicNowMs;
    this.#idFactory = idFactory;
    this.#undoTokenFactory = undoTokenFactory;
    this.#onFatalTransaction = onFatalTransaction;
  }

  clearUndoTokens(): void {
    this.#undoRecords.clear();
  }

  validateSnapshot(database: SqliteAdapter): void {
    new InboxRepository(database).validateIntegrity();
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<InboxSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    return this.#execute((database) => {
      this.#requireActiveWorkspace(database, workspaceId);
      return new InboxRepository(database).readSnapshot(workspaceId);
    });
  }

  create(input: InboxCreateInput): Promise<InboxSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const content = this.#content(input?.content);
    const category = this.#category(input?.category);
    const entryId = this.#entryId();
    return this.#execute((database) =>
      this.#transaction(database, 'create an entry', (repository) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
        repository.insert({ id: entryId, workspaceId, content, category, timestamp });
        return repository.readSnapshot(workspaceId);
      }),
    );
  }

  categorize(input: InboxCategorizeInput): Promise<InboxSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const entryId = this.#inputEntryId(input?.entryId);
    const category = this.#category(input?.category);
    return this.#execute((database) =>
      this.#transaction(database, 'categorize an entry', (repository) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const entry = this.#requireActiveEntry(repository, workspaceId, entryId);
        if (entry.category !== category) {
          repository.categorize(
            workspaceId,
            entryId,
            category,
            this.#timestampAtLeast(entry.createdAt, entry.updatedAt),
          );
        }
        return repository.readSnapshot(workspaceId);
      }),
    );
  }

  archive(input: InboxTargetInput): Promise<InboxArchiveResult> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const entryId = this.#inputEntryId(input?.entryId);
    return this.#execute((database) => {
      const currentTime = this.#validNow();
      const monotonicNowMs = this.#validMonotonicNowMs();
      this.#purgeExpired(monotonicNowMs);
      const undoToken = this.#newUndoToken();
      const expiresAtMonotonicMs = monotonicNowMs + INBOX_UNDO_WINDOW_MS;
      const expiresAtWallMs = currentTime.getTime() + INBOX_UNDO_WINDOW_MS;
      if (!Number.isFinite(expiresAtMonotonicMs) || !Number.isFinite(expiresAtWallMs)) {
        throw new InboxValidationError('Inbox undo expiration is invalid.');
      }
      const undoExpiresAtDate = new Date(expiresAtWallMs);
      if (!Number.isFinite(undoExpiresAtDate.getTime())) {
        throw new InboxValidationError('Inbox undo expiration is invalid.');
      }
      const undoExpiresAt = undoExpiresAtDate.toISOString();
      const result = this.#transaction(database, 'archive an entry', (repository) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const entry = this.#requireActiveEntry(repository, workspaceId, entryId);
        const archivedAt = this.#timestampAtLeast(
          entry.createdAt,
          entry.updatedAt,
          currentTime.toISOString(),
        );
        repository.archive(workspaceId, entryId, archivedAt);
        return { archivedAt, snapshot: repository.readSnapshot(workspaceId) };
      });
      this.#discardEntryTokens(workspaceId, entryId);
      this.#undoRecords.set(undoToken, {
        workspaceId,
        entryId,
        archivedAt: result.archivedAt,
        expiresAtMonotonicMs,
      });
      return {
        snapshot: result.snapshot,
        undoToken,
        undoExpiresAt,
      };
    });
  }

  undoArchive(input: InboxUndoInput): Promise<InboxSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const undoToken = this.#undoToken(input?.undoToken);
    return this.#execute((database) => {
      const currentTime = this.#validNow();
      this.#purgeExpired(this.#validMonotonicNowMs());
      const record = this.#undoRecords.get(undoToken);
      if (!record || record.workspaceId !== workspaceId) {
        throw new InboxUndoUnavailableError();
      }

      try {
        const snapshot = this.#transaction(database, 'undo an archive', (repository) => {
          const workspace = this.#requireActiveWorkspace(database, workspaceId);
          const restored = repository.restore(
            workspaceId,
            record.entryId,
            record.archivedAt,
            this.#timestampAtLeast(
              record.archivedAt,
              workspace.createdAt,
              workspace.updatedAt,
              currentTime.toISOString(),
            ),
          );
          if (!restored) throw new InboxUndoUnavailableError();
          return repository.readSnapshot(workspaceId);
        });
        this.#undoRecords.delete(undoToken);
        return snapshot;
      } catch (error) {
        if (error instanceof InboxUndoUnavailableError) this.#undoRecords.delete(undoToken);
        throw error;
      }
    });
  }

  #transaction<T>(
    database: SqliteAdapter,
    operation: string,
    callback: (repository: InboxRepository) => T,
  ): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError('An inbox operation encountered an active transaction.');
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(new InboxRepository(database));
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The inbox operation escaped its transaction.');
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
            : new AggregateError([error, rollbackError], 'The inbox operation rollback failed.');
        const fatalError = new DatabaseIntegrityError(
          'The inbox transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof InboxError || error instanceof DatabaseIntegrityError) throw error;
      throw new InboxOperationError(`The inbox could not ${operation}.`, { cause: error });
    }
  }

  #requireActiveWorkspace(database: SqliteAdapter, workspaceId: string) {
    const workspace = new WorkspaceRepository(database).findActive(workspaceId);
    if (!workspace) throw new InboxNotFoundError('The inbox workspace is unavailable.');
    return workspace;
  }

  #requireActiveEntry(
    repository: InboxRepository,
    workspaceId: string,
    entryId: string,
  ): StoredInboxEntry {
    const entry = repository.findActive(workspaceId, entryId);
    if (!entry) throw new InboxNotFoundError();
    return entry;
  }

  #entryId(): string {
    try {
      return normalizeInboxId(this.#idFactory());
    } catch (error) {
      throw new InboxValidationError('Generated inbox entry id is invalid.', { cause: error });
    }
  }

  #inputEntryId(value: unknown): string {
    try {
      return normalizeInboxId(value);
    } catch (error) {
      throw new InboxValidationError('Inbox entry id is invalid.', { cause: error });
    }
  }

  #newUndoToken(): string {
    let token: string;
    try {
      token = normalizeInboxUndoToken(this.#undoTokenFactory());
    } catch (error) {
      throw new InboxValidationError('Generated inbox undo token is invalid.', { cause: error });
    }
    if (this.#undoRecords.has(token)) {
      throw new InboxOperationError('A unique inbox undo token could not be generated.');
    }
    return token;
  }

  #undoToken(value: unknown): string {
    try {
      return normalizeInboxUndoToken(value);
    } catch (error) {
      throw new InboxValidationError('Inbox undo token is invalid.', { cause: error });
    }
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new InboxValidationError('Inbox workspace id is invalid.', { cause: error });
    }
  }

  #content(value: unknown): string {
    try {
      return normalizeInboxContent(value);
    } catch (error) {
      throw new InboxValidationError('Inbox content is invalid.', { cause: error });
    }
  }

  #category(value: unknown) {
    try {
      return normalizeInboxCategory(value);
    } catch (error) {
      throw new InboxValidationError('Inbox category is invalid.', { cause: error });
    }
  }

  #validNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new InboxValidationError('Inbox timestamp is invalid.');
    }
    return value;
  }

  #validMonotonicNowMs(): number {
    const value = this.#monotonicNowMs();
    if (!Number.isFinite(value) || value < 0) {
      throw new InboxValidationError('Inbox monotonic timestamp is invalid.');
    }
    return value;
  }

  #timestampAtLeast(...lowerBounds: readonly string[]): string {
    let latest = this.#validNow().toISOString();
    for (const lowerBound of lowerBounds) {
      const timestamp = new Date(lowerBound);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== lowerBound) {
        throw new InboxValidationError('Inbox timestamp boundary is invalid.');
      }
      if (lowerBound > latest) latest = lowerBound;
    }
    return latest;
  }

  #purgeExpired(nowMs: number): void {
    for (const [token, record] of this.#undoRecords) {
      if (record.expiresAtMonotonicMs <= nowMs) this.#undoRecords.delete(token);
    }
  }

  #discardEntryTokens(workspaceId: string, entryId: string): void {
    for (const [token, record] of this.#undoRecords) {
      if (record.workspaceId === workspaceId && record.entryId === entryId) {
        this.#undoRecords.delete(token);
      }
    }
  }
}
