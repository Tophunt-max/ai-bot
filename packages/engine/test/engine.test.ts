import { describe, expect, it } from "vitest";
import type { Candle, Instrument } from "@atb/shared-types";
import { sessionPhase, toIst } from "@atb/trading-core";
import {
  CandleAggregator,
  FeatureFrame,
  candlesToCsv,
  checkQuote,
  ema,
  evaluateEnsemble,
  onBar,
  openTrade,
  parseCandlesCsv,
  resampleCandles,
  rsi,
  runBacktest,
  runWalkForward,
  sma,
  syntheticSession,
  validateCandles,
} from "../src/index";

const inst: Instrument = {
  id: "NSE:SYN",
  exchange: "NSE",
  tradingSymbol: "SYN",
  instrumentType: "EQ",
  lotSize: 1,
  tickSize: 0.05,
};
const TF = 5 * 60_000;
const data = syntheticSession({ days: 60, seed: 11 });

describe("indicators", () => {
  it("sma/ema/rsi basics", () => {
    const x = [1, 2, 3, 4, 5, 6];
    expect(Array.from(sma(x, 3)).slice(2)).toEqual([2, 3, 4, 5]);
    expect(ema(x, 3)[2]).toBe(2);
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14)[15]).toBe(100);
  });

  it("has NO look-ahead: features at bar i are identical when future bars are removed", () => {
    const full = new FeatureFrame(data);
    for (const i of [120, 400, 1000, 2000]) {
      const truncated = new FeatureFrame(data.slice(0, i + 1));
      const a = full.vector(i);
      const b = truncated.vector(i);
      for (const k of Object.keys(a)) {
        if (Number.isNaN(a[k]!)) expect(Number.isNaN(b[k]!)).toBe(true);
        else expect(b[k]).toBeCloseTo(a[k]!, 9);
      }
    }
  });
});

