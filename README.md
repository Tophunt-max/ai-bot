# AI Trading Bot V3

A personal, risk-first autonomous trading platform for Indian markets (NSE/BSE, cash and F&O).

> ⚠️ **It does not guarantee profit.** The system tries to maximise risk-adjusted returns. It
> defaults to **blocking new trades** whenever anything is uncertain: stale data, the AI or broker
> being down, an unknown order state, or an egress IP mismatch.

## Two accounts: Demo Trading and Real Trading

|               | 🧪 **Demo Trading**                              | 💰 **Real Trading**                                 |
| ------------- | ------------------------------------------------ | --------------------------------------------------- |
| Money         | Virtual (`DEMO_STARTING_CASH`, default ₹10 lakh) | Your real broker funds                              |
| Market data   | **Real live quotes** (same feed as Real)         | Real live quotes                                    |
| Orders go to  | Built-in paper broker (never the real broker)    | Broker set by `ACTIVE_BROKER` (Zerodha/Upstox/Dhan) |
| Allowed modes | PAPER (+ SAFE_MODE)                              | SHADOW → CANARY → LIVE (+ SAFE_MODE)                |
| Starts in     | PAPER                                            | SAFE_MODE (you move it to SHADOW deliberately)      |

The two books share nothing except the price feed. Each one has its own:

- positions, orders and journal
- risk limits and drawdown
- kill switch and execution lease
- gateway engine and state file

The app has a **Demo | Real** switch on the Dashboard and Profile screens. Every screen shows a
coloured banner (blue = DEMO, red = REAL MONEY), and switching to Real asks for confirmation.
Alerts are tagged 🧪 DEMO or 💰 REAL. If `ACTIVE_BROKER=paper`, the Real book is not started at
all.

## Architecture

```text
Expo app (Android / iOS / Web)
        │  JWT (owner only) + WebSocket
        ▼
Cloudflare Workers (Hono)  ── control plane
  D1 · Durable Objects (account/mode/kill-switch/lease, risk, orders, positions, realtime)
  R2 · Queues · Cron · Rate limiting
        │  HMAC-signed, via Cloudflare Tunnel (no inbound ports)
        ▼
Execution Gateway (static IP) ── execution plane
  Primary:   Azure Central India   (azure-cin-1)
  Secondary: DigitalOcean Bangalore (do-blr-1, hot standby via execution lease)
  • egress-IP self-check • broker session • rate limit ≤ 5 OPS • LIMIT orders only
  • AI service (FastAPI) on the private Docker network — never sees broker credentials
        │
        ▼
Broker API → NSE / BSE
```

Every trade has to pass these checks, and none of them can be bypassed:
**AI → deterministic Risk Gateway (`packages/trading-core`) → Order Validator → Execution lease/egress gates → Broker**.

## Monorepo

