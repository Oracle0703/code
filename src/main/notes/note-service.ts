import { randomUUID } from 'node:crypto';
import type {
  NoteArchiveInput,
  NoteConversionResult,
  NoteConvertInboxInput,
  NoteCreateInput,
  NoteSnapshot,
  NoteUpdateInput,
  WorkspaceTargetInput,
} from '../../shared/contracts';
import { normalizeInboxId } from '../../shared/inbox-domain';
import {
  deriveNoteTitle,
  normalizeNoteBody,
  normalizeNoteId,
  normalizeNoteRevision,
  normalizeNoteTitle,
} from '../../shared/note-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { InboxRepository, type StoredInboxEntry } from '../inbox/inbox-repository';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  NoteConflictError,
  NoteError,
  NoteNotFoundError,
  NoteOperationError,
  NoteValidationError,
} from './note-errors';
import { NoteRepository, type StoredNote } from './note-repository';

export type NoteOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface NoteServiceOptions {
  readonly execute: NoteOperationExecutor;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly onFatalTransaction?: (error: DatabaseIntegrityError) => void;
}

export class NoteService {
  readonly #execute: NoteOperationExecutor;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #onFatalTransaction: (error: DatabaseIntegrityError) => void;

  constructor({
    execute,
    now = () => new Date(),
    idFactory = randomUUID,
    onFatalTransaction = () => undefined,
  }: NoteServiceOptions) {
    this.#execute = execute;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#onFatalTransaction = onFatalTransaction;
  }

  validateSnapshot(database: SqliteAdapter): void {
    new NoteRepository(database).validateIntegrity();
  }

