import type {
  Activity,
  ConnectorJob,
  Installation,
  WebhookVerificationCandidate,
} from '@starter/contracts';

export interface InstallationScope {
  workspaceId: string;
  applicationId: string;
  environmentId: string;
}

export interface InstallationStore {
  get(
    installationId: string,
    scope: InstallationScope,
  ): Promise<Installation | undefined>;
  /** Trusted worker lookup. IDs must originate from the verified internal enqueue path. */
  getForJob(installationId: string): Promise<Installation | undefined>;
  upsert(installation: Installation): Promise<Installation>;
  markUninstalled(
    installationId: string,
    scope: InstallationScope,
    uninstalledAt: Date,
  ): Promise<void>;
  /** Updates connector metadata while preserving installation identity and lifecycle. */
  updateProviderAccountReference(
    installationId: string,
    scope: InstallationScope,
    providerAccountReference: string,
    updatedAt: Date,
  ): Promise<Installation>;
  /**
   * Returns a bounded candidate set using untrusted webhook routing hints.
   * No returned installation is trusted until its per-install secret verifies
   * the webhook. This lookup alone must never trigger provider work.
   */
  findWebhookVerificationCandidates(input: {
    workspaceId: string;
    environmentId: string;
  }): Promise<WebhookVerificationCandidate[]>;
}

export interface CredentialStore {
  /** Returns a fresh caller-owned buffer. The caller must wipe it after use. */
  get(
    installationId: string,
    kind: CredentialKind,
  ): Promise<Uint8Array | undefined>;
  /**
   * Must copy or consume credentials before resolving. Implementations must
   * never retain the caller-owned Uint8Array reference.
   */
  set(
    installationId: string,
    kind: CredentialKind,
    credentials: Uint8Array,
  ): Promise<void>;
  delete(installationId: string, kind?: CredentialKind): Promise<void>;
}

export type JobClaimResult = 'claimed' | 'duplicate' | 'unavailable';
export type JobFinishResult = 'finished' | 'cancelled' | 'stale';
export interface JobExecutionStore {
  /**
   * Pending/retry jobs claim only stored attempt + 1. An expired processing
   * lease reclaims only its stored attempt. Same/stale attempts are duplicate;
   * skipped/future attempts are unavailable.
   */
  claim(input: {
    jobId: string;
    attempt: number;
    now: Date;
  }): Promise<JobClaimResult>;
  finish(input: {
    jobId: string;
    attempt: number;
    status: 'completed' | 'retry' | 'failed';
    now: Date;
  }): Promise<JobFinishResult>;
}

export interface ProviderConnectionStore {
  /** Atomically persists both values, copying credentials before resolving. */
  commit(input: {
    installationId: string;
    scope: InstallationScope;
    credentials: Uint8Array;
    providerAccountReference: string;
    now: Date;
  }): Promise<Installation>;
}

export type CredentialKind =
  'throttleApiKey' | 'webhookSigningSecret' | 'providerCredentials';

export interface DeliveryStore {
  accept(input: {
    installationId: string;
    eventId: string;
    eventType: string;
    acceptedAt: Date;
  }): Promise<{ accepted: boolean }>;
}

export interface JobQueue {
  enqueue(job: ConnectorJob): Promise<void>;
}

export interface ActivityStore {
  /** Idempotent by activityId, allowing at-least-once job delivery. */
  append(activity: Activity): Promise<void>;
  list(input: { installationId: string; limit: number }): Promise<Activity[]>;
}

export type ConfigurationValue =
  | null
  | boolean
  | number
  | string
  | ConfigurationValue[]
  | { [key: string]: ConfigurationValue };
export interface ConfigurationStore {
  get(installationId: string): Promise<ConfigurationValue | undefined>;
  set(installationId: string, configuration: ConfigurationValue): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
