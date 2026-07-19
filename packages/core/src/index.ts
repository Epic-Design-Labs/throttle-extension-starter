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
  WebhookCandidateLookupResult,
} from './ports.js';
export type { ConfigurationValue } from '@starter/contracts';
export { MAX_WEBHOOK_VERIFICATION_CANDIDATES } from '@starter/contracts';
export {
  classifyProviderFailure,
  MAX_JOB_ATTEMPTS,
  retryDelaySeconds,
} from './retry.js';
export type { ProviderFailureClassification } from './retry.js';
