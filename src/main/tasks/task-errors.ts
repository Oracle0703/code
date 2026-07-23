export type TaskErrorCode = 'TASK_NOT_FOUND' | 'TASK_OPERATION_FAILED' | 'TASK_VALIDATION_FAILED';

export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class TaskValidationError extends TaskError {
  constructor(message: string, options?: ErrorOptions) {
    super('TASK_VALIDATION_FAILED', message, options);
  }
}

export class TaskNotFoundError extends TaskError {
  constructor(message = 'The task is unavailable.', options?: ErrorOptions) {
    super('TASK_NOT_FOUND', message, options);
  }
}

export class TaskOperationError extends TaskError {
  constructor(message = 'The task operation failed.', options?: ErrorOptions) {
    super('TASK_OPERATION_FAILED', message, options);
  }
}
