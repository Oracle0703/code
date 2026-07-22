export type InboxErrorCode =
  | 'INBOX_NOT_FOUND'
  | 'INBOX_OPERATION_FAILED'
  | 'INBOX_UNDO_UNAVAILABLE'
  | 'INBOX_VALIDATION_FAILED';

export class InboxError extends Error {
  readonly code: InboxErrorCode;

  constructor(code: InboxErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InboxValidationError extends InboxError {
  constructor(message: string, options?: ErrorOptions) {
    super('INBOX_VALIDATION_FAILED', message, options);
  }
}

export class InboxNotFoundError extends InboxError {
  constructor(message = 'The inbox entry is unavailable.', options?: ErrorOptions) {
    super('INBOX_NOT_FOUND', message, options);
  }
}

export class InboxUndoUnavailableError extends InboxError {
  constructor(message = 'The inbox archive can no longer be undone.', options?: ErrorOptions) {
    super('INBOX_UNDO_UNAVAILABLE', message, options);
  }
}

export class InboxOperationError extends InboxError {
  constructor(message = 'The inbox operation failed.', options?: ErrorOptions) {
    super('INBOX_OPERATION_FAILED', message, options);
  }
}
