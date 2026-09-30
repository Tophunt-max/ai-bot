# Operations runbook

## How a trade happens

```text
broker quotes (poll/WS) → 5m candle close → FeatureFrame (causal indicators, no look-ahead)
 → regime (STRONG_BULL … ABNORMAL/UNKNOWN) → 7 strategies propose → ensemble (regime weights,
   agreement, R:R ≥ 1.5; UNKNOWN/ABNORMAL/conflict ⇒ NO_TRADE/WAIT)
 → [optional AI meta-label filter — fails closed] → performance monitor (can only reduce/disable)
 → deterministic risk gateway (13 checks + sizing) → executor gates (lease, kill switch, mode,
   heartbeat, egress IP, broker session, rate limit, no UNKNOWN orders)
 → protected LIMIT entry → broker-resident SL-LIMIT stop immediately (if that fails: flatten)
 → manage each bar: TP1 50% + break-even, TP2 30%, runner trails 2.5×ATR, time exit, EOD square-off
 → journal (D1) + realtime (app) + Telegram/push
```

Paper, canary and live use the **same code path**. Paper sends orders to the paper broker, and
CANARY/LIVE send them to the real broker. SHADOW simulates fills and never sends an order.

## Demo vs Real

- **Demo Trading** runs continuously on live quotes with virtual money. Use it to watch the strategy behave in today's market without any risk.
- **Real Trading** is a separate account. It starts in SAFE_MODE, and you promote it SHADOW → CANARY → LIVE yourself.
- The app talks to one account at a time via the `X-ATB-Account: demo|real` header. The gateway signs `account` inside every control-plane request.
- A kill switch or loss limit on one account never touches the other.

## Promotion ladder

Follow these steps in order. Do not skip any of them.

1. **Backtest + walk-forward on real data.**
   ```bash
   pnpm --filter @atb/backtesting download:kite -- --token 408065 --symbol INFY --tf 5m --from 2023-01-01 --to 2026-09-01
   pnpm --filter @atb/backtesting backtest -- --csv data/INFY-5m.csv --symbol INFY --walk-forward --folds 4 --upload
   ```
   Continue only if the verdict is **PASS**: OOS expectancy above 0.05R after costs, PF above 1.15,
   Monte-Carlo p95 drawdown below 20%, and no overfitting signal.
2. **PAPER** for 1–3 months, fed by real quotes (`DATA_BROKER=zerodha|upstox|dhan`).
3. **SHADOW** in production for 2–4 weeks. Compare the hypothetical journal with the backtest.
4. **CANARY** (`ENABLE CANARY`), sized on `CANARY_CAPITAL_PCT` of equity, for 30+ trading days. Promote only if live expectancy is within range of the OOS results.
5. **LIVE** (`ENABLE LIVE`). It is reachable only from CANARY.

## Optional AI meta-label model

```bash
pnpm --filter @atb/backtesting export-dataset -- --csv data/INFY-5m.csv --symbol INFY --out ai-service/data
cd ai-service && .venv/bin/python -m app.training.train_meta --candidates data/candidates.csv --candles-dir data/candles --models-dir ../models
```

- A newly trained model is registered as **DRAFT** only. Register it in the Worker (`POST /api/v1/models`) and promote it one stage at a time.
- Serving is mode-aware: LIVE uses only PRODUCTION models, and CANARY uses CANARY or PRODUCTION models.
- Keep `AI_ENABLED=false` until a model passes OOS validation and has run in SHADOW.

## Automatic protections

| Trigger                                        | Action                                                   |
| ---------------------------------------------- | -------------------------------------------------------- |
| Daily loss ≥ limit / drawdown ≥ limit          | Risk lock (RiskManagerDO), notification at 75%           |
| Position mismatch engine vs broker (2 checks)  | Kill switch `POSITION_MISMATCH`                          |
| No fresh quotes for 60s in session             | Kill switch `MARKET_DATA_FAILURE`                        |
| 3 consecutive broker errors                    | Kill switch `BROKER_FAILURE`                             |
| Entry slippage > 50 bps twice                  | Kill switch `ABNORMAL_SLIPPAGE`                          |
| Signal-rate explosion                          | Kill switch `MODEL_ANOMALY`                              |
| 8 losses in a row / rolling expectancy < −0.5R | Performance monitor disables entries                     |
| Rolling expectancy < −0.2R                     | Risk per trade halved                                    |
| Gateway heartbeat lost                         | Cron locks trading, notification                         |
| Order call timeout                             | Order `UNKNOWN`, all new orders blocked until reconciled |
| Egress IP not whitelisted (CANARY/LIVE)        | Risk lock `EGRESS_IP_MISMATCH`                           |

A kill switch forces SAFE_MODE. Protective actions (stops, exits, EOD square-off) keep working
while it is active. To recover:

1. Find the cause (audit log, risk events).
2. Reset the kill switch.
3. Change the mode explicitly.
4. Re-enable trading.

## Daily routine

1. Around 08:30 IST, complete the broker daily login (Kite and Upstox tokens expire every day) and update the token on the gateway.
2. Check the Dashboard. The gateway, market data and broker session indicators should all be green.
3. After 15:30 IST, check the trade journal against the broker contract note.
