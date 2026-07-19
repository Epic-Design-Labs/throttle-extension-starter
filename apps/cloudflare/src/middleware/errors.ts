import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  InfrastructureError,
  RetryableProviderError,
  TerminalProviderError,
  ValidationError,
} from '@starter/core';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const authenticationFailed = () =>
  new HttpError(401, 'AUTHENTICATION_FAILED', 'Authentication failed.');
export const forbidden = () =>
  new HttpError(403, 'ACCESS_DENIED', 'Access is not permitted.');
export const invalidRequest = () =>
  new HttpError(400, 'INVALID_REQUEST', 'The request is invalid.');

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ValidationError)
    return new HttpError(400, 'INVALID_REQUEST', error.message);
  if (error instanceof AuthenticationError)
    return new HttpError(401, 'AUTHENTICATION_FAILED', error.message);
  if (error instanceof AuthorizationError)
    return new HttpError(403, 'ACCESS_DENIED', error.message);
  if (error instanceof ConfigurationError)
    return new HttpError(422, 'CONFIGURATION_INVALID', error.message);
  if (error instanceof TerminalProviderError)
    return new HttpError(422, 'PROVIDER_REJECTED', error.message);
  if (error instanceof RetryableProviderError)
    return new HttpError(503, 'PROVIDER_UNAVAILABLE', error.message);
  if (error instanceof InfrastructureError)
    return new HttpError(503, 'INFRASTRUCTURE_UNAVAILABLE', error.message);
  return new HttpError(500, 'INTERNAL_ERROR', 'A temporary error occurred.');
}