| Path                         | What                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/mobile`                | Expo SDK 57 + Expo Router, TanStack Query, Zustand, SecureStore                                                                                                          |
| `workers/api`                | Cloudflare Worker (Hono): API, 5 Durable Objects, cron, queues                                                                                                           |
| `services/execution-gateway` | Static-IP VM service: live TradingEngine (paper/shadow/canary/live), broker-resident stops, reconciliation, auto kill-switch, the ONLY code that calls broker order APIs |
| `ai-service`                 | FastAPI: baseline regime model + optional meta-label filter (triple-barrier labels, purged walk-forward, registry, PSI drift)                                            |
| `packages/engine`            | Shared by backtest AND live: causal features, regime, 7 strategies, ensemble, trade manager, event-driven backtester, metrics, walk-forward, performance monitor         |
| `backtesting`                | CLI: Kite history download, backtest + walk-forward verdict, dataset export for AI training                                                                              |
| `packages/shared-types`      | Domain types (modes, orders, risk, brokers)                                                                                                                              |
| `packages/validation`        | Zod schemas (MARKET orders rejected, lot multiples, OPS caps)                                                                                                            |
| `packages/trading-core`      | Risk gateway, sizing, order FSM, IST session, price protection, Indian costs, paper broker, HMAC signing                                                                 |
| `packages/brokers`           | Adapters + registry for 22 Indian brokers                                                                                                                                |
| `packages/api-client`        | Typed API client used by the app                                                                                                                                         |
| `database/migrations`        | D1 schema + seed (audit log is append-only via triggers)                                                                                                                 |
| `database/timescale`         | Historical market-data schema (TimescaleDB)                                                                                                                              |
| `infrastructure`             | Terraform (Azure + DO), cloud-init hardening, prod docker compose                                                                                                        |

## Brokers

| Status                                                               | Brokers                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented (unit-tested against mocked APIs; verify live in CANARY) | Paper, Zerodha Kite Connect, Upstox v2, DhanHQ v2                                                                                                                                                   |
| Registered, adapter planned (they fail closed until implemented)     | Angel One, Fyers, Kotak Neo, ICICI Breeze, 5paisa, Shoonya / Flattrade / Zebu (Noren), Tradejini, Alice Blue, IIFL, Groww, Motilal Oswal, Paytm Money, Nuvama, SAMCO, m.Stock, Definedge, Sharekhan |

## Quick start (development: PAPER mode only)

Full operating guide: [docs/operations.md](docs/operations.md). Static IP / broker whitelisting: [docs/static-ip-setup.md](docs/static-ip-setup.md).

```bash
pnpm install
pnpm check                          # lint + typecheck + tests

# Worker API on :8787
cp workers/api/.dev.vars.example workers/api/.dev.vars   # fill in secrets (scripts/gen-secrets.sh)
pnpm --filter @atb/api run hash-password -- 'a-long-owner-password'
pnpm db:migrate:local
pnpm dev:api

# Gateway + AI service + TimescaleDB
docker compose -f docker-compose.dev.yml up --build

# App
pnpm dev:mobile                     # press w for web, or scan the QR code with Expo Go
```

```bash
# Backtest (synthetic data only proves the pipeline — use real downloaded history for decisions)
pnpm --filter @atb/backtesting backtest -- --synthetic 120 --walk-forward
pnpm --filter @atb/backtesting backtest -- --csv data/INFY-5m.csv --symbol INFY --walk-forward

# Paper simulation of the LIVE engine on history (gateway + local Worker)
REPLAY_CSV=data/INFY-5m.csv INSTRUMENTS_FILE=infrastructure/docker/instruments.example.json pnpm dev:gateway
```

AI service tests: `cd ai-service && uv venv -p 3.12 .venv && uv pip install -p .venv -e ".[dev]" && .venv/bin/pytest`.

## Safety rules the code enforces

- **Mode ladder:** development allows PAPER only, staging adds SHADOW, and production also allows
  CANARY and LIVE. LIVE is reachable only from CANARY, and switching to it needs the typed
  confirmation `ENABLE LIVE`.
- **Kill switch:** activating it forces SAFE_MODE and locks risk immediately. Resetting it does
  **not** leave SAFE_MODE; you have to change the mode yourself.
- **Risk starts locked:** trading stays locked until the first broker reconciliation arrives.
- **Order outcomes:** if an order call times out, the order becomes `UNKNOWN`. It is never retried,
  and all new orders are blocked until reconciliation resolves it.
- **Stops:** stops can only be tightened. An open position without a stop is rejected.
- **Scheduled jobs:** cron jobs are idempotent (`cron_runs` table). If the gateway heartbeat is
  lost, trading locks.

## Status

All 17 planned phases are implemented and tested (≈120 automated tests, plus an end-to-end paper
run: local Worker + D1 + gateway replay → signals, orders, trades, journal, stats, kill switch).

**What is NOT proven:** profitability. On random synthetic data the system correctly loses money
after costs, the walk-forward verdict is **FAIL**, and the performance monitor switches trading off.
That is the intended behaviour. You need real historical data, a **PASS** verdict, and months of
PAPER → SHADOW → CANARY before any LIVE capital. Zerodha, Upstox and Dhan adapters are tested
against mocked APIs, so verify each one with tiny CANARY orders. The other 19 brokers fail closed
until their adapters are written.
