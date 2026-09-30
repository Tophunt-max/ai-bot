import { describe, expect, it, vi } from "vitest";
import type { Instrument } from "@atb/shared-types";
import { BrokerError, DEFAULT_LIMITS, PaperBroker, signRequest, type BrokerAdapter } from "@atb/trading-core";
import type { ControlPlane, HeartbeatResponse } from "../src/control-plane";
import { checkEgressIp } from "../src/egress";
import { OrderExecutor } from "../src/executor";
import { createGatewayApp } from "../src/server";

const inst: Instrument = {
  id: "NSE:INFY",
  exchange: "NSE",
  tradingSymbol: "INFY",
  instrumentType: "EQ",
  lotSize: 1,
  tickSize: 0.05,
};
const order = (id = "sigINFY0001_ENTRY") => ({
  clientOrderId: id,
  instrument: inst,
  side: "BUY",
  quantity: 1,
  orderType: "LIMIT",
  product: "INTRADAY",
  price: 1500,
});

function setup(hb: Partial<HeartbeatResponse> = {}, egressOk = true, live?: BrokerAdapter) {
  let t = 1_000_000;
  const now = () => t;
  const paper = new PaperBroker({ startingCash: 100_000, slippageBps: 0, priceFeed: () => 1499, now });
  const liveBroker =
    live ?? new PaperBroker({ startingCash: 100_000, slippageBps: 0, priceFeed: () => 1499, now });
  const cp: ControlPlane = {
    heartbeat: vi.fn(async () => ({
      leaseGranted: true,
      mode: "PAPER",
      tradingEnabled: true,
      killSwitch: { active: false },
      limits: DEFAULT_LIMITS,
      ...hb,
    })) as ControlPlane["heartbeat"],
  };
  const ex = new OrderExecutor({
    nodeId: "azure-cin-1",
    paperBroker: paper,
    liveBroker,
    controlPlane: cp,
    checkEgress: async () => ({ ip: "20.0.0.1", ok: egressOk, checkedAt: t }),
    maxOrdersPerSecond: 2,
    now,
  });
  return { ex, advance: (ms: number) => (t += ms), liveBroker };
}

describe("OrderExecutor gating", () => {
  it("rejects everything before the first heartbeat (fail closed)", async () => {
    const { ex } = setup();
    const r = await ex.submit(order());
    expect(r.accepted).toBe(false);
  });

  it("executes paper orders when all gates pass, idempotently", async () => {
    const { ex } = setup();
    await ex.heartbeat();
    const a = await ex.submit(order());
    const b = await ex.submit(order());
    expect(a.accepted && a.result.status).toBe("FILLED");
    expect(b.accepted && b.result.brokerOrderId).toBe(a.accepted && a.result.brokerOrderId);
  });

  it("blocks when another node holds the lease (secondary stays standby)", async () => {
    const { ex } = setup({ leaseGranted: false, leaseHolder: "azure-cin-1" });
    await ex.heartbeat();
    const r = await ex.submit(order());
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reasons.join()).toMatch(/lease held by azure-cin-1/);
  });

  it("blocks LIVE orders when egress IP is not whitelisted", async () => {
    const { ex } = setup({ mode: "LIVE" }, false);
    await ex.heartbeat();
    const r = await ex.submit(order());
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reasons.join()).toMatch(/not whitelisted/);
  });

  it("blocks on kill switch, SAFE_MODE and stale heartbeat", async () => {
    const k = setup({ killSwitch: { active: true }, mode: "SAFE_MODE", tradingEnabled: false });
    await k.ex.heartbeat();
    expect((await k.ex.submit(order())).accepted).toBe(false);

    const s = setup();
    await s.ex.heartbeat();
    s.advance(60_000);
    const r = await s.ex.submit(order());
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reasons.join()).toMatch(/stale/);
  });

  it("SHADOW never calls the broker", async () => {
    const live = new PaperBroker({ startingCash: 1, slippageBps: 0, priceFeed: () => 1 });
    const spy = vi.spyOn(live, "placeOrder");
    const { ex } = setup({ mode: "SHADOW" }, true, live);
    await ex.heartbeat();
    const r = await ex.submit(order());
    expect(r.accepted && r.shadow).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("enforces the per-second order rate limit", async () => {
    const { ex } = setup();
    await ex.heartbeat();
    const results = await Promise.all([1, 2, 3].map((i) => ex.submit(order(`sigRATE000${i}_ENTRY`))));
    expect(results.filter((r) => r.accepted)).toHaveLength(2);
  });

  it("UNKNOWN_STATE blocks all further orders until reconciled", async () => {
    const live = new PaperBroker({ startingCash: 1e6, slippageBps: 0, priceFeed: () => 1499 });
    vi.spyOn(live, "placeOrder").mockRejectedValueOnce(new BrokerError("timeout", "UNKNOWN_STATE"));
    const { ex } = setup({ mode: "CANARY" }, true, live);
    await ex.heartbeat();
    const r1 = await ex.submit(order("sigUNK00001_ENTRY"));
    expect(r1.accepted).toBe(false);
    const r2 = await ex.submit(order("sigUNK00002_ENTRY"));
    expect(r2.accepted).toBe(false);
    if (!r2.accepted) expect(r2.reasons.join()).toMatch(/UNKNOWN/);
    const rec = await ex.reconcileUnknown();
    expect(rec.stillUnknown).toEqual(["sigUNK00001_ENTRY"]); // not in broker book => still blocked
  });

  it("rejects MARKET orders at the schema level", async () => {
    const { ex } = setup();
    await ex.heartbeat();
    const r = await ex.submit({ ...order(), orderType: "MARKET" });
    expect(r.accepted).toBe(false);
  });
});

describe("egress check", () => {
  it("passes only for whitelisted IPs and fails closed on errors", async () => {
    const ok = await checkEgressIp(["20.0.0.1"], "https://x", async () => new Response("20.0.0.1\n"));
    expect(ok.ok).toBe(true);
    const bad = await checkEgressIp(["20.0.0.1"], "https://x", async () => new Response("9.9.9.9"));
    expect(bad.ok).toBe(false);
    const err = await checkEgressIp(["20.0.0.1"], "https://x", async () => {
      throw new Error("dns");
    });
    expect(err.ok).toBe(false);
  });
});

describe("gateway HTTP", () => {
  it("requires HMAC for order submission; health is open", async () => {
    const { ex } = setup();
    await ex.heartbeat();
    const app = createGatewayApp(ex, "s".repeat(32));
    expect((await app.request("/health")).status).toBe(200);
    const body = JSON.stringify(order());
    expect((await app.request("/v1/orders", { method: "POST", body })).status).toBe(401);
    const headers = await signRequest("s".repeat(32), "POST", "/v1/orders", body);
    const r = await app.request("/v1/orders", {
      method: "POST",
      body,
      headers: { ...headers, "Content-Type": "application/json" },
    });
    expect(r.status).toBe(200);
  });
});
