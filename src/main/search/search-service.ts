import type { SearchQueryInput, SearchSnapshot } from '../../shared/contracts';
import { normalizeSearchQuery, normalizeSearchScope } from '../../shared/search-domain';
import { formatLocalScheduleDate, normalizeScheduleCivilDate } from '../../shared/schedule-domain';
import { normalizeWorkspaceId } from '../../shared/workspace-domain';
import { DatabaseIntegrityError } from '../database/errors';
import type { SqliteAdapter } from '../database/sqlite-adapter';
import { WorkspaceRepository } from '../workspaces/workspace-repository';
import {
  SearchError,
  SearchNotFoundError,
  SearchOperationError,
  SearchValidationError,
} from './search-errors';
import { SearchRepository } from './search-repository';

export type SearchOperationExecutor = <T>(
  operation: (database: SqliteAdapter) => Promise<T> | T,
) => Promise<T>;

export interface SearchServiceOptions {
  readonly execute: SearchOperationExecutor;
  readonly todayFactory?: () => string;
}

export class SearchService {
  readonly #execute: SearchOperationExecutor;
  readonly #todayFactory: () => string;

  constructor({
    execute,
    todayFactory = () => formatLocalScheduleDate(new Date()),
  }: SearchServiceOptions) {
    this.#execute = execute;
    this.#todayFactory = todayFactory;
  }

  validateSnapshot(database: SqliteAdapter): void {
    new SearchRepository(database).validateSnapshot();
  }

  validateContentIntegrity(database: SqliteAdapter): void {
    new SearchRepository(database).validateContentIntegrity();
  }

  query(input: SearchQueryInput): Promise<SearchSnapshot> {
    const workspaceId = this.#workspaceId(input?.workspaceId);
    const query = this.#query(input?.query);
    const scope = this.#scope(input?.scope);
    const todayDate = this.#todayDate();

    return this.#execute((database) => {
      try {
        if (!new WorkspaceRepository(database).findActive(workspaceId)) {
          throw new SearchNotFoundError();
        }
        const result = new SearchRepository(database).search({
          workspaceId,
          query,
          scope,
          todayDate,
        });
        return {
          workspaceId,
          query,
          scope,
          ...result,
        };
      } catch (error) {
        if (error instanceof SearchError || error instanceof DatabaseIntegrityError) {
          throw error;
        }
        throw new SearchOperationError('The workspace search could not be completed.', {
          cause: error,
        });
      }
    });
  }

  #workspaceId(value: unknown): string {
    try {
      return normalizeWorkspaceId(value);
    } catch (error) {
      throw new SearchValidationError('Search workspace id is invalid.', { cause: error });
    }
  }

  #query(value: unknown): string {
    try {
      return normalizeSearchQuery(value);
    } catch (error) {
      throw new SearchValidationError('Search query is invalid.', { cause: error });
    }
  }

  #scope(value: unknown) {
    try {
      return normalizeSearchScope(value);
    } catch (error) {
      throw new SearchValidationError('Search scope is invalid.', { cause: error });
    }
  }

  #todayDate(): string {
    try {
      return normalizeScheduleCivilDate(this.#todayFactory());
    } catch (error) {
      throw new SearchValidationError('Search date is invalid.', { cause: error });
    }
  }
}
