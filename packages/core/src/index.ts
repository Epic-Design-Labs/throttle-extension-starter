export {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  InfrastructureError,
  RetryableProviderError,
  TerminalProviderError,
  toActivityErrorCode,
  ValidationError,
} from './errors.js';
export type {
  AppError,
  CoreErrorOptions,
  ErrorClassification,
  PublicErrorShape,
} from './errors.js';
export type { ProviderConnector } from './provider.js';
export type {
  ActivityStore,
  Clock,
  CredentialStore,
  CredentialKind,
  DeliveryStore,
  InstallationStore,
  InstallationScope,
  JobQueue,
  LogFields,
  Logger,
} from './ports.js';
export { MAX_WEBHOOK_VERIFICATION_CANDIDATES } from '@starter/contracts';
export {
  classifyProviderFailure,
  MAX_JOB_ATTEMPTS,
  retryDelaySeconds,
} from './retry.js';
export type { ProviderFailureClassification } from './retry.js';
