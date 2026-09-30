import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayProvider, TIMEFRAME_MS, syntheticSession } from "@atb/engine";
import type { Instrument, TradingMode } from "@atb/shared-types";
import { DEFAULT_LIMITS, PaperBroker, toIst } from "@atb/trading-core";
import type { ControlPlane, GatewayEvent } from "../src/control-plane";
import { TradingEngine, type PersistedState } from "../src/engine";
import { OrderExecutor } from "../src/executor";
import { EventReporter } from "../src/reporter";
import { StateStore } from "../src/state-store";
import { BrokerVenue, SimVenue } from "../src/venue";

const inst: Instrument = {
  id: "NSE:SYN",
  exchange: "NSE",
  tradingSymbol: "SYN",
  instrumentType: "EQ",
  lotSize: 1,
  tickSize: 0.05,
};
const candles = syntheticSession({ days: 45, seed: 11 });
const TF = TIMEFRAME_MS["5m"];

function setup(
  opts: { mode?: TradingMode; killSwitch?: boolean; aiEnabled?: boolean; stateFile?: string } = {},
) {
  let clock = candles[0]!.t;
  const ref: { engine?: TradingEngine } = {};
  const paper = new PaperBroker({
    startingCash: 1_000_000,
    slippageBps: 2,
    priceFeed: (id) => ref.engine?.quotes.get(id)?.ltp,
    now: () => clock,
  });
  const events: GatewayEvent[] = [];
  const killSwitches: string[] = [];
  const recon: unknown[] = [];
  const cp: ControlPlane = {
    heartbeat: async () => ({
      leaseGranted: true,
      mode: opts.mode ?? "PAPER",
      tradingEnabled: !opts.killSwitch,
      killSwitch: { active: !!opts.killSwitch },
      limits: DEFAULT_LIMITS,
    }),
    postEvents: async (_n, e) => void events.push(...e),
    reconciliation: async (s) => void recon.push(s),
    killSwitch: async (t) => void killSwitches.push(t),
  };
  const executor = new OrderExecutor({
    nodeId: "test-1",
    paperBroker: paper,
    liveBroker: paper,
    controlPlane: cp,
    checkEgress: async () => ({ ip: "1.1.1.1", ok: true, checkedAt: 0 }),
    maxOrdersPerSecond: 8,
  });
  const reporter = new EventReporter("test-1", cp, 100_000, () => clock);
  const engine = new TradingEngine(
    { instruments: [inst], aiEnabled: opts.aiEnabled ?? false, maxDataStalenessMs: TF },
    {
      executor,
      venues: {
        sim: new SimVenue(2),
        paper: new BrokerVenue(executor, "paper", { fillTimeoutMs: 0, pollMs: 0 }),
        live: new BrokerVenue(executor, "live", { fillTimeoutMs: 0, pollMs: 0 }),
      },
      provider: new ReplayProvider({}),
      reporter,
      controlPlane: cp,
      store: new StateStore<PersistedState>(opts.stateFile ?? null),
      ai: opts.aiEnabled ? ({ meta: async () => null } as never) : undefined,
      paperBroker: paper,
      now: () => clock,
    },
  );
  ref.engine = engine;

  async function replay(n = candles.length) {
    const hb = await executor.heartbeat();
    engine.applyControl(hb);
    await engine.reconcile();
    let k = 0;
    for (const c of candles.slice(0, n)) {
      clock = c.t + TF;
      await engine.onCandle(inst.id, c);
      // keep heartbeat fresh for the executor's wall-clock staleness gate
      if (++k % 200 === 0) engine.applyControl(await executor.heartbeat());
    }
    await engine.reconcile();
    await reporter.flush(1000);
  }
  return {
    engine,
    paper,
    events,
    killSwitches,
    recon,
    replay,
    executor,
    setClock: (t: number) => (clock = t),
  };
}

const count = (ev: GatewayEvent[], t: string) => ev.filter((e) => e.type === t).length;

