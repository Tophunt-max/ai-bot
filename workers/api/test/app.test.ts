import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { hashPassword, signRequest, verifySignedRequest } from "../src/lib/crypto";
import { ModeChangeError, checkModeChange } from "../src/lib/mode-policy";

const JWT_SECRET = "test-jwt-secret-0123456789abcdef";
const GATEWAY_HMAC_SECRET = "test-gateway-secret-0123456789";
const PASSWORD = "correct horse battery staple";

/** Minimal in-memory fakes for DO stubs and D1 (enough for route-level tests). */
function makeEnv(passwordHash: string) {
  const auditRows: unknown[][] = [];
  const accountState = {
    mode: "PAPER",
    status: "ACTIVE",
    tradingEnabled: false,
    killSwitch: { active: false } as Record<string, unknown>,
    lease: undefined as undefined | { nodeId: string; expiresAt: number },
    updatedAt: 0,
  };
  const riskSnap = {
    limits: {
      maxRiskPerTradePct: 0.5,
      maxDailyLossPct: 2,
      maxWeeklyLossPct: 4,
      maxDrawdownPct: 10,
      maxOpenPositions: 3,
      maxSymbolExposurePct: 30,
      maxCorrelatedExposurePct: 50,
      maxLeverage: 2,
      maxPositionValue: 300000,
      maxOrdersPerMinute: 30,
      maxOrdersPerSecond: 5,
    },
    state: {
      equity: 1_000_000,
      peakEquity: 1_000_000,
      dailyRealisedPnl: 0,
      weeklyRealisedPnl: 0,
      openRisk: 0,
      openPositions: 0,
      tradingLocked: false as boolean,
      lockReason: undefined as string | undefined,
      updatedAt: 0,
    },
  };
  const ns = (stub: object) => ({ idFromName: (n: string) => n, get: () => stub });
  const env = {
    ENVIRONMENT: "development",
    OWNER_EMAIL: "owner@example.com",
    GATEWAY_URL: "",
    AI_SERVICE_URL: "",
    CORS_ORIGINS: "http://localhost:8081",
    MAX_DATA_STALENESS_MS: "5000",
    JWT_SECRET,
    OWNER_PASSWORD_HASH: passwordHash,
    GATEWAY_HMAC_SECRET,
    DB: {
      prepare: () => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            auditRows.push(args);
            return { meta: { changes: 1 } };
          },
        }),
        all: async () => ({ results: [] }),
      }),
    },
    TRADING_ACCOUNT: ns({
      getState: async () => accountState,
      setMode: async (mode: string, confirmation?: string) => {
        checkModeChange("development", accountState as never, mode as never, confirmation);
        accountState.mode = mode;
        return accountState;
      },
      setKillSwitch: async (active: boolean, trigger: string, reason: string) => {
        accountState.killSwitch = { active, trigger, reason };
        if (active) accountState.mode = "SAFE_MODE";
        return accountState;
      },
      acquireLease: async (nodeId: string) => {
        accountState.lease = { nodeId, expiresAt: Date.now() + 15000 };
        return { granted: true, lease: accountState.lease };
      },
    }),
    RISK_MANAGER: ns({
      getSnapshot: async () => riskSnap,
      lock: async (reason: string) => {
        riskSnap.state.tradingLocked = true;
        riskSnap.state.lockReason = reason;
        return riskSnap;
      },
    }),
    POSITION_MANAGER: ns({ list: async () => [] }),
    ORDER_MANAGER: ns({ listOpen: async () => [] }),
    REALTIME: ns({ broadcast: async () => 0 }),
  } as unknown as Env;
  return { env, auditRows, accountState, riskSnap };
}

let hash = "";
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

async function login(app: ReturnType<typeof createApp>, env: Env): Promise<string> {
  const r = await app.request(
    "/api/v1/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: PASSWORD }),
    },
    env,
  );
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

