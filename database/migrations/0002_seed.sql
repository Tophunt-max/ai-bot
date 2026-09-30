-- Reference data. Brokers mirror packages/brokers/src/registry.ts (enabled = 0 until configured).
INSERT INTO brokers (id, name, adapter, enabled, created_at) VALUES
  ('paper', 'Paper Broker (simulated)', 'implemented', 1, 0),
  ('zerodha', 'Zerodha Kite Connect', 'implemented', 0, 0),
  ('upstox', 'Upstox API v2', 'implemented', 0, 0),
  ('dhan', 'DhanHQ v2', 'implemented', 0, 0),
  ('angelone', 'Angel One SmartAPI', 'planned', 0, 0),
  ('fyers', 'Fyers API v3', 'planned', 0, 0),
  ('kotakneo', 'Kotak Neo Trade API', 'planned', 0, 0),
  ('icicidirect', 'ICICI Direct Breeze', 'planned', 0, 0),
  ('fivepaisa', '5paisa Xtream API', 'planned', 0, 0),
  ('shoonya', 'Shoonya (Finvasia) NorenAPI', 'planned', 0, 0),
  ('flattrade', 'Flattrade (Noren)', 'planned', 0, 0),
  ('zebu', 'Zebu (Noren)', 'planned', 0, 0),
  ('tradejini', 'Tradejini CubePlus', 'planned', 0, 0),
  ('aliceblue', 'Alice Blue ANT API', 'planned', 0, 0),
  ('iifl', 'IIFL Securities (XTS)', 'planned', 0, 0),
  ('groww', 'Groww Trade API', 'planned', 0, 0),
  ('motilaloswal', 'Motilal Oswal Open API', 'planned', 0, 0),
  ('paytmmoney', 'Paytm Money Open API', 'planned', 0, 0),
  ('nuvama', 'Nuvama API Connect', 'planned', 0, 0),
  ('samco', 'SAMCO Trade API', 'planned', 0, 0),
  ('mstock', 'm.Stock (Mirae Asset) Trading API', 'planned', 0, 0),
  ('definedge', 'Definedge Integrate API', 'planned', 0, 0),
  ('sharekhan', 'Sharekhan TradeSmart API', 'planned', 0, 0);

INSERT INTO strategies (id, name, enabled, updated_at) VALUES
  ('TREND_FOLLOWING', 'Trend Following', 0, 0),
  ('MOMENTUM', 'Momentum', 0, 0),
  ('BREAKOUT', 'Breakout', 0, 0),
  ('PULLBACK', 'Pullback', 0, 0),
  ('MEAN_REVERSION', 'Mean Reversion', 0, 0),
  ('VOLATILITY', 'Volatility', 0, 0),
  ('RANGE_TRADING', 'Range Trading', 0, 0);

INSERT INTO settings (key, value, updated_at) VALUES
  ('risk_limits', '{"maxRiskPerTradePct":0.5,"maxDailyLossPct":2,"maxWeeklyLossPct":4,"maxDrawdownPct":10,"maxOpenPositions":3,"maxSymbolExposurePct":30,"maxCorrelatedExposurePct":50,"maxLeverage":2,"maxPositionValue":300000,"maxOrdersPerMinute":30,"maxOrdersPerSecond":5}', 0),
  ('session', '{"preOpenStart":"09:00","open":"09:15","noNewEntriesAfter":"15:00","squareOffAt":"15:10","close":"15:30"}', 0);
