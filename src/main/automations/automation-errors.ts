export type AutomationErrorCode =
  | 'AUTOMATION_CONFLICT'
  | 'AUTOMATION_LIMIT_REACHED'
  | 'AUTOMATION_NOT_FOUND'
  | 'AUTOMATION_OPERATION_FAILED'
  | 'AUTOMATION_VALIDATION_FAILED';

export class AutomationError extends Error {
  readonly code: AutomationErrorCode;

  constructor(code: AutomationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AutomationValidationError extends AutomationError {
  constructor(message: string, options?: ErrorOptions) {
    super('AUTOMATION_VALIDATION_FAILED', message, options);
  }
}

export class AutomationNotFoundError extends AutomationError {
  constructor(message = 'The automation is unavailable.', options?: ErrorOptions) {
    super('AUTOMATION_NOT_FOUND', message, options);
  }
}

export class AutomationConflictError extends AutomationError {
  constructor(
    message = 'The automation changed before this operation completed.',
    options?: ErrorOptions,
  ) {
    super('AUTOMATION_CONFLICT', message, options);
  }
}

export class AutomationLimitError extends AutomationError {
  constructor(message: string, options?: ErrorOptions) {
    super('AUTOMATION_LIMIT_REACHED', message, options);
  }
}

export class AutomationOperationError extends AutomationError {
  constructor(message = 'The automation operation failed.', options?: ErrorOptions) {
    super('AUTOMATION_OPERATION_FAILED', message, options);
  }
}
