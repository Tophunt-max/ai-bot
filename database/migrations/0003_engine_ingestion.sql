-- Owner + primary account (personal use) so gateway events can be journaled with FKs intact.
INSERT OR IGNORE INTO users (id, email, role, mfa_enabled, status, created_at, updated_at)
VALUES ('owner', 'owner@local', 'OWNER', 0, 'ACTIVE', 0, 0);

INSERT OR IGNORE INTO accounts (id, user_id, broker_id, broker_client_id, label, trading_mode, status, created_at, updated_at)
VALUES ('owner-primary', 'owner', 'paper', NULL, 'Primary', 'PAPER', 'ACTIVE', 0, 0);

-- Human-readable model version string on journal rows (model_version_id stays the registry FK).
ALTER TABLE signals ADD COLUMN model_version TEXT;
ALTER TABLE trades ADD COLUMN model_version TEXT;
ALTER TABLE trades ADD COLUMN r_multiple REAL;
ALTER TABLE trades ADD COLUMN gross_pnl REAL;

CREATE TABLE push_tokens (
  token       TEXT PRIMARY KEY,               -- Expo push token
  user_id     TEXT NOT NULL REFERENCES users(id),
  platform    TEXT,
  created_at  INTEGER NOT NULL
);

-- Idempotent ingestion ledger for gateway events.
CREATE TABLE ingested_events (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  at          INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_ingested_type_time ON ingested_events(type, at DESC);

CREATE INDEX idx_positions_status ON positions(account_id, status);
