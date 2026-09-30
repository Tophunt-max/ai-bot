import { describe, expect, it } from "vitest";
import type { Instrument, RiskState } from "@atb/shared-types";
import {
  CRYPTO_SESSION,
  DEFAULT_LIMITS,
  PaperBroker,
  SlidingWindowLimiter,
  assertTransition,
  calculatePositionSize,
  canOpenNewPosition,
  canTransition,
  clientOrderIdFor,
  estimateCosts,
  evaluateTrade,
  protectedLimitPrice,
  sessionPhase,
  type RiskContext,
  type TradeProposal,
} from "../src/index";

const reliance: Instrument = {
  id: "NSE:RELIANCE",
  exchange: "NSE",
  tradingSymbol: "RELIANCE",
  instrumentType: "EQ",
  lotSize: 1,
  tickSize: 0.05,
};

// 2026-10-01 is a Thursday. 10:00 IST = 04:30 UTC.
const THU_10_IST = Date.UTC(2026, 9, 1, 4, 30);

const baseState: RiskState = {
  equity: 1_000_000,
  peakEquity: 1_000_000,
  dailyRealisedPnl: 0,
  weeklyRealisedPnl: 0,
  openRisk: 0,
  openPositions: 0,
  tradingLocked: false,
  updatedAt: THU_10_IST,
};

const ctx = (over: Partial<RiskContext> = {}): RiskContext => ({
  mode: "PAPER",
  killSwitchActive: false,
  sessionAllowsEntry: true,
  now: THU_10_IST,
  lastMarketDataAt: THU_10_IST - 1_000,
  maxDataStalenessMs: 5_000,
  limits: DEFAULT_LIMITS,
  state: baseState,
  availableMargin: 1_000_000,
  marginPerUnit: 1500,
  symbolExposure: 0,
  correlatedExposure: 0,
  grossExposure: 0,
  minRewardRisk: 1.5,
  maxStopDistancePct: 5,
  ...over,
});

const longTrade: TradeProposal = {
  instrument: reliance,
  decision: "BUY",
  entry: 1500,
  stop: 1485,
  targets: [1530, 1545],
};

describe("position sizing", () => {
  it("sizes by risk: 0.5% of 10L = 5000 / 15 stop = 333", () => {
    const r = calculatePositionSize({
      equity: 1_000_000,
      riskPct: 0.5,
      entry: 1500,
      stop: 1485,
      lotSize: 1,
      maxPositionValue: 10_000_000,
      availableMargin: 10_000_000,
      marginPerUnit: 1500,
      maxExposureValue: 10_000_000,
    });
    expect(r.quantity).toBe(333);
    expect(r.limitedBy).toBe("RISK");
  });

  it("rounds down to whole lots and respects the tightest cap", () => {
    const r = calculatePositionSize({
      equity: 1_000_000,
      riskPct: 0.5,
      entry: 25000,
      stop: 24950, // risk cap 5000/50 = 100 units, margin cap 200000/2500 = 80 units
      lotSize: 75,
      maxPositionValue: 10_000_000,
      availableMargin: 200_000,
      marginPerUnit: 2500,
      maxExposureValue: 10_000_000,
    });
    expect(r.limitedBy).toBe("MARGIN");
    expect(r.quantity).toBe(75); // 80 units margin cap -> 1 lot
  });

  it("returns 0 for invalid input (zero stop distance)", () => {
    const r = calculatePositionSize({
      equity: 1_000_000,
      riskPct: 0.5,
      entry: 100,
      stop: 100,
      lotSize: 1,
      maxPositionValue: 1e7,
      availableMargin: 1e7,
      marginPerUnit: 100,
      maxExposureValue: 1e7,
    });
    expect(r.quantity).toBe(0);
    expect(r.limitedBy).toBe("INVALID");
  });
});

