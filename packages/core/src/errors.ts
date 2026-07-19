export type ErrorClassification = 'retryable' | 'terminal';

export interface PublicErrorShape {
  code: string;
  message: string;
  classification: ErrorClassification;
}

export interface CoreErrorOptions {
  cause?: unknown;
}

abstract class CoreError extends Error {
  abstract readonly code: string;
  abstract readonly classification: ErrorClassification;

  protected constructor(message: string, options?: CoreErrorOptions) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
  }

  toJSON(): PublicErrorShape {
    return {
      code: this.code,
      message: this.message,
      classification: this.classification,
    };
  }
}

export class ValidationError extends CoreError {
  readonly code = 'validationError';
  readonly classification = 'terminal';

  constructor(options?: CoreErrorOptions) {
    super('The request is invalid.', options);
  }
}

export class AuthenticationError extends CoreError {
  readonly code = 'authenticationError';
  readonly classification = 'terminal';

  constructor(options?: CoreErrorOptions) {
    super('Authentication failed.', options);
  }
}

export class AuthorizationError extends CoreError {
  readonly code = 'authorizationError';
  readonly classification = 'terminal';

  constructor(options?: CoreErrorOptions) {
    super('Access is not permitted.', options);
  }
}

export class ConfigurationError extends CoreError {
  readonly code = 'configurationError';
  readonly classification = 'terminal';

  constructor(options?: CoreErrorOptions) {
    super('Configuration is invalid.', options);
  }
}

export class RetryableProviderError extends CoreError {
  readonly code = 'retryableProviderError';
  readonly classification = 'retryable';

  constructor(options?: CoreErrorOptions) {
    super('The provider is temporarily unavailable.', options);
  }
}

export class TerminalProviderError extends CoreError {
  readonly code = 'terminalProviderError';
  readonly classification = 'terminal';

  constructor(options?: CoreErrorOptions) {
    super('The provider rejected the operation.', options);
  }
}

export class InfrastructureError extends CoreError {
  readonly code = 'infrastructureError';
  readonly classification = 'retryable';

  constructor(options?: CoreErrorOptions) {
    super('A temporary infrastructure failure occurred.', options);
  }
}
