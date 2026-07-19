export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503,
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