describe("risk gateway", () => {
  it("approves a sane trade and caps by exposure", () => {
    const r = evaluateTrade(longTrade, ctx());
    expect(r.approved).toBe(true);
    // symbol exposure cap 30% of 10L = 3L / 1500 = 200 < risk-based 333; position value cap 3L too
    expect(r.quantity).toBe(200);
  });

  it.each([
    ["KILL_SWITCH", { killSwitchActive: true }],
    ["MODE", { mode: "SAFE_MODE" as const }],
    ["SESSION", { sessionAllowsEntry: false }],
    ["DATA_FRESHNESS", { lastMarketDataAt: THU_10_IST - 60_000 }],
    ["DAILY_LOSS", { state: { ...baseState, dailyRealisedPnl: -20_000 } }],
    ["DRAWDOWN", { state: { ...baseState, equity: 890_000 } }],
    ["OPEN_POSITIONS", { state: { ...baseState, openPositions: 3 } }],
  ])("rejects on %s", (failed, over) => {
    const r = evaluateTrade(longTrade, ctx(over as Partial<RiskContext>));
    expect(r.approved).toBe(false);
    expect(r.failedCheck).toBe(failed);
    expect(r.quantity).toBe(0);
  });

  it("fails closed on NaN market data timestamp", () => {
    const r = evaluateTrade(longTrade, ctx({ lastMarketDataAt: Number.NaN }));
    expect(r.failedCheck).toBe("DATA_FRESHNESS");
  });

  it("rejects NO_TRADE / WAIT decisions", () => {
    expect(evaluateTrade({ ...longTrade, decision: "NO_TRADE" }, ctx()).failedCheck).toBe("DECISION");
  });

  it("rejects a stop on the wrong side and a poor reward/risk", () => {
    expect(evaluateTrade({ ...longTrade, stop: 1510 }, ctx()).failedCheck).toBe("STOP_LOSS");
    expect(evaluateTrade({ ...longTrade, targets: [1505] }, ctx()).failedCheck).toBe("TAKE_PROFIT");
  });
});

describe("order state machine", () => {
  it("allows the happy path and blocks illegal jumps", () => {
    expect(() => assertTransition("CREATED", "VALIDATED")).not.toThrow();
    expect(canTransition("SUBMITTED", "UNKNOWN")).toBe(true);
    expect(canTransition("FILLED", "CANCELLED")).toBe(false);
    expect(() => assertTransition("CREATED", "FILLED")).toThrow();
  });

  it("builds deterministic idempotency keys", () => {
    expect(clientOrderIdFor("sig-abc:123", "ENTRY")).toBe("sigabc123_ENTRY");
  });
});

describe("IST market hours", () => {
  it("knows open, no-new-entry, square-off and weekend", () => {
    expect(sessionPhase(THU_10_IST)).toBe("OPEN");
    expect(canOpenNewPosition(Date.UTC(2026, 9, 1, 9, 35))).toBe(false); // 15:05 IST
    expect(sessionPhase(Date.UTC(2026, 9, 1, 9, 45))).toBe("SQUARE_OFF"); // 15:15 IST
    expect(sessionPhase(Date.UTC(2026, 9, 3, 4, 30))).toBe("CLOSED"); // Saturday
    expect(sessionPhase(THU_10_IST, { ...DEFAULT_SESSION_WITH_HOLIDAY })).toBe("CLOSED");
  });
});
const DEFAULT_SESSION_WITH_HOLIDAY = {
  preOpenStart: "09:00",
  open: "09:15",
  noNewEntriesAfter: "15:00",
  squareOffAt: "15:10",
  close: "15:30",
  holidays: ["2026-10-01"],
};

describe("price protection (no MARKET orders)", () => {
  it("builds marketable limit prices on tick", () => {
    expect(protectedLimitPrice(1500, "BUY", "EQ", 0.05)).toBe(1507.5);
    expect(protectedLimitPrice(1500, "SELL", "EQ", 0.05)).toBe(1492.5);
    expect(() => protectedLimitPrice(0, "BUY", "EQ", 0.05)).toThrow();
  });
});

describe("rate limiter", () => {
  it("never exceeds N per window", () => {
    let t = 0;
    const l = new SlidingWindowLimiter(5, 1000, () => t);
    const ok = Array.from({ length: 8 }, () => l.tryAcquire()).filter(Boolean).length;
    expect(ok).toBe(5);
    t = 1000;
    expect(l.tryAcquire()).toBe(true);
  });
});

describe("costs", () => {
  it("charges STT on the sell side for intraday equity", () => {
    const buy = estimateCosts({
      side: "BUY",
      quantity: 100,
      price: 1500,
      instrumentType: "EQ",
      product: "INTRADAY",
    });
    const sell = estimateCosts({
      side: "SELL",
      quantity: 100,
      price: 1500,
      instrumentType: "EQ",
      product: "INTRADAY",
    });
    expect(buy.stt).toBe(0);
    expect(sell.stt).toBeCloseTo(37.5, 2);
    expect(buy.brokerage).toBe(20);
  });
});

