export type WorkspaceErrorCode =
  | 'WORKSPACE_CONFLICT'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_OPERATION_FAILED'
  | 'WORKSPACE_VALIDATION_FAILED';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class WorkspaceValidationError extends WorkspaceError {
  constructor(message: string, options?: ErrorOptions) {
    super('WORKSPACE_VALIDATION_FAILED', message, options);
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(message = 'The workspace is unavailable.', options?: ErrorOptions) {
    super('WORKSPACE_NOT_FOUND', message, options);
  }
}

export class WorkspaceConflictError extends WorkspaceError {
  constructor(message: string, options?: ErrorOptions) {
    super('WORKSPACE_CONFLICT', message, options);
  }
}

export class WorkspaceOperationError extends WorkspaceError {
  constructor(message = 'The workspace operation failed.', options?: ErrorOptions) {
    super('WORKSPACE_OPERATION_FAILED', message, options);
  }
}
