import { describe, expect, it } from "vitest";
import { BROKER_IDS, type Instrument, type OrderRequest } from "@atb/shared-types";
import { BrokerError } from "@atb/trading-core";
import {
  BROKERS,
  DhanAdapter,
  NotImplementedAdapter,
  UpstoxAdapter,
  ZerodhaAdapter,
  createBroker,
  mapDhanStatus,
  mapKiteStatus,
  shortTag,
  type FetchLike,
} from "../src/index";

const inst: Instrument = {
  id: "NSE:INFY",
  exchange: "NSE",
  tradingSymbol: "INFY",
  instrumentType: "EQ",
  lotSize: 1,
  tickSize: 0.05,
  brokerTokens: { dhan: "1594", upstox: "NSE_EQ|INE009A01021" },
};
const order: OrderRequest = {
  clientOrderId: "sigINFY001_ENTRY",
  instrument: inst,
  side: "BUY",
  quantity: 5,
  orderType: "LIMIT",
  product: "INTRADAY",
  price: 1500,
};

type Call = { url: string; init?: RequestInit };
function mockFetch(routes: Array<(c: Call) => Response | undefined>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    for (const r of routes) {
      const res = r(c);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  };
  return { fetch, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe("registry", () => {
  it("covers every BrokerId", () => {
    for (const id of BROKER_IDS) expect(BROKERS[id]?.id).toBe(id);
  });

  it("unimplemented brokers fail closed", async () => {
    const b = createBroker("angelone", {});
    expect(b).toBeInstanceOf(NotImplementedAdapter);
    await expect(b.placeOrder(order)).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    expect(await b.isSessionValid()).toBe(false);
  });

  it("missing credentials are rejected", () => {
    expect(() => createBroker("zerodha", {})).toThrow(BrokerError);
  });
});

describe("zerodha", () => {
  it("places a LIMIT order with deterministic tag and auth header", async () => {
    const { fetch, calls } = mockFetch([
      (c) =>
        c.url.endsWith("/orders") && c.init?.method === "GET"
          ? json({ status: "success", data: [] })
          : undefined,
      (c) =>
        c.url.endsWith("/orders/regular")
          ? json({ status: "success", data: { order_id: "2410010001" } })
          : undefined,
    ]);
    const z = new ZerodhaAdapter({ apiKey: "k", accessToken: "t", fetch });
    const r = await z.placeOrder(order);
    expect(r.brokerOrderId).toBe("2410010001");
    const post = calls[1]!;
    expect((post.init?.headers as Record<string, string>).Authorization).toBe("token k:t");
    const body = new URLSearchParams(String(post.init?.body));
    expect(body.get("order_type")).toBe("LIMIT");
    expect(body.get("product")).toBe("MIS");
    expect(body.get("tag")).toBe(await shortTag(order.clientOrderId));
    expect(body.get("tag")!.length).toBeLessThanOrEqual(20);
  });

  it("is idempotent: returns the existing order if the tag already exists", async () => {
    const tag = await shortTag(order.clientOrderId);
    const { fetch, calls } = mockFetch([
      (c) =>
        c.url.endsWith("/orders")
          ? json({
              status: "success",
              data: [
                {
                  order_id: "X1",
                  tag,
                  status: "COMPLETE",
                  exchange: "NSE",
                  tradingsymbol: "INFY",
                  transaction_type: "BUY",
                  order_type: "LIMIT",
                  product: "MIS",
                  quantity: 5,
                  filled_quantity: 5,
                  average_price: 1499,
                  price: 1500,
                  trigger_price: 0,
                },
              ],
            })
          : undefined,
    ]);
    const z = new ZerodhaAdapter({ apiKey: "k", accessToken: "t", fetch });
    const r = await z.placeOrder(order);
    expect(r.status).toBe("FILLED");
    expect(calls).toHaveLength(1);
  });

  it("maps a network failure on order placement to UNKNOWN_STATE (never assume)", async () => {
    const fetch: FetchLike = async (url, init) => {
      if (init?.method === "POST") throw new Error("ECONNRESET");
      return json({ status: "success", data: [] });
    };
    const z = new ZerodhaAdapter({ apiKey: "k", accessToken: "t", fetch });
    await expect(z.placeOrder(order)).rejects.toMatchObject({ code: "UNKNOWN_STATE" });
  });

  it("maps TokenException to AUTH and session invalid", async () => {
    const { fetch } = mockFetch([
      () => json({ status: "error", error_type: "TokenException", message: "x" }, 403),
    ]);
    const z = new ZerodhaAdapter({ apiKey: "k", accessToken: "t", fetch });
    expect(await z.isSessionValid()).toBe(false);
  });

  it("maps statuses", () => {
    expect(mapKiteStatus("COMPLETE", 5)).toBe("FILLED");
    expect(mapKiteStatus("OPEN", 2)).toBe("PARTIALLY_FILLED");
    expect(mapKiteStatus("WEIRD", 0)).toBe("UNKNOWN");
  });
});

describe("dhan", () => {
  it("uses correlationId lookup before placing, then places", async () => {
    const { fetch, calls } = mockFetch([
      (c) => (c.url.includes("/orders/external/") ? json({ errorMessage: "not found" }, 404) : undefined),
      (c) =>
        c.url.endsWith("/orders") && c.init?.method === "POST"
          ? json({ orderId: "D1", orderStatus: "TRANSIT" })
          : undefined,
    ]);
    const d = new DhanAdapter({ clientId: "C", accessToken: "T", fetch });
    const r = await d.placeOrder(order);
    expect(r.brokerOrderId).toBe("D1");
    expect(r.status).toBe("SUBMITTED");
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(body.exchangeSegment).toBe("NSE_EQ");
    expect(body.securityId).toBe("1594");
    expect(body.orderType).toBe("LIMIT");
  });

  it("maps statuses", () => {
    expect(mapDhanStatus("TRADED", 5)).toBe("FILLED");
    expect(mapDhanStatus("PENDING", 0)).toBe("ACKNOWLEDGED");
  });
});

describe("upstox", () => {
  it("requires an instrument token and places LIMIT orders", async () => {
    const { fetch, calls } = mockFetch([
      (c) => (c.url.endsWith("/order/retrieve-all") ? json({ status: "success", data: [] }) : undefined),
      (c) =>
        c.url.endsWith("/order/place") ? json({ status: "success", data: { order_id: "U1" } }) : undefined,
    ]);
    const u = new UpstoxAdapter({ accessToken: "T", fetch });
    const r = await u.placeOrder(order);
    expect(r.brokerOrderId).toBe("U1");
    const body = JSON.parse(String(calls[1]!.init?.body));
    expect(body.product).toBe("I");
    expect(body.instrument_token).toBe("NSE_EQ|INE009A01021");

    const noToken = { ...order, instrument: { ...inst, brokerTokens: {} } };
    await expect(u.placeOrder(noToken)).rejects.toMatchObject({ code: "REJECTED" });
  });
});

describe("quotes & history", () => {
  it("zerodha getLtp maps exchange:symbol back to instrument ids", async () => {
    const { fetch, calls } = mockFetch([
      (c) =>
        c.url.includes("/quote/ltp")
          ? json({ status: "success", data: { "NSE:INFY": { last_price: 1510.5 } } })
          : undefined,
    ]);
    const z = new ZerodhaAdapter({ apiKey: "k", accessToken: "t", fetch });
    expect(await z.getLtp([inst])).toEqual({ "NSE:INFY": 1510.5 });
    expect(calls[0]!.url).toContain("i=NSE%3AINFY");
  });

  it("zerodha historical chunks requests to the interval limit", async () => {
    const { fetch, calls } = mockFetch([
      (c) =>
        c.url.includes("/instruments/historical/")
          ? json({
              status: "success",
              data: { candles: [["2025-01-01T09:15:00+0530", 1, 2, 0.5, 1.5, 100]] },
            })
          : undefined,
    ]);
    const z = new ZerodhaAdapter({ apiKey: "k", accessToken: "t", fetch });
    const c = await z.getHistorical("408065", "5m", new Date("2025-01-01"), new Date("2025-08-01"));
    expect(calls.length).toBe(3); // 212 days / 100-day chunks
    expect(c[0]).toMatchObject({ o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });
  });

  it("dhan and upstox getLtp use broker tokens", async () => {
    const d = mockFetch([
      () => json({ data: { NSE_EQ: { "1594": { last_price: 1500 } } }, status: "success" }),
    ]);
    expect(await new DhanAdapter({ clientId: "C", accessToken: "T", fetch: d.fetch }).getLtp([inst])).toEqual(
      { "NSE:INFY": 1500 },
    );
    const u = mockFetch([
      () =>
        json({
          status: "success",
          data: { "NSE_EQ:INFY": { last_price: 1501, instrument_token: "NSE_EQ|INE009A01021" } },
        }),
    ]);
    expect(await new UpstoxAdapter({ accessToken: "T", fetch: u.fetch }).getLtp([inst])).toEqual({
      "NSE:INFY": 1501,
    });
  });
});
