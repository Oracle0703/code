export type ScheduleErrorCode =
  | 'SCHEDULE_CONFLICT'
  | 'SCHEDULE_NOT_FOUND'
  | 'SCHEDULE_OPERATION_FAILED'
  | 'SCHEDULE_VALIDATION_FAILED';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ScheduleValidationError extends ScheduleError {
  constructor(message: string, options?: ErrorOptions) {
    super('SCHEDULE_VALIDATION_FAILED', message, options);
  }
}

export class ScheduleNotFoundError extends ScheduleError {
  constructor(message = 'The schedule item is unavailable.', options?: ErrorOptions) {
    super('SCHEDULE_NOT_FOUND', message, options);
  }
}

export class ScheduleConflictError extends ScheduleError {
  constructor(
    message = 'The schedule changed before this operation completed.',
    options?: ErrorOptions,
  ) {
    super('SCHEDULE_CONFLICT', message, options);
  }
}

export class ScheduleOperationError extends ScheduleError {
  constructor(message = 'The schedule operation failed.', options?: ErrorOptions) {
    super('SCHEDULE_OPERATION_FAILED', message, options);
  }
}
