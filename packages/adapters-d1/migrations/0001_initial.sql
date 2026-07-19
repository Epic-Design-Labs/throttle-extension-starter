PRAGMA foreign_keys = ON;

CREATE TABLE installations (
  installation_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  environment_kind TEXT NOT NULL CHECK (environment_kind IN ('production', 'non_production')),
  extension_version TEXT NOT NULL,
  provider_account_reference TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disconnected', 'uninstalled')),
  last_successful_sync_cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  uninstalled_at TEXT,
  CHECK ((status = 'uninstalled') = (uninstalled_at IS NOT NULL))
);
CREATE INDEX installations_webhook_candidates ON installations(workspace_id, environment_id, installation_id);
CREATE INDEX installations_tenant ON installations(workspace_id, environment_id, application_id, installation_id);

CREATE TABLE secrets (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('throttleApiKey', 'webhookSigningSecret', 'providerCredentials')),
  algorithm TEXT NOT NULL CHECK (algorithm = 'A256GCM'),
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, kind)
);

CREATE TABLE deliveries (
  installation_id TEXT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (installation_id, event_id)
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  payload_reference TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'retry', 'processing', 'completed', 'failed', 'cancelled')),
  scheduled_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
  ,lease_expires_at TEXT
);
CREATE INDEX jobs_pending_schedule ON jobs(status, scheduled_at);
CREATE INDEX jobs_installation_history ON jobs(installation_id, created_at DESC, job_id DESC);

CREATE TABLE activities (
  activity_id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  event_id TEXT,
  job_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('event_received', 'connector_sync')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed')),
  result TEXT NOT NULL CHECK (result IN ('success', 'retryable_failure', 'terminal_failure', 'skipped')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  message TEXT,
  code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX activities_installation_recent ON activities(installation_id, created_at DESC, activity_id DESC);

CREATE TRIGGER secrets_block_uninstalled_insert BEFORE INSERT ON secrets
WHEN (SELECT status FROM installations WHERE installation_id = NEW.installation_id) = 'uninstalled'
BEGIN SELECT RAISE(ABORT, 'installation is uninstalled'); END;

CREATE TRIGGER secrets_block_uninstalled_update BEFORE UPDATE ON secrets
WHEN (SELECT status FROM installations WHERE installation_id = NEW.installation_id) = 'uninstalled'
BEGIN SELECT RAISE(ABORT, 'installation is uninstalled'); END;

CREATE TRIGGER jobs_block_uninstalled_insert BEFORE INSERT ON jobs
WHEN (SELECT status FROM installations WHERE installation_id = NEW.installation_id) = 'uninstalled'
BEGIN SELECT RAISE(ABORT, 'installation is uninstalled'); END;

CREATE TRIGGER jobs_block_uninstalled_requeue BEFORE UPDATE ON jobs
WHEN NEW.status IN ('pending', 'retry', 'processing')
 AND (SELECT status FROM installations WHERE installation_id = NEW.installation_id) = 'uninstalled'
BEGIN SELECT RAISE(ABORT, 'installation is uninstalled'); END;
