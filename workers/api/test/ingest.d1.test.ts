import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import type { Env } from "../src/env";
import { ingestEvents, signalRowId, type IngestEvent } from "../src/lib/ingest";
import { checkModelTransition } from "../src/lib/model-policy";

/** Real local D1 (SQLite via workerd) with all migrations applied: FKs, CHECKs and triggers are enforced. */
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let env: Env;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "atb-d1-"));
  execSync(`npx wrangler d1 migrations apply DB --local --persist-to ${dir}`, {
    cwd: join(__dirname, ".."),
    env: { ...process.env, CI: "1" },
    stdio: "pipe",
  });
  proxy = await getPlatformProxy<Env>({
    configPath: join(__dirname, "..", "wrangler.toml"),
    persist: { path: join(dir, "v3") },
  });
  env = proxy.env;
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
});

const t0 = Date.UTC(2026, 9, 1, 4, 30);
const signal = {
  id: "NSE:INFY:1790000000000",
  instrumentId: "NSE:INFY",
  decision: "BUY",
  regime: "STRONG_BULL",
  quality: 0.72,
  entry: 1500,
  stop: 1485,
  targets: [1515, 1530, 1552],
  strategiesAgreeing: 2,
  strategiesTotal: 7,
  modelVersion: "rules-ensemble-1.0.0",
  reasons: { trend: "up" },
  riskDecision: "APPROVED",
};

const events: IngestEvent[] = [
  { id: signalRowId("demo", signal.id, "PAPER"), type: "SIGNAL", at: t0, mode: "PAPER", payload: signal },
  {
    id: "ord-1",
    type: "ORDER",
    at: t0 + 1,
    mode: "PAPER",
    payload: {
      clientOrderId: "k1_ENTRY",
      leg: "ENTRY",
      side: "BUY",
      qty: 10,
      price: 1507.5,
      instrumentId: "NSE:INFY",
      signalId: signal.id,
      result: { filledQty: 10, avgPrice: 1500.4 },
    },
  },
  {
    id: "open-k1",
    type: "TRADE_OPENED",
    at: t0 + 2,
    mode: "PAPER",
    payload: {
      key: "k1",
      instrumentId: "NSE:INFY",
      side: "BUY",
      qty: 10,
      entry: 1500.4,
      stop: 1485,
      targets: signal.targets,
      strategy: "PULLBACK",
      regime: "STRONG_BULL",
    },
  },
  {
    id: "close-k1",
    type: "TRADE_CLOSED",
    at: t0 + 3,
    mode: "PAPER",
    payload: {
      key: "k1",
      instrumentId: "NSE:INFY",
      strategy: "PULLBACK",
      regime: "STRONG_BULL",
      side: "BUY",
      qty: 10,
      entry: 1500.4,
      exit: 1515,
      stop: 1485,
      targets: signal.targets,
      riskAmount: 154,
      quality: 0.72,
      fees: 42,
      slippage: 4,
      grossPnl: 146,
      pnl: 104,
      rMultiple: 0.675,
      mfe: 160,
      mae: -30,
      holdingTimeMs: 900000,
      openedAt: t0 + 2,
      closedAt: t0 + 3,
      modelVersion: "rules-ensemble-1.0.0",
      signalId: signal.id,
      exitReason: "TP1",
    },
  },
  {
    id: "risk-1",
    type: "RISK_EVENT",
    at: t0 + 4,
    mode: "PAPER",
    payload: { type: "KILL_SWITCH", trigger: "ABNORMAL_SLIPPAGE", severity: "CRITICAL", reason: "test" },
  },
];

describe("gateway event ingestion (real D1)", () => {
  it("journals signal → order → position → trade → risk event with FKs intact", async () => {
    const r = await ingestEvents(env, "demo", "test-node", events);
    expect(r.inserted).toBe(5);
    expect(r.notifications.map((n) => n.event)).toEqual([
      "NEW_SIGNAL",
      "TRADE_OPENED",
      "TP_HIT",
      "KILL_SWITCH",
    ]);

    const trade = await env.DB.prepare("SELECT * FROM trades WHERE id = 'demo:k1'").first<
      Record<string, unknown>
    >();
    expect(trade).toMatchObject({
      strategy: "PULLBACK",
      pnl: 104,
      r_multiple: 0.675,
      signal_id: signalRowId("demo", signal.id, "PAPER"),
      position_id: "demo:k1",
      exit_reason: "TP1",
    });
    const pos = await env.DB.prepare("SELECT status, quantity FROM positions WHERE id = 'demo:k1'").first();
    expect(pos).toEqual({ status: "CLOSED", quantity: 0 });
    const order = await env.DB.prepare(
      "SELECT status, signal_id FROM orders WHERE client_order_id = 'k1_ENTRY'",
    ).first();
    expect(order).toEqual({ status: "FILLED", signal_id: signalRowId("demo", signal.id, "PAPER") });
  });

  it("is idempotent (at-least-once delivery from the gateway)", async () => {
    const r = await ingestEvents(env, "demo", "test-node", events);
    expect(r.inserted).toBe(0);
    expect(r.duplicates).toBe(5);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM trades").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("keeps DEMO and REAL books separate (same gateway ids do not collide)", async () => {
    const r = await ingestEvents(
      env,
      "real",
      "test-node",
      events.map((e) => ({ ...e, mode: "SHADOW" })),
    );
    expect(r.inserted).toBe(5);
    expect(r.notifications[0]!.message).toContain("REAL");
    const rows = await env.DB.prepare(
      "SELECT account_id, COUNT(*) AS n FROM trades GROUP BY account_id ORDER BY account_id",
    ).all();
    expect(rows.results).toEqual([
      { account_id: "demo", n: 1 },
      { account_id: "real", n: 1 },
    ]);
  });

  it("audit log is append-only", async () => {
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, actor, action, created_at) VALUES ('a1','t','x',1)",
    ).run();
    await expect(env.DB.prepare("DELETE FROM audit_logs").run()).rejects.toThrow(/append-only/);
  });
});

describe("model promotion policy", () => {
  it("never skips stages and never jumps to PRODUCTION", () => {
    expect(checkModelTransition("DRAFT", "PRODUCTION")).toMatch(/one stage/);
    expect(checkModelTransition("SHADOW", "CANARY")).toBeNull();
    expect(checkModelTransition("CANARY", "PRODUCTION")).toBeNull();
    expect(checkModelTransition("PRODUCTION", "PAPER")).toBeNull();
    expect(checkModelTransition("RETIRED", "DRAFT")).toMatch(/retired/);
  });
});
