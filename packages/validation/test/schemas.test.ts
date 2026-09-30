import { describe, expect, it } from "vitest";
import { orderRequestSchema, riskLimitsSchema } from "../src/index";

const nifty = {
  id: "NFO:NIFTYFUT",
  exchange: "NFO",
  tradingSymbol: "NIFTY26OCTFUT",
  instrumentType: "FUT",
  lotSize: 75,
  tickSize: 0.05,
};

describe("orderRequestSchema", () => {
  it("accepts a valid limit order", () => {
    const r = orderRequestSchema.safeParse({
      clientOrderId: "sig_12345678",
      instrument: nifty,
      side: "BUY",
      quantity: 75,
      orderType: "LIMIT",
      product: "INTRADAY",
      price: 25000,
    });
    expect(r.success).toBe(true);
  });

  it("rejects MARKET orders (not allowed for retail algos)", () => {
    const r = orderRequestSchema.safeParse({
      clientOrderId: "sig_12345678",
      instrument: nifty,
      side: "BUY",
      quantity: 75,
      orderType: "MARKET",
      product: "INTRADAY",
      price: 25000,
    });
    expect(r.success).toBe(false);
  });

  it("rejects quantity that is not a lot multiple", () => {
    const r = orderRequestSchema.safeParse({
      clientOrderId: "sig_12345678",
      instrument: nifty,
      side: "BUY",
      quantity: 50,
      orderType: "LIMIT",
      product: "INTRADAY",
      price: 25000,
    });
    expect(r.success).toBe(false);
  });

  it("requires trigger price for SL_LIMIT", () => {
    const r = orderRequestSchema.safeParse({
      clientOrderId: "sig_12345678",
      instrument: nifty,
      side: "SELL",
      quantity: 75,
      orderType: "SL_LIMIT",
      product: "INTRADAY",
      price: 24900,
    });
    expect(r.success).toBe(false);
  });
});

describe("riskLimitsSchema", () => {
  it("caps orders per second below the exchange retail threshold", () => {
    const base = {
      maxRiskPerTradePct: 0.5,
      maxDailyLossPct: 2,
      maxWeeklyLossPct: 4,
      maxDrawdownPct: 10,
      maxOpenPositions: 3,
      maxSymbolExposurePct: 30,
      maxCorrelatedExposurePct: 50,
      maxLeverage: 2,
      maxPositionValue: 500000,
      maxOrdersPerMinute: 30,
      maxOrdersPerSecond: 5,
    };
    expect(riskLimitsSchema.safeParse(base).success).toBe(true);
    expect(riskLimitsSchema.safeParse({ ...base, maxOrdersPerSecond: 10 }).success).toBe(false);
  });
});