  getSnapshot(input: WorkspaceTargetInput): Promise<NoteSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    return this.#execute((database) => {
      this.#requireActiveWorkspace(database, workspaceId);
      return new NoteRepository(database).readSnapshot(workspaceId);
    });
  }

  create(input: NoteCreateInput): Promise<NoteSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const title = this.#title(input?.title);
    const body = this.#body(input?.body);
    const noteId = this.#newNoteId();
    return this.#execute((database) =>
      this.#transaction(database, 'create a note', (notes) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const timestamp = this.#timestampAtLeast(workspace.createdAt, workspace.updatedAt);
        notes.insert({
          id: noteId,
          workspaceId,
          title,
          body,
          sourceInboxEntryId: null,
          timestamp,
        });
        return notes.readSnapshot(workspaceId);
      }),
    );
  }

  update(input: NoteUpdateInput): Promise<NoteSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const noteId = this.#inputNoteId(input?.noteId);
    const title = this.#title(input?.title);
    const body = this.#body(input?.body);
    const expectedRevision = this.#revision(input?.expectedRevision);
    return this.#execute((database) =>
      this.#transaction(database, 'update a note', (notes) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const note = this.#requireActiveNote(notes, workspaceId, noteId);
        this.#requireRevision(note, expectedRevision);
        if (note.title !== title || note.body !== body) {
          notes.update(
            workspaceId,
            noteId,
            expectedRevision,
            title,
            body,
            this.#timestampAtLeast(note.createdAt, note.updatedAt),
          );
        }
        return notes.readSnapshot(workspaceId);
      }),
    );
  }

  archive(input: NoteArchiveInput): Promise<NoteSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const noteId = this.#inputNoteId(input?.noteId);
    const expectedRevision = this.#revision(input?.expectedRevision);
    return this.#execute((database) =>
      this.#transaction(database, 'archive a note', (notes) => {
        this.#requireActiveWorkspace(database, workspaceId);
        const note = this.#requireActiveNote(notes, workspaceId, noteId);
        this.#requireRevision(note, expectedRevision);
        notes.archive(
          workspaceId,
          noteId,
          expectedRevision,
          this.#timestampAtLeast(note.createdAt, note.updatedAt),
        );
        return notes.readSnapshot(workspaceId);
      }),
    );
  }

  convertInbox(input: NoteConvertInboxInput): Promise<NoteConversionResult> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const entryId = this.#inboxId(input?.entryId);
    const noteId = this.#newNoteId();
    return this.#execute((database) =>
      this.#transaction(database, 'convert an inbox entry', (notes) => {
        const workspace = this.#requireActiveWorkspace(database, workspaceId);
        const inbox = new InboxRepository(database);
        const source = this.#requireActiveInbox(inbox, workspaceId, entryId);
        const timestamp = this.#timestampAtLeast(
          workspace.createdAt,
          workspace.updatedAt,
          source.createdAt,
          source.updatedAt,
        );
        inbox.archive(workspaceId, entryId, timestamp);
        notes.insert({
          id: noteId,
          workspaceId,
          title: deriveNoteTitle(source.content),
          body: source.content,
          sourceInboxEntryId: source.id,
          timestamp,
        });
        return {
          noteSnapshot: notes.readSnapshot(workspaceId),
          inboxSnapshot: inbox.readSnapshot(workspaceId),
        };
      }),
    );
  }

  #transaction<T>(
    database: SqliteAdapter,
    operation: string,
    callback: (repository: NoteRepository) => T,
  ): T {
    let transactionStarted = false;
    let transactionEscaped = false;
    let commitStarted = false;
    try {
      if (database.isTransaction) {
        throw new DatabaseIntegrityError('A note operation encountered an active transaction.');
      }
      database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(new NoteRepository(database));
      if (!database.isTransaction) {
        transactionEscaped = true;
        throw new DatabaseIntegrityError('The note operation escaped its transaction.');
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
            : new AggregateError([error, rollbackError], 'The note operation rollback failed.');
        const fatalError = new DatabaseIntegrityError(
          'The note transaction could not be returned to a safe state.',
          { cause },
        );
        this.#onFatalTransaction(fatalError);
        throw fatalError;
      }
      if (error instanceof NoteError || error instanceof DatabaseIntegrityError) throw error;
      throw new NoteOperationError(`The note service could not ${operation}.`, { cause: error });
    }
  }

  #requireActiveWorkspace(database: SqliteAdapter, workspaceId: string) {
    const workspace = new WorkspaceRepository(database).findActive(workspaceId);
    if (!workspace) throw new NoteNotFoundError('The note workspace is unavailable.');
    return workspace;
  }

  #requireActiveNote(repository: NoteRepository, workspaceId: string, noteId: string): StoredNote {
    const note = repository.findActive(workspaceId, noteId);
    if (!note) throw new NoteNotFoundError();
    return note;
  }

  #requireActiveInbox(
    repository: InboxRepository,
    workspaceId: string,
    entryId: string,
  ): StoredInboxEntry {
    const source = repository.findActive(workspaceId, entryId);
    if (!source) throw new NoteNotFoundError('The inbox source is unavailable.');
    return source;
  }

  #requireRevision(note: StoredNote, expectedRevision: number): void {
    if (note.revision !== expectedRevision) throw new NoteConflictError();
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new NoteValidationError('Note workspace id is invalid.', { cause: error });
    }
  }

  #newNoteId(): string {
    try {
      return normalizeNoteId(this.#idFactory());
    } catch (error) {
      throw new NoteValidationError('Generated note id is invalid.', { cause: error });
    }
  }

  #inputNoteId(value: unknown): string {
    try {
      return normalizeNoteId(value);
    } catch (error) {
      throw new NoteValidationError('Note id is invalid.', { cause: error });
    }
  }

  #inboxId(value: unknown): string {
    try {
      return normalizeInboxId(value);
    } catch (error) {
      throw new NoteValidationError('Note inbox source id is invalid.', { cause: error });
    }
  }

  #title(value: unknown): string {
    try {
      return normalizeNoteTitle(value);
    } catch (error) {
      throw new NoteValidationError('Note title is invalid.', { cause: error });
    }
  }

  #body(value: unknown): string {
    try {
      return normalizeNoteBody(value);
    } catch (error) {
      throw new NoteValidationError('Note body is invalid.', { cause: error });
    }
  }

  #revision(value: unknown): number {
    try {
      return normalizeNoteRevision(value);
    } catch (error) {
      throw new NoteValidationError('Note revision is invalid.', { cause: error });
    }
  }

  #validNow(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new NoteValidationError('Note timestamp is invalid.');
    }
    return value;
  }

  #timestampAtLeast(...lowerBounds: readonly string[]): string {
    let latest = this.#validNow().toISOString();
    for (const lowerBound of lowerBounds) {
      const timestamp = new Date(lowerBound);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== lowerBound) {
        throw new NoteValidationError('Note timestamp boundary is invalid.');
      }
      if (lowerBound > latest) latest = lowerBound;
    }
    return latest;
  }
}
