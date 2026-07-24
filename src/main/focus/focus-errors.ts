export type FocusErrorCode =
  'FOCUS_CONFLICT' | 'FOCUS_NOT_FOUND' | 'FOCUS_OPERATION_FAILED' | 'FOCUS_VALIDATION_FAILED';

export class FocusError extends Error {
  readonly code: FocusErrorCode;

  constructor(code: FocusErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class FocusValidationError extends FocusError {
  constructor(message: string, options?: ErrorOptions) {
    super('FOCUS_VALIDATION_FAILED', message, options);
  }
}

export class FocusNotFoundError extends FocusError {
  constructor(message = 'The focus session is unavailable.', options?: ErrorOptions) {
    super('FOCUS_NOT_FOUND', message, options);
  }
}

export class FocusConflictError extends FocusError {
  constructor(
    message = 'The focus session changed before this operation completed.',
    options?: ErrorOptions,
  ) {
    super('FOCUS_CONFLICT', message, options);
  }
}

export class FocusOperationError extends FocusError {
  constructor(message = 'The focus operation failed.', options?: ErrorOptions) {
    super('FOCUS_OPERATION_FAILED', message, options);
  }
}
