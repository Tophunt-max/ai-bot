# AI Trading Bot V3

A personal, risk-first autonomous trading platform for Indian markets (NSE/BSE, cash and F&O).

> ⚠️ **It does not guarantee profit.** The system tries to maximise risk-adjusted returns. It
> defaults to **blocking new trades** whenever anything is uncertain: stale data, the AI or broker
> being down, an unknown order state, or an egress IP mismatch.

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

| Path                         | What                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/mobile`                | Expo SDK 57 + Expo Router, TanStack Query, Zustand, SecureStore                                          |
| `workers/api`                | Cloudflare Worker (Hono): API, 5 Durable Objects, cron, queues                                           |
| `services/execution-gateway` | Node service on the static-IP VMs: the only code that calls broker order APIs                            |
| `ai-service`                 | FastAPI inference (baseline regime model; signals default to `NO_TRADE`)                                 |
| `packages/shared-types`      | Domain types (modes, orders, risk, brokers)                                                              |
| `packages/validation`        | Zod schemas (MARKET orders rejected, lot multiples, OPS caps)                                            |
| `packages/trading-core`      | Risk gateway, sizing, order FSM, IST session, price protection, Indian costs, paper broker, HMAC signing |
| `packages/brokers`           | Adapters + registry for 22 Indian brokers                                                                |
| `packages/api-client`        | Typed API client used by the app                                                                         |
| `database/migrations`        | D1 schema + seed (audit log is append-only via triggers)                                                 |
| `database/timescale`         | Historical market-data schema (TimescaleDB)                                                              |
| `infrastructure`             | Terraform (Azure + DO), cloud-init hardening, prod docker compose                                        |

## Brokers

| Status                                                               | Brokers                                                                                                                                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented (unit-tested against mocked APIs; verify live in CANARY) | Paper, Zerodha Kite Connect, Upstox v2, DhanHQ v2                                                                                                                                                   |
| Registered, adapter planned (they fail closed until implemented)     | Angel One, Fyers, Kotak Neo, ICICI Breeze, 5paisa, Shoonya / Flattrade / Zebu (Noren), Tradejini, Alice Blue, IIFL, Groww, Motilal Oswal, Paytm Money, Nuvama, SAMCO, m.Stock, Definedge, Sharekhan |

## Quick start (development: PAPER mode only)

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

**Phase 1 (foundation) is complete.** The next phases are D1 data layer → market data → features →
strategies → backtesting (see the V3 plan). See [docs/static-ip-setup.md](docs/static-ip-setup.md)
before going beyond PAPER.