describe("api", () => {
  it("health is public and sets secure headers + request id", async () => {
    const { env } = makeEnv(hash);
    const r = await createApp().request("/api/v1/system/health", {}, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("rejects unauthenticated access with structured error", async () => {
    const { env } = makeEnv(hash);
    const r = await createApp().request("/api/v1/portfolio", {}, env);
    expect(r.status).toBe(401);
    const b = (await r.json()) as { error: { code: string } };
    expect(b.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects wrong password and audits the failure", async () => {
    const { env, auditRows } = makeEnv(hash);
    const r = await createApp().request(
      "/api/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "owner@example.com", password: "wrong-password-123" }),
      },
      env,
    );
    expect(r.status).toBe(401);
    expect(auditRows.some((row) => row.includes("auth.login_failed"))).toBe(true);
  });

  it("validates input", async () => {
    const { env } = makeEnv(hash);
    const r = await createApp().request(
      "/api/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "x" }),
      },
      env,
    );
    expect(r.status).toBe(400);
  });

  it("logs in, reads portfolio, and blocks LIVE in development", async () => {
    const { env } = makeEnv(hash);
    const app = createApp();
    const token = await login(app, env);
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const p = await app.request("/api/v1/portfolio", { headers: auth }, env);
    expect(p.status).toBe(200);
    const summary = (await p.json()) as { mode: string; dailyLossRemaining: number };
    expect(summary.mode).toBe("PAPER");
    expect(summary.dailyLossRemaining).toBe(20000);

    const m = await app.request(
      "/api/v1/account/mode",
      {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ mode: "LIVE", confirmation: "ENABLE LIVE", reason: "try" }),
      },
      env,
    );
    expect(m.status).toBe(409);
  });

  it("kill switch forces SAFE_MODE, locks risk and is audited", async () => {
    const { env, accountState, riskSnap, auditRows } = makeEnv(hash);
    const app = createApp();
    const token = await login(app, env);
    const r = await app.request(
      "/api/v1/admin/kill-switch",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ active: true, trigger: "MANUAL", reason: "testing kill switch" }),
      },
      env,
    );
    expect(r.status).toBe(200);
    expect(accountState.mode).toBe("SAFE_MODE");
    expect(riskSnap.state.tradingLocked).toBe(true);
    expect(auditRows.some((row) => row.includes("kill_switch.activate"))).toBe(true);
  });

  it("order preview fails closed without a live market data feed", async () => {
    const { env } = makeEnv(hash);
    const app = createApp();
    const token = await login(app, env);
    const r = await app.request(
      "/api/v1/orders/preview",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          instrument: {
            id: "NSE:INFY",
            exchange: "NSE",
            tradingSymbol: "INFY",
            instrumentType: "EQ",
            lotSize: 1,
            tickSize: 0.05,
          },
          decision: "BUY",
          entry: 1500,
          stop: 1485,
          targets: [1530],
          marginPerUnit: 300,
        }),
      },
      env,
    );
    const b = (await r.json()) as { approved: boolean; failedCheck: string };
    expect(b.approved).toBe(false);
    expect(["SESSION", "DATA_FRESHNESS"]).toContain(b.failedCheck);
  });

  it("gateway heartbeat requires a valid HMAC and locks on egress IP mismatch", async () => {
    const { env, riskSnap } = makeEnv(hash);
    const app = createApp();
    const path = "/api/v1/system/gateway/heartbeat";
    const payload = JSON.stringify({
      nodeId: "azure-cin-1",
      egressIp: "1.2.3.4",
      egressIpOk: false,
      brokerSessionValid: true,
    });

    const bad = await app.request(
      path,
      { method: "POST", body: payload, headers: { "X-ATB-Timestamp": "1", "X-ATB-Signature": "x" } },
      env,
    );
    expect(bad.status).toBe(401);

    const headers = await signRequest(GATEWAY_HMAC_SECRET, "POST", path, payload);
    const ok = await app.request(
      path,
      { method: "POST", body: payload, headers: { ...headers, "Content-Type": "application/json" } },
      env,
    );
    expect(ok.status).toBe(200);
    const b = (await ok.json()) as { leaseGranted: boolean; tradingEnabled: boolean };
    expect(b.leaseGranted).toBe(true);
    expect(b.tradingEnabled).toBe(false);
    expect(riskSnap.state.lockReason).toBe("EGRESS_IP_MISMATCH");
  });
});

describe("mode policy", () => {
  const cur = { mode: "PAPER" as const, killSwitch: { active: false } };
  it("enforces environment gating and the promotion ladder", () => {
    expect(() => checkModeChange("staging", cur, "LIVE", "ENABLE LIVE")).toThrow(ModeChangeError);
    expect(() => checkModeChange("production", cur, "LIVE", "ENABLE LIVE")).toThrow(/from CANARY/);
    expect(() => checkModeChange("production", cur, "CANARY")).toThrow(/confirm/);
    expect(() => checkModeChange("production", cur, "CANARY", "ENABLE CANARY")).not.toThrow();
    expect(() =>
      checkModeChange("production", { mode: "CANARY", killSwitch: { active: true } }, "LIVE", "ENABLE LIVE"),
    ).toThrow(/kill switch/);
  });
});

describe("hmac", () => {
  it("rejects replayed/old signatures", async () => {
    const h = await signRequest("s", "POST", "/p", "{}", 1_000);
    expect(
      await verifySignedRequest("s", "POST", "/p", "{}", h["X-ATB-Timestamp"], h["X-ATB-Signature"], 1_000),
    ).toBe(true);
    expect(
      await verifySignedRequest("s", "POST", "/p", "{}", h["X-ATB-Timestamp"], h["X-ATB-Signature"], 60_000),
    ).toBe(false);
    expect(
      await verifySignedRequest("s", "POST", "/p", "{x}", h["X-ATB-Timestamp"], h["X-ATB-Signature"], 1_000),
    ).toBe(false);
  });
});
