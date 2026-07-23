export type BrowserErrorCode =
  | 'BROWSER_CONFLICT'
  | 'BROWSER_NOT_FOUND'
  | 'BROWSER_OPERATION_FAILED'
  | 'BROWSER_VALIDATION_FAILED';

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;

  constructor(code: BrowserErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class BrowserValidationError extends BrowserError {
  constructor(message: string, options?: ErrorOptions) {
    super('BROWSER_VALIDATION_FAILED', message, options);
  }
}

export class BrowserNotFoundError extends BrowserError {
  constructor(message = 'The browser item is unavailable.', options?: ErrorOptions) {
    super('BROWSER_NOT_FOUND', message, options);
  }
}

export class BrowserConflictError extends BrowserError {
  constructor(message = 'The browser state changed before this operation completed.') {
    super('BROWSER_CONFLICT', message);
  }
}

export class BrowserOperationError extends BrowserError {
  constructor(message = 'The browser operation failed.', options?: ErrorOptions) {
    super('BROWSER_OPERATION_FAILED', message, options);
  }
}
