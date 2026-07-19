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
export { connectProvider } from './connect-provider.js';
export type {
  ConnectProviderDependencies,
  ConnectProviderInput,
} from './connect-provider.js';
export {
  connectorIdempotencyKey,
  processConnectorEvent,
} from './process-event.js';
export type {
  ProcessConnectorEventDependencies,
  ProcessConnectorEventResult,
} from './process-event.js';
export type {
  ActivityStore,
  Clock,
  ConfigurationStore,
  ConfigurationValue,
  CredentialStore,
  CredentialKind,
  DeliveryStore,
  InstallationStore,
  JobClaimResult,
  JobExecutionStore,
  JobFinishResult,
  InstallationScope,
  JobQueue,
  LogFields,
  Logger,
  ProviderConnectionStore,
} from './ports.js';
export { MAX_WEBHOOK_VERIFICATION_CANDIDATES } from '@starter/contracts';
export {
  classifyProviderFailure,
  MAX_JOB_ATTEMPTS,
  retryDelaySeconds,
} from './retry.js';
export type { ProviderFailureClassification } from './retry.js';