describe("TradingEngine (PAPER via paper broker — same path as LIVE)", { timeout: 60_000 }, () => {
  it("opens trades with broker-resident stops, closes them, and reconciles flat", async () => {
    const s = setup();
    await s.replay();
    const opened = count(s.events, "TRADE_OPENED");
    const closed = count(s.events, "TRADE_CLOSED");
    expect(opened).toBeGreaterThan(3);
    expect(closed).toBe(opened - s.engine.open.size);

    const orders = await s.paper.getOrders();
    const stops = orders.filter((o) => o.orderType === "SL_LIMIT");
    expect(stops.length).toBeGreaterThanOrEqual(opened); // every entry got a protective stop
    const positions = await s.paper.getPositions();
    const net = positions.find((p) => p.instrumentId === inst.id)?.quantity ?? 0;
    const engineQty = [...s.engine.open.values()].reduce(
      (q, t) => q + (t.trade.side === "BUY" ? 1 : -1) * t.trade.qty,
      0,
    );
    expect(net).toBe(engineQty); // broker and engine agree
    expect(s.killSwitches).toEqual([]);
    expect(s.recon.length).toBeGreaterThan(0);

    const closedP = s.events.filter((e) => e.type === "TRADE_CLOSED").map((e) => e.payload);
    // Intraday: every trade closes the same IST day; R-multiples stay in a sane range.
    for (const p of closedP) {
      expect(toIst(p.openedAt as number).date).toBe(toIst((p.closedAt as number) - 1).date);
      expect(Math.abs(p.rMultiple as number)).toBeLessThan(6);
    }
    // No protective failures (MODEL_ALERT from the performance monitor is expected behaviour on random data).
    const failures = s.events.filter((e) => e.type === "RISK_EVENT" && e.payload.type !== "MODEL_ALERT");
    expect(failures).toEqual([]);
    const journal = closedP[0]!;
    for (const k of [
      "strategy",
      "regime",
      "entry",
      "exit",
      "stop",
      "qty",
      "riskAmount",
      "quality",
      "fees",
      "slippage",
      "pnl",
      "mfe",
      "mae",
      "holdingTimeMs",
      "modelVersion",
      "exitReason",
    ]) {
      expect(journal).toHaveProperty(k);
    }
  });

  it("SHADOW never sends orders but journals hypothetical trades", async () => {
    const s = setup({ mode: "SHADOW" });
    await s.replay();
    expect((await s.paper.getOrders()).length).toBe(0);
    expect(count(s.events, "TRADE_CLOSED")).toBeGreaterThan(0);
    expect(s.events.every((e) => e.mode === "SHADOW")).toBe(true);
  });

  it("kill switch: signals are rejected and no trades open", async () => {
    const s = setup({ killSwitch: true });
    await s.replay();
    expect(count(s.events, "TRADE_OPENED")).toBe(0);
    const sig = s.events.filter((e) => e.type === "SIGNAL");
    expect(sig.length).toBeGreaterThan(0);
    expect(sig.every((e) => e.payload.riskDecision === "REJECTED")).toBe(true);
  });

  it("AI enabled but unavailable → fail closed (no trades)", async () => {
    const s = setup({ aiEnabled: true });
    await s.replay();
    expect(count(s.events, "TRADE_OPENED")).toBe(0);
    expect(s.events.some((e) => e.type === "SIGNAL" && e.payload.riskFailedCheck === "AI_UNAVAILABLE")).toBe(
      true,
    );
  });

  it("persists open trades and restores them after a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "atb-")), "engine.json");
    const s = setup({ stateFile: file });
    // replay until a trade is open
    const hb = await s.executor.heartbeat();
    s.engine.applyControl(hb);
    await s.engine.reconcile();
    for (let n = 0; n < candles.length && s.engine.open.size === 0; n++) {
      s.setClock(candles[n]!.t + TF);
      await s.engine.onCandle(inst.id, candles[n]!);
    }
    expect(s.engine.open.size).toBe(1);
    const restarted = setup({ stateFile: file });
    await restarted.engine.init();
    expect([...restarted.engine.open.keys()]).toEqual([inst.id]);
  });
});