describe("market data", () => {
  it("validator drops invalid/duplicate candles and reports gaps", () => {
    const c: Candle[] = [
      { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
      { t: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
      { t: TF, o: 10, h: 9, l: 11, c: 10, v: 1 },
      { t: 3 * TF, o: 10, h: 11, l: 9, c: 10.5, v: 1 },
    ];
    const r = validateCandles(c, TF);
    expect(r.clean).toHaveLength(2);
    expect(r.issues.map((x) => x.type)).toEqual(["DUPLICATE_TS", "INVALID_OHLC", "MISSING_CANDLES"]);
  });

  it("stale or wide-spread quotes are not fresh", () => {
    expect(checkQuote({ instrumentId: "x", ltp: 100, timestamp: 0 }, 10_000, 5_000).fresh).toBe(false);
    expect(checkQuote({ instrumentId: "x", ltp: 100, bid: 98, ask: 102, timestamp: 0 }, 0, 5_000).fresh).toBe(
      false,
    );
    expect(
      checkQuote({ instrumentId: "x", ltp: 100, bid: 99.95, ask: 100.05, timestamp: 0 }, 0, 5_000).fresh,
    ).toBe(true);
  });

  it("aggregates ticks into IST-aligned 5m candles", () => {
    const closed: Candle[] = [];
    const agg = new CandleAggregator(TF, (c) => closed.push(c));
    const open = Date.UTC(2026, 9, 1, 3, 45); // 09:15 IST
    agg.onTick({ instrumentId: "x", ltp: 100, timestamp: open + 1_000, qty: 10 });
    agg.onTick({ instrumentId: "x", ltp: 102, timestamp: open + 60_000, qty: 5 });
    agg.onTick({ instrumentId: "x", ltp: 99, timestamp: open + 120_000, qty: 5 });
    agg.onTick({ instrumentId: "x", ltp: 101, timestamp: open + TF + 1, qty: 1 });
    expect(closed).toEqual([{ t: open, o: 100, h: 102, l: 99, c: 99, v: 20 }]);
    const r = resampleCandles(data.slice(0, 6), 15 * 60_000);
    expect(r).toHaveLength(2);
    expect(r[0]!.o).toBe(data[0]!.o);
    expect(r[0]!.c).toBe(data[2]!.c);
  });

  it("CSV round-trips", () => {
    const back = parseCandlesCsv(candlesToCsv(data.slice(0, 10)));
    expect(back).toHaveLength(10);
    expect(back[3]!.c).toBeCloseTo(data[3]!.c, 6);
  });
});

describe("trade manager", () => {
  const mk = () =>
    openTrade({
      id: "t",
      instrumentId: "x",
      side: "BUY",
      lotSize: 1,
      qty: 10,
      entry: 100,
      stop: 98,
      targets: [102, 104, 106],
      openedAt: 0,
      intraday: true,
    });

  it("assumes stop first when a bar touches both stop and target", () => {
    const tr = mk();
    const f = onBar(tr, { t: 1, o: 100, h: 103, l: 97, c: 101, atr: 1, squareOff: false });
    expect(f).toEqual([{ reason: "STOP", qty: 10, price: 98 }]);
  });

  it("fills a gap through the stop at the open", () => {
    const tr = mk();
    expect(onBar(tr, { t: 1, o: 95, h: 96, l: 94, c: 95, atr: 1, squareOff: false })[0]).toEqual({
      reason: "STOP",
      qty: 10,
      price: 95,
    });
  });

  it("takes TP1 partial, moves stop to break-even, then exits EOD", () => {
    const tr = mk();
    const f1 = onBar(tr, { t: 1, o: 100, h: 102.5, l: 99.5, c: 102, atr: 1, squareOff: false });
    expect(f1).toEqual([{ reason: "TP1", qty: 5, price: 102 }]);
    expect(tr.stop).toBeGreaterThan(100);
    const f2 = onBar(tr, { t: 2, o: 102, h: 102.5, l: 101.5, c: 102.2, atr: 1, squareOff: true });
    expect(f2).toEqual([{ reason: "EOD", qty: 5, price: 102.2 }]);
  });
});

describe("ensemble", () => {
  it("never trades during warm-up (UNKNOWN regime)", () => {
    const f = new FeatureFrame(data.slice(0, 50));
    const r = evaluateEnsemble(f, 49, { instrumentId: inst.id, modelVersion: "t", now: 0 });
    expect(r.signal.decision).toBe("NO_TRADE");
  });

  it("fails closed when the ML filter is unavailable", () => {
    const f = new FeatureFrame(data);
    for (let i = 100; i < f.n; i++) {
      const plain = evaluateEnsemble(f, i, { instrumentId: inst.id, modelVersion: "t", now: 0 });
      if (plain.signal.decision === "BUY" || plain.signal.decision === "SELL") {
        const gated = evaluateEnsemble(
          f,
          i,
          { instrumentId: inst.id, modelVersion: "t", now: 0 },
          undefined,
          undefined,
          {
            scorer: () => null,
            minProbability: 0.5,
          },
        );
        expect(gated.signal.decision).toBe("NO_TRADE");
        expect(plain.signal.targets).toHaveLength(3);
        return;
      }
    }
    throw new Error("expected at least one candidate signal on synthetic data");
  });
});

describe("backtester", () => {
  const r = runBacktest([{ instrument: inst, candles: data }], { timeframeMs: TF });

  it("produces trades with consistent accounting (equity = capital + Σ net P&L)", () => {
    expect(r.trades.length).toBeGreaterThan(5);
    const sum = r.trades.reduce((s, t) => s + t.netPnl, 0);
    expect(r.equity.at(-1)!.equity).toBeCloseTo(1_000_000 + sum, 4);
    expect(Number.isFinite(r.metrics.sharpe)).toBe(true);
  });

  it("only opens intraday trades inside the entry window and closes them the same day", () => {
    for (const t of r.trades) {
      expect(sessionPhase(t.openedAt)).toBe("OPEN");
      expect(toIst(t.openedAt).date).toBe(toIst(t.closedAt - 1).date);
      expect(t.fees).toBeGreaterThan(0);
      expect(Math.abs(t.entry - t.stop)).toBeGreaterThan(0);
    }
  });

  it("risk per trade never exceeds the configured limit (at entry)", () => {
    for (const t of r.trades) expect(t.riskAmount).toBeLessThanOrEqual(1_000_000 * 0.006 * 1.2);
  });
});

describe("walk-forward", () => {
  it("runs rolling folds and returns an OOS verdict", () => {
    const wf = runWalkForward(
      [{ instrument: inst, candles: data }],
      { timeframeMs: TF },
      { folds: 2, minTradesPerFold: 1 },
    );
    expect(wf.folds).toHaveLength(2);
    for (const f of wf.folds) expect(f.testFrom).toBeGreaterThanOrEqual(f.trainTo);
    expect(["PASS", "FAIL"]).toContain(wf.verdict);
  });
});
