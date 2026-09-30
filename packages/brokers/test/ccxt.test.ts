import * as ccxt from "ccxt";
import { describe, expect, it } from "vitest";
import type { Instrument, OrderRequest } from "@atb/shared-types";
import {
  CRYPTO_EXCHANGES,
  CcxtAdapter,
  isSupportedCryptoExchange,
  mapCcxtError,
  shortTag,
  stepFrom,
  type CcxtOrder,
  type ExchangeLike,
} from "../src/index";

const btc: Instrument = {
  id: "CRYPTO:binance:BTC/USDT",
  exchange: "CRYPTO",
  tradingSymbol: "BTCUSDT",
  instrumentType: "SPOT",
  lotSize: 0.00001,
  tickSize: 0.01,
  venue: "binance",
  venueSymbol: "BTC/USDT",
  quoteCurrency: "USDT",
};

function fakeExchange() {
  const orders: CcxtOrder[] = [];
  let seq = 0;
  const calls: string[] = [];
  const ex: ExchangeLike = {
    id: "binance",
    has: { fetchTickers: true, fetchOHLCV: true, fetchOrders: true, editOrder: false },
    precisionMode: 4,
    markets: {
      "BTC/USDT": {
        symbol: "BTC/USDT",
        base: "BTC",
        quote: "USDT",
        spot: true,
        precision: { amount: 0.00001, price: 0.01 },
        limits: { amount: { min: 0.00001 }, cost: { min: 5 } },
      },
    },
    loadMarkets: async () => ex.markets!,
    fetchBalance: async () => ({
      free: { USDT: 900 },
      used: { USDT: 100 },
      total: { USDT: 1000, BTC: 0.002 },
    }),
    fetchTickers: async () => ({ "BTC/USDT": { last: 60_000 } }),
    fetchTicker: async () => ({ last: 60_000 }),
    fetchOHLCV: async (_s, _tf, since = 0) =>
      since > 1_000_000
        ? []
        : [
            [since, 1, 2, 0.5, 1.5, 10],
            [since + 300_000, 1.5, 2.5, 1, 2, 12],
          ],
    fetchOpenOrders: async () => orders.filter((o) => o.status === "open"),
    fetchOrders: async () => orders,
    createOrder: async (symbol, type, side, amount, price, params) => {
      calls.push(`create ${type} ${side} ${amount} @${price} ${JSON.stringify(params)}`);
      const o: CcxtOrder = {
        id: `X${++seq}`,
        clientOrderId: (params as { clientOrderId: string }).clientOrderId,
        symbol,
        side: side as "buy",
        amount,
        price,
        status: "open",
        filled: 0,
      };
      orders.push(o);
      return o;
    },
    cancelOrder: async (id) => {
      calls.push(`cancel ${id}`);
      const o = orders.find((x) => x.id === id);
      if (o) o.status = "canceled";
      return {};
    },
  };
  return { ex, orders, calls };
}

const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  clientOrderId: "sigBTC0001_ENTRY",
  instrument: btc,
  side: "BUY",
  quantity: 0.0015,
  orderType: "LIMIT",
  product: "DELIVERY",
  price: 60_100,
  ...over,
});

