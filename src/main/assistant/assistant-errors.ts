import type { AssistantErrorCode, AssistantCredentialReason } from '../../shared/contracts';

export class AssistantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantContextError';
  }
}

export class AssistantCredentialError extends Error {
  readonly reason: Exclude<AssistantCredentialReason, null>;

  constructor(reason: Exclude<AssistantCredentialReason, null>, message: string) {
    super(message);
    this.name = 'AssistantCredentialError';
    this.reason = reason;
  }
}

export class AssistantProviderError extends Error {
  readonly code: Exclude<AssistantErrorCode, 'not-configured' | 'credential-unavailable'>;

  constructor(
    code: Exclude<AssistantErrorCode, 'not-configured' | 'credential-unavailable'>,
    message: string,
  ) {
    super(message);
    this.name = 'AssistantProviderError';
    this.code = code;
  }
}
