export type NoteErrorCode =
  'NOTE_CONFLICT' | 'NOTE_NOT_FOUND' | 'NOTE_OPERATION_FAILED' | 'NOTE_VALIDATION_FAILED';

export class NoteError extends Error {
  readonly code: NoteErrorCode;

  constructor(code: NoteErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NoteValidationError extends NoteError {
  constructor(message: string, options?: ErrorOptions) {
    super('NOTE_VALIDATION_FAILED', message, options);
  }
}

export class NoteNotFoundError extends NoteError {
  constructor(message = 'The note is unavailable.', options?: ErrorOptions) {
    super('NOTE_NOT_FOUND', message, options);
  }
}

export class NoteConflictError extends NoteError {
  constructor(
    message = 'The note changed before this operation completed.',
    options?: ErrorOptions,
  ) {
    super('NOTE_CONFLICT', message, options);
  }
}

export class NoteOperationError extends NoteError {
  constructor(message = 'The note operation failed.', options?: ErrorOptions) {
    super('NOTE_OPERATION_FAILED', message, options);
  }
}
