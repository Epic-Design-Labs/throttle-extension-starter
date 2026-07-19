import type {
  Activity,
  ConnectorJob,
  Installation,
  WebhookVerificationCandidate,
} from '@starter/contracts';
import type { ConfigurationValue } from '@starter/contracts';

export interface InstallationScope {
  workspaceId: string;
  applicationId: string;
  environmentId: string;
}
export type WebhookCandidateLookupResult =
  | { status: 'ok'; candidates: WebhookVerificationCandidate[] }
  | { status: 'overflow' };

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
  }): Promise<WebhookCandidateLookupResult>;
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

export type JobClaimResult =
  | { status: 'claimed'; token: string; attempt: number }
  | { status: 'busy'; retryAfterSeconds: number }
  | { status: 'duplicate' }
  | { status: 'unavailable' };
export type JobFinishResult = 'finished' | 'cancelled' | 'stale';
export interface JobExecutionStore {
  /**
   * Atomically selects the durable business attempt. Pending/retry advances
   * stored attempt once; an expired processing lease reclaims the same attempt.
   * A live lease is busy, while terminal rows are duplicate. Queue delivery
   * counts and immutable message bodies are never authoritative attempts.
   */
  claim(input: { jobId: string; now: Date }): Promise<JobClaimResult>;
  finish(input: {
    jobId: string;
    attempt: number;
    token: string;
    status: 'completed' | 'retry' | 'failed';
    /** Required for retry; the durable store must not claim before this time. */
    nextEligibleAt?: Date;
    /** Sanitized outcome persisted atomically with the fenced state change. */
    activity: Activity;
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
