-- TimescaleDB schema for historical market data (NOT in D1).
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS candles (
  instrument_id TEXT        NOT NULL,
  timeframe     TEXT        NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,           -- candle open time
  open          DOUBLE PRECISION NOT NULL,
  high          DOUBLE PRECISION NOT NULL,
  low           DOUBLE PRECISION NOT NULL,
  close         DOUBLE PRECISION NOT NULL,
  volume        DOUBLE PRECISION NOT NULL DEFAULT 0,
  oi            DOUBLE PRECISION,
  source        TEXT        NOT NULL,           -- broker/vendor id
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (instrument_id, timeframe, ts),
  CHECK (low <= LEAST(open, close) AND high >= GREATEST(open, close) AND low > 0)
);
SELECT create_hypertable('candles', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '7 days');

CREATE TABLE IF NOT EXISTS ticks (
  instrument_id TEXT        NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  ltp           DOUBLE PRECISION NOT NULL CHECK (ltp > 0),
  qty           DOUBLE PRECISION,
  bid           DOUBLE PRECISION,
  ask           DOUBLE PRECISION,
  source        TEXT        NOT NULL
);
SELECT create_hypertable('ticks', 'ts', if_not_exists => TRUE, chunk_time_interval => INTERVAL '1 day');
CREATE INDEX IF NOT EXISTS ticks_instrument_ts ON ticks (instrument_id, ts DESC);

-- Corporate actions for point-in-time price adjustment (avoid look-ahead in backtests).
CREATE TABLE IF NOT EXISTS corporate_actions (
  instrument_id TEXT NOT NULL,
  ex_date       DATE NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('SPLIT','BONUS','DIVIDEND','RIGHTS','MERGER','DELISTING')),
  ratio         DOUBLE PRECISION,
  amount        DOUBLE PRECISION,
  PRIMARY KEY (instrument_id, ex_date, action)
);

-- Point-in-time index membership (survivorship-bias protection).
CREATE TABLE IF NOT EXISTS index_membership (
  index_id      TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  valid_from    DATE NOT NULL,
  valid_to      DATE,
  PRIMARY KEY (index_id, instrument_id, valid_from)
);