describe("CcxtAdapter", () => {
  it("places a LIMIT order with our deterministic clientOrderId and is idempotent", async () => {
    const f = fakeExchange();
    const a = new CcxtAdapter({
      exchangeId: "binance",
      quoteCurrency: "USDT",
      instruments: [btc],
      exchange: f.ex,
    });
    const r1 = await a.placeOrder(order());
    const r2 = await a.placeOrder(order());
    expect(r1.brokerOrderId).toBe("X1");
    expect(r2.brokerOrderId).toBe("X1");
    expect(f.calls.filter((c) => c.startsWith("create"))).toHaveLength(1);
    expect(f.calls[0]).toContain(`"clientOrderId":"${await shortTag("sigBTC0001_ENTRY")}"`);
    expect((await a.findOrder("sigBTC0001_ENTRY"))?.brokerOrderId).toBe("X1");
  });

  it("sends stop-limit via triggerPrice and replaces stops on exchanges without editOrder", async () => {
    const f = fakeExchange();
    const a = new CcxtAdapter({
      exchangeId: "binance",
      quoteCurrency: "USDT",
      instruments: [btc],
      exchange: f.ex,
    });
    const sl = await a.placeOrder(
      order({
        clientOrderId: "sigBTC0001_SL",
        side: "SELL",
        orderType: "SL_LIMIT",
        triggerPrice: 59_000,
        price: 58_700,
      }),
    );
    expect(f.calls[0]).toContain('"triggerPrice":59000');
    const moved = await a.modifyOrder(sl.brokerOrderId!, { triggerPrice: 59_500, price: 59_200 });
    expect(f.calls.some((c) => c === `cancel ${sl.brokerOrderId}`)).toBe(true);
    expect(moved.brokerOrderId).not.toBe(sl.brokerOrderId);
  });

  it("reports quote balance + spot holdings as equity, and spot positions from balances", async () => {
    const f = fakeExchange();
    const a = new CcxtAdapter({
      exchangeId: "binance",
      quoteCurrency: "USDT",
      instruments: [btc],
      exchange: f.ex,
    });
    const b = await a.getBalance();
    expect(b.totalEquity).toBeCloseTo(1000 + 0.002 * 60_000, 6);
    expect(await a.getPositions()).toEqual([
      expect.objectContaining({ instrumentId: btc.id, quantity: 0.002 }),
    ]);
    expect(await a.getLtp([btc])).toEqual({ [btc.id]: 60_000 });
  });

  it("builds instruments from market metadata and paginates OHLCV", async () => {
    const f = fakeExchange();
    const a = new CcxtAdapter({
      exchangeId: "binance",
      quoteCurrency: "USDT",
      instruments: [],
      exchange: f.ex,
    });
    const i = await a.instrumentFor("BTC/USDT");
    expect(i).toMatchObject({
      exchange: "CRYPTO",
      instrumentType: "SPOT",
      lotSize: 0.00001,
      tickSize: 0.01,
      minNotional: 5,
    });
    const c = await a.getHistorical("BTC/USDT", "5m", new Date(0), new Date(10_000_000));
    expect(c.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses instruments from another venue", async () => {
    const f = fakeExchange();
    const a = new CcxtAdapter({
      exchangeId: "binance",
      quoteCurrency: "USDT",
      instruments: [btc],
      exchange: f.ex,
    });
    await expect(a.placeOrder(order({ instrument: { ...btc, venue: "kucoin" } }))).rejects.toMatchObject({
      code: "REJECTED",
    });
  });

  it("maps CCXT errors fail-closed (network during order = UNKNOWN_STATE)", () => {
    expect(mapCcxtError(new ccxt.RequestTimeout("t"), true).code).toBe("UNKNOWN_STATE");
    expect(mapCcxtError(new ccxt.NetworkError("n"), false).code).toBe("NETWORK");
    expect(mapCcxtError(new ccxt.AuthenticationError("bad key"), false).code).toBe("AUTH");
    expect(mapCcxtError(new ccxt.InsufficientFunds("no money"), true).code).toBe("REJECTED");
    expect(mapCcxtError(new ccxt.RateLimitExceeded("slow"), false).code).toBe("RATE_LIMIT");
  });

  it("converts precision modes to steps", () => {
    expect(stepFrom(0.001, 4, 1)).toBe(0.001); // TICK_SIZE
    expect(stepFrom(3, 2, 1)).toBe(0.001); // DECIMAL_PLACES
  });
});

describe("crypto exchange registry", () => {
  it("lists every CCXT exchange plus Indian ones without CCXT", () => {
    const ids = Object.keys(ccxt.exchanges);
    expect(ids.length).toBeGreaterThan(90);
    expect(CRYPTO_EXCHANGES.length).toBeGreaterThanOrEqual(ids.length);
    for (const id of ids) expect(isSupportedCryptoExchange(id)).toBe(true);
    expect(isSupportedCryptoExchange("coindcx")).toBe(false);
    expect(CRYPTO_EXCHANGES.find((e) => e.id === "okx")?.india).toBe("EXITED_INDIA");
  });
});
