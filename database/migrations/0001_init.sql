-- AI Trading Bot V3 — initial D1 schema (SQLite dialect).
-- D1 holds transactional APPLICATION data only. Tick/candle history lives in TimescaleDB,
-- large artifacts in R2. Money is stored as REAL INR; quantities as INTEGER.
-- Timestamps are epoch milliseconds (INTEGER).

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER', 'VIEWER')),
  mfa_enabled   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE brokers (
  id            TEXT PRIMARY KEY,               -- BrokerId e.g. 'zerodha'
  name          TEXT NOT NULL,
  adapter       TEXT NOT NULL CHECK (adapter IN ('implemented', 'planned')),
  enabled       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE accounts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  broker_id        TEXT NOT NULL REFERENCES brokers(id),
  broker_client_id TEXT,                         -- non-secret client code only; secrets live on the gateway
  label            TEXT NOT NULL,
  trading_mode     TEXT NOT NULL DEFAULT 'PAPER'
                   CHECK (trading_mode IN ('BACKTEST','PAPER','SHADOW','CANARY','LIVE','SAFE_MODE')),
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  canary_capital_pct REAL NOT NULL DEFAULT 5 CHECK (canary_capital_pct > 0 AND canary_capital_pct <= 100),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  UNIQUE (broker_id, broker_client_id)
);
CREATE INDEX idx_accounts_user ON accounts(user_id);

CREATE TABLE instruments (
  id               TEXT PRIMARY KEY,             -- 'NSE:RELIANCE'
  exchange         TEXT NOT NULL CHECK (exchange IN ('NSE','BSE','NFO','BFO','MCX','CDS')),
  trading_symbol   TEXT NOT NULL,
  instrument_type  TEXT NOT NULL CHECK (instrument_type IN ('EQ','FUT','CE','PE','INDEX')),
  underlying       TEXT,
  lot_size         INTEGER NOT NULL CHECK (lot_size > 0),
  tick_size        REAL NOT NULL CHECK (tick_size > 0),
  freeze_quantity  INTEGER,
  expiry           TEXT,
  strike           REAL,
  broker_tokens    TEXT NOT NULL DEFAULT '{}',   -- JSON map brokerId -> token/securityId
  in_fno_ban       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  updated_at       INTEGER NOT NULL,
  UNIQUE (exchange, trading_symbol)
);
CREATE INDEX idx_instruments_underlying ON instruments(underlying, expiry);

CREATE TABLE strategies (
  id            TEXT PRIMARY KEY,                -- StrategyId
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 0,
  config        TEXT NOT NULL DEFAULT '{}',
  version       TEXT NOT NULL DEFAULT '0.1.0',
  updated_at    INTEGER NOT NULL
);

CREATE TABLE model_versions (
  id                     TEXT PRIMARY KEY,
  model_id               TEXT NOT NULL,
  version                TEXT NOT NULL,
  features_version       TEXT NOT NULL,
  dataset_version        TEXT NOT NULL,
  training_date          INTEGER NOT NULL,
  validation_metrics     TEXT NOT NULL DEFAULT '{}',
  out_of_sample_metrics  TEXT NOT NULL DEFAULT '{}',
  artifact_r2_key        TEXT,
  status                 TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT','VALIDATING','PAPER','SHADOW','CANARY','PRODUCTION','RETIRED')),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE (model_id, version)
);
CREATE INDEX idx_model_versions_status ON model_versions(status);