describe("paper broker", () => {
  it("fills marketable limits, is idempotent, and tracks realised pnl", async () => {
    let px = 1500;
    const b = new PaperBroker({ startingCash: 1_000_000, slippageBps: 0, priceFeed: () => px });
    const buy = {
      clientOrderId: "sig1_ENTRY",
      instrument: reliance,
      side: "BUY" as const,
      quantity: 10,
      orderType: "LIMIT" as const,
      product: "INTRADAY" as const,
      price: 1505,
    };
    const r1 = await b.placeOrder(buy);
    const r2 = await b.placeOrder(buy);
    expect(r1.status).toBe("FILLED");
    expect(r2.brokerOrderId).toBe(r1.brokerOrderId);
    expect((await b.getOrders()).length).toBe(1);

    px = 1520;
    await b.placeOrder({ ...buy, clientOrderId: "sig1_EXIT", side: "SELL", price: 1515 });
    const [pos] = await b.getPositions();
    expect(pos?.quantity).toBe(0);
    expect(pos!.realisedPnl).toBeGreaterThan(150); // 200 gross minus costs
    expect(pos!.realisedPnl).toBeLessThan(200);
  });

  it("does not fill when price feed is stale", async () => {
    const b = new PaperBroker({ startingCash: 100_000, slippageBps: 0, priceFeed: () => undefined });
    const r = await b.placeOrder({
      clientOrderId: "sig2_ENTRY",
      instrument: reliance,
      side: "BUY",
      quantity: 1,
      orderType: "LIMIT",
      product: "INTRADAY",
      price: 1500,
    });
    expect(r.status).toBe("ACKNOWLEDGED");
  });
});

describe("crypto support", () => {
  const btc: Instrument = {
    id: "CRYPTO:binance:BTC/USDT",
    exchange: "CRYPTO",
    tradingSymbol: "BTCUSDT",
    instrumentType: "SPOT",
    lotSize: 0.00001,
    tickSize: 0.01,
    venue: "binance",
    venueSymbol: "BTC/USDT",
  };

  it("sizes fractional quantities on the step", () => {
    const r = calculatePositionSize({
      equity: 10_000,
      riskPct: 0.5,
      entry: 60_000,
      stop: 59_400,
      lotSize: 0.00001,
      maxPositionValue: 1e9,
      availableMargin: 1e9,
      marginPerUnit: 60_000,
      maxExposureValue: 1e9,
    });
    expect(r.quantity).toBeCloseTo(0.08333, 5); // 50 USDT risk / 600 stop
    expect(Number.isInteger(Math.round(r.quantity / 0.00001))).toBe(true);
  });

  it("24x7 session is always open (weekend, night)", () => {
    expect(sessionPhase(Date.UTC(2026, 9, 3, 20, 0), CRYPTO_SESSION)).toBe("OPEN");
  });

  it("crypto fees: taker % + GST, TDS reported separately", () => {
    const c = estimateCosts({
      side: "SELL",
      quantity: 0.1,
      price: 60_000,
      instrumentType: "SPOT",
      product: "DELIVERY",
    });
    expect(c.brokerage).toBeCloseTo(6, 4);
    expect(c.gst).toBeCloseTo(1.08, 4);
    expect(c.tds).toBeCloseTo(60, 4);
    expect(c.total).toBeCloseTo(7.08, 4);
  });

  it("blocks spot shorts and cash-delivery shorts, allows perp shorts", () => {
    const sell = {
      instrument: btc,
      decision: "SELL" as const,
      entry: 60_000,
      stop: 60_600,
      targets: [59_400, 58_500],
    };
    const c = ctx({
      product: "DELIVERY",
      state: { ...baseState, equity: 10_000, peakEquity: 10_000 },
      marginPerUnit: 60_000,
    });
    expect(evaluateTrade(sell, c).failedCheck).toBe("SHORT_NOT_ALLOWED");
    expect(
      evaluateTrade(
        { ...longTrade, decision: "SELL", stop: 1515, targets: [1485, 1470] },
        ctx({ product: "DELIVERY" }),
      ).failedCheck,
    ).toBe("SHORT_NOT_ALLOWED");
    const perp = { ...sell, instrument: { ...btc, instrumentType: "PERP" as const } };
    expect(evaluateTrade(perp, c).failedCheck).not.toBe("SHORT_NOT_ALLOWED");
  });
});
