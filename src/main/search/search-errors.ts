export type SearchErrorCode =
  'SEARCH_NOT_FOUND' | 'SEARCH_OPERATION_FAILED' | 'SEARCH_VALIDATION_FAILED';

export class SearchError extends Error {
  readonly code: SearchErrorCode;

  constructor(code: SearchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearchError';
    this.code = code;
  }
}

export class SearchValidationError extends SearchError {
  constructor(message: string, options?: ErrorOptions) {
    super('SEARCH_VALIDATION_FAILED', message, options);
    this.name = 'SearchValidationError';
  }
}

export class SearchNotFoundError extends SearchError {
  constructor(message = 'The search workspace is unavailable.', options?: ErrorOptions) {
    super('SEARCH_NOT_FOUND', message, options);
    this.name = 'SearchNotFoundError';
  }
}

export class SearchOperationError extends SearchError {
  constructor(message = 'The search operation failed.', options?: ErrorOptions) {
    super('SEARCH_OPERATION_FAILED', message, options);
    this.name = 'SearchOperationError';
  }
}