CREATE TABLE signals (
  id                  TEXT PRIMARY KEY,
  account_id          TEXT NOT NULL REFERENCES accounts(id),
  instrument_id       TEXT NOT NULL REFERENCES instruments(id),
  decision            TEXT NOT NULL CHECK (decision IN ('BUY','SELL','WAIT','NO_TRADE','EXIT','REDUCE')),
  regime              TEXT NOT NULL,
  quality             REAL NOT NULL CHECK (quality >= 0 AND quality <= 1),
  entry               REAL,
  stop                REAL,
  targets             TEXT NOT NULL DEFAULT '[]',
  strategies_agreeing INTEGER NOT NULL DEFAULT 0,
  strategies_total    INTEGER NOT NULL DEFAULT 0,
  model_version_id    TEXT REFERENCES model_versions(id),
  reasons             TEXT NOT NULL DEFAULT '{}',
  risk_decision       TEXT CHECK (risk_decision IN ('APPROVED','REJECTED')),
  risk_failed_check   TEXT,
  mode                TEXT NOT NULL,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_signals_account_time ON signals(account_id, created_at DESC);

CREATE TABLE orders (
  id                 TEXT PRIMARY KEY,
  client_order_id    TEXT NOT NULL UNIQUE,       -- idempotency key
  account_id         TEXT NOT NULL REFERENCES accounts(id),
  signal_id          TEXT REFERENCES signals(id),
  instrument_id      TEXT NOT NULL REFERENCES instruments(id),
  broker_order_id    TEXT,
  leg                TEXT NOT NULL CHECK (leg IN ('ENTRY','SL','TP1','TP2','TP3','EXIT')),
  side               TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  order_type         TEXT NOT NULL CHECK (order_type IN ('LIMIT','SL_LIMIT')),
  product            TEXT NOT NULL CHECK (product IN ('INTRADAY','DELIVERY','NORMAL')),
  quantity           INTEGER NOT NULL CHECK (quantity > 0),
  filled_quantity    INTEGER NOT NULL DEFAULT 0 CHECK (filled_quantity >= 0),
  price              REAL NOT NULL,
  trigger_price      REAL,
  average_price      REAL,
  status             TEXT NOT NULL CHECK (status IN ('CREATED','VALIDATED','SUBMITTED','ACKNOWLEDGED',
                       'PARTIALLY_FILLED','FILLED','REJECTED','CANCELLED','EXPIRED','UNKNOWN')),
  mode               TEXT NOT NULL,
  gateway_node       TEXT,
  status_message     TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (account_id, broker_order_id)
);
CREATE INDEX idx_orders_account_status ON orders(account_id, status);
CREATE INDEX idx_orders_signal ON orders(signal_id);

CREATE TABLE fills (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders(id),
  broker_trade_id TEXT,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  price           REAL NOT NULL,
  fees            REAL NOT NULL DEFAULT 0,
  filled_at       INTEGER NOT NULL,
  UNIQUE (order_id, broker_trade_id)
);

CREATE TABLE positions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  instrument_id   TEXT NOT NULL REFERENCES instruments(id),
  product         TEXT NOT NULL,
  quantity        INTEGER NOT NULL,             -- signed
  average_price   REAL NOT NULL,
  stop_price      REAL,                         -- must be set for any open position
  stop_order_id   TEXT REFERENCES orders(id),   -- broker-resident protective stop
  targets         TEXT NOT NULL DEFAULT '[]',
  realised_pnl    REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  mode            TEXT NOT NULL,
  opened_at       INTEGER NOT NULL,
  closed_at       INTEGER,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_positions_open ON positions(account_id, instrument_id, product, mode) WHERE status = 'OPEN';

CREATE TABLE trades (                             -- trade journal (closed round trips)
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  position_id      TEXT REFERENCES positions(id),
  signal_id        TEXT REFERENCES signals(id),
  instrument_id    TEXT NOT NULL REFERENCES instruments(id),
  strategy         TEXT,
  regime           TEXT,
  side             TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity         INTEGER NOT NULL,
  entry_price      REAL NOT NULL,
  exit_price       REAL NOT NULL,
  stop_price       REAL,
  targets          TEXT NOT NULL DEFAULT '[]',
  risk_amount      REAL,
  signal_quality   REAL,
  fees             REAL NOT NULL DEFAULT 0,
  slippage         REAL NOT NULL DEFAULT 0,
  pnl              REAL NOT NULL,
  mfe              REAL,
  mae              REAL,
  holding_time_ms  INTEGER,
  model_version_id TEXT REFERENCES model_versions(id),
  exit_reason      TEXT,
  mode             TEXT NOT NULL,
  opened_at        INTEGER NOT NULL,
  closed_at        INTEGER NOT NULL
);
CREATE INDEX idx_trades_account_time ON trades(account_id, closed_at DESC);
CREATE INDEX idx_trades_strategy ON trades(strategy, regime);

CREATE TABLE risk_events (
  id           TEXT PRIMARY KEY,
  account_id   TEXT REFERENCES accounts(id),
  type         TEXT NOT NULL,                   -- LIMIT_BREACH, KILL_SWITCH, LOCK, UNLOCK, WARNING
  trigger      TEXT,
  severity     TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  details      TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_risk_events_time ON risk_events(created_at DESC);

CREATE TABLE backtests (
  id            TEXT PRIMARY KEY,
  strategy      TEXT,
  model_version_id TEXT REFERENCES model_versions(id),
  params        TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  metrics       TEXT NOT NULL DEFAULT '{}',
  report_r2_key TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  event       TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('PUSH','TELEGRAM','EMAIL')),
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL CHECK (status IN ('PENDING','SENT','FAILED')),
  dedupe_key  TEXT UNIQUE,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);

CREATE TABLE audit_logs (                         -- append-only (enforced by triggers below)
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL,                     -- user id | 'system' | 'gateway:<node>'
  action      TEXT NOT NULL,
  target      TEXT,
  before      TEXT,
  after       TEXT,
  request_id  TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_time ON audit_logs(created_at DESC);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TABLE system_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,                     -- worker | gateway | ai | cron
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  details     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_system_events_time ON system_events(created_at DESC);

CREATE TABLE cron_runs (                          -- idempotency for scheduled jobs
  job         TEXT NOT NULL,
  run_key     TEXT NOT NULL,                     -- e.g. '2026-10-01' for a daily job
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
  PRIMARY KEY (job, run_key)
);

CREATE TABLE market_holidays (
  date        TEXT PRIMARY KEY,                  -- YYYY-MM-DD IST
  exchange    TEXT NOT NULL DEFAULT 'NSE',
  description TEXT
);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
