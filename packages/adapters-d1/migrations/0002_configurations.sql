PRAGMA foreign_keys = ON;

CREATE TABLE configurations (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(installation_id) ON DELETE CASCADE,
  configuration_json TEXT NOT NULL CHECK (length(configuration_json) <= 32768),
  updated_at TEXT NOT NULL
);

CREATE TRIGGER configurations_block_uninstalled_insert BEFORE INSERT ON configurations
WHEN (SELECT status FROM installations WHERE installation_id = NEW.installation_id) = 'uninstalled'
BEGIN SELECT RAISE(ABORT, 'installation is uninstalled'); END;

CREATE TRIGGER configurations_block_uninstalled_update BEFORE UPDATE ON configurations
WHEN (SELECT status FROM installations WHERE installation_id = NEW.installation_id) = 'uninstalled'
BEGIN SELECT RAISE(ABORT, 'installation is uninstalled'); END;
