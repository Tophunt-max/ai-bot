-- Crypto market support: CRYPTO exchange, SPOT/PERP instruments, fractional lot sizes,
-- the CCXT "crypto" broker, and two new books (crypto_demo, crypto_real).
-- SQLite cannot ALTER a CHECK constraint, so `instruments` is rebuilt. FK checks are deferred
-- to the end of the migration transaction (D1 recommendation for table rebuilds).
PRAGMA defer_foreign_keys = on;

CREATE TABLE instruments_new (
  id               TEXT PRIMARY KEY,             -- 'NSE:RELIANCE' | 'CRYPTO:binance:BTC/USDT'
  exchange         TEXT NOT NULL CHECK (exchange IN ('NSE','BSE','NFO','BFO','MCX','CDS','CRYPTO')),
  trading_symbol   TEXT NOT NULL,
  instrument_type  TEXT NOT NULL CHECK (instrument_type IN ('EQ','FUT','CE','PE','INDEX','SPOT','PERP')),
  underlying       TEXT,
  lot_size         REAL NOT NULL CHECK (lot_size > 0),   -- fractional steps for crypto
  tick_size        REAL NOT NULL CHECK (tick_size > 0),
  freeze_quantity  REAL,
  expiry           TEXT,
  strike           REAL,
  broker_tokens    TEXT NOT NULL DEFAULT '{}',
  in_fno_ban       INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  venue            TEXT,                          -- CCXT exchange id for crypto
  quote_currency   TEXT,
  updated_at       INTEGER NOT NULL,
  UNIQUE (exchange, trading_symbol, venue)
);

INSERT INTO instruments_new (id, exchange, trading_symbol, instrument_type, underlying, lot_size, tick_size,
  freeze_quantity, expiry, strike, broker_tokens, in_fno_ban, active, updated_at)
SELECT id, exchange, trading_symbol, instrument_type, underlying, lot_size, tick_size,
  freeze_quantity, expiry, strike, broker_tokens, in_fno_ban, active, updated_at FROM instruments;

DROP TABLE instruments;
ALTER TABLE instruments_new RENAME TO instruments;
CREATE INDEX idx_instruments_underlying ON instruments(underlying, expiry);
CREATE INDEX idx_instruments_venue ON instruments(venue);

INSERT OR IGNORE INTO brokers (id, name, adapter, enabled, created_at)
VALUES ('crypto', 'Crypto exchanges via CCXT (100+ venues)', 'implemented', 1, 0);

INSERT OR IGNORE INTO accounts (id, user_id, broker_id, broker_client_id, label, trading_mode, status, created_at, updated_at)
VALUES ('crypto_demo', 'owner', 'paper', 'crypto-demo', 'Crypto Demo (virtual USDT, live exchange data)', 'PAPER', 'ACTIVE', 0, 0);
INSERT OR IGNORE INTO accounts (id, user_id, broker_id, broker_client_id, label, trading_mode, status, created_at, updated_at)
VALUES ('crypto_real', 'owner', 'crypto', NULL, 'Crypto Real (exchange = gateway CRYPTO_EXCHANGE)', 'SAFE_MODE', 'ACTIVE', 0, 0);
