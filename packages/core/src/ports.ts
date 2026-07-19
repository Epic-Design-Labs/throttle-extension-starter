import type { Activity, ConnectorJob, Installation } from '@starter/contracts';

export interface InstallationStore {
  get(installationId: string): Promise<Installation | undefined>;
  upsert(installation: Installation): Promise<Installation>;
  markUninstalled(installationId: string, uninstalledAt: Date): Promise<void>;
  /**
   * Returns a bounded candidate set using untrusted webhook routing hints.
   * No returned installation is trusted until its per-install secret verifies
   * the webhook. This lookup alone must never trigger provider work.
   */
  findWebhookVerificationCandidates(input: {
    workspaceId: string;
    environmentId: string;
  }): Promise<Installation[]>;
}

export interface CredentialStore {
  get(installationId: string): Promise<Uint8Array | undefined>;
  set(installationId: string, credentials: Uint8Array): Promise<void>;
  delete(installationId: string): Promise<void>;
}

export interface DeliveryStore {
  accept(input: {
    installationId: string;
    eventId: string;
    acceptedAt: Date;
  }): Promise<boolean>;
}

export interface JobQueue {
  enqueue(job: ConnectorJob): Promise<void>;
}

export interface ActivityStore {
  append(activity: Activity): Promise<void>;
  list(input: { installationId: string; limit: number }): Promise<Activity[]>;
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
