import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { sign } from "hono/jwt";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { listBrokers } from "@atb/brokers";
import type { DashboardSummary } from "@atb/shared-types";
import { DEFAULT_SESSION, evaluateTrade, sessionPhase, canOpenNewPosition } from "@atb/trading-core";
import {
  instrumentSchema,
  killSwitchSchema,
  loginSchema,
  modeChangeSchema,
  riskLimitsSchema,
  z,
} from "@atb/validation";
import { OWNER_ACCOUNT, type AppBindings, type Env } from "./env";
import { audit } from "./lib/audit";
import { timingSafeEqual, verifyPassword } from "./lib/crypto";
import { ModeChangeError } from "./lib/mode-policy";
import {
  apiError,
  rateLimit,
  requireAuth,
  requireGateway,
  requireOwner,
  verifyUserToken,
} from "./middleware";

const TOKEN_TTL_S = 12 * 60 * 60;

const account = (env: Env) => env.TRADING_ACCOUNT.get(env.TRADING_ACCOUNT.idFromName(OWNER_ACCOUNT));
const risk = (env: Env) => env.RISK_MANAGER.get(env.RISK_MANAGER.idFromName(OWNER_ACCOUNT));
const positions = (env: Env) => env.POSITION_MANAGER.get(env.POSITION_MANAGER.idFromName(OWNER_ACCOUNT));
const orders = (env: Env) => env.ORDER_MANAGER.get(env.ORDER_MANAGER.idFromName(OWNER_ACCOUNT));
const realtime = (env: Env) => env.REALTIME.get(env.REALTIME.idFromName(OWNER_ACCOUNT));

async function body<S extends z.ZodType>(c: Context<AppBindings>, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "invalid JSON body" });
  }
  return schema.parse(raw);
}

const actorOf = (c: Context<AppBindings>) => c.get("user")?.sub ?? "anonymous";
const ipOf = (c: Context<AppBindings>) => c.req.header("CF-Connecting-IP");

export function createApp() {
  const app = new Hono<AppBindings>();

  app.use("*", requestId());
  app.use("*", async (c, next) => {
    c.set("requestId", c.get("requestId") ?? crypto.randomUUID());
    await next();
  });
  app.use("*", secureHeaders());
  app.use("*", (c, next) =>
    cors({
      origin: (c.env.CORS_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE"],
      maxAge: 600,
    })(c, next),
  );

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return apiError(c, 400, "VALIDATION_ERROR", "invalid input", err.issues);
    if (err instanceof ModeChangeError) return apiError(c, 409, "MODE_CHANGE_REJECTED", err.message);
    if (err instanceof HTTPException) return apiError(c, err.status, "HTTP_ERROR", err.message);
    console.error(JSON.stringify({ level: "error", requestId: c.get("requestId"), err: String(err) }));
    return apiError(c, 500, "INTERNAL", "internal error");
  });
  app.notFound((c) => apiError(c, 404, "NOT_FOUND", "route not found"));

  const v1 = new Hono<AppBindings>();

  // ------------------------------------------------------------ public
  v1.get("/system/health", (c) =>
    c.json({ status: "ok", environment: c.env.ENVIRONMENT, time: Date.now(), version: "0.1.0" }),
  );

  v1.post(
    "/auth/login",
    rateLimit((c) => c.env.TRADING_RATE_LIMITER),
    async (c) => {
      const input = await body(c, loginSchema);
      const emailOk = timingSafeEqual(input.email.toLowerCase(), (c.env.OWNER_EMAIL ?? "").toLowerCase());
      const passOk = c.env.OWNER_PASSWORD_HASH
        ? await verifyPassword(input.password, c.env.OWNER_PASSWORD_HASH)
        : false;
      if (!emailOk || !passOk) {
        await audit(c.env, {
          actor: input.email,
          action: "auth.login_failed",
          ip: ipOf(c),
          requestId: c.get("requestId"),
        });
        return apiError(c, 401, "INVALID_CREDENTIALS", "invalid credentials");
      }
      const now = Math.floor(Date.now() / 1000);
      const token = await sign(
        { sub: "owner", role: "OWNER", iat: now, exp: now + TOKEN_TTL_S },
        c.env.JWT_SECRET,
        "HS256",
      );
      await audit(c.env, {
        actor: "owner",
        action: "auth.login",
        ip: ipOf(c),
        requestId: c.get("requestId"),
      });
      return c.json({ token, expiresIn: TOKEN_TTL_S });
    },
  );

  // Realtime: browsers can't set headers on WebSocket, so the token comes as a query param.
  v1.get("/system/realtime", async (c) => {
    const user = await verifyUserToken(c.req.query("token") ?? "", c.env.JWT_SECRET);
    if (!user) return apiError(c, 401, "UNAUTHENTICATED", "token required");
    return realtime(c.env).fetch(c.req.raw);
  });

  // ------------------------------------------------------------ gateway (HMAC)
  const gw = new Hono<AppBindings>();
  gw.use("*", requireGateway);

  gw.post("/heartbeat", async (c) => {
    const hb = await body(
      c,
      z.object({
        nodeId: z.string().min(3).max(40),
        egressIp: z.string().max(64),
        egressIpOk: z.boolean(),
        brokerSessionValid: z.boolean(),
        marketDataAt: z.number().optional(),
      }),
    );
    if (!hb.egressIpOk) await risk(c.env).lock("EGRESS_IP_MISMATCH");
    if (!hb.brokerSessionValid) await risk(c.env).lock("BROKER_SESSION_EXPIRED");
    const lease = await account(c.env).acquireLease(hb.nodeId);
    const state = await account(c.env).getState();
    const rs = await risk(c.env).getSnapshot();
    return c.json({
      leaseGranted: lease.granted,
      leaseHolder: lease.lease?.nodeId,
      mode: state.mode,
      tradingEnabled: state.tradingEnabled && !state.killSwitch.active && !rs.state.tradingLocked,
      killSwitch: state.killSwitch,
      limits: rs.limits,
    });
  });

  gw.post("/reconciliation", async (c) => {
    const snap = await body(
      c,
      z.object({
        equity: z.number().nonnegative(),
        dailyRealisedPnl: z.number(),
        weeklyRealisedPnl: z.number(),
        openRisk: z.number().nonnegative(),
        openPositions: z.number().int().nonnegative(),
      }),
    );
    const r = await risk(c.env).applyReconciliation(snap);
    await realtime(c.env).broadcast("risk", r.state);
    return c.json(r.state);
  });

  v1.route("/system/gateway", gw);

  // ------------------------------------------------------------ authenticated
  const authed = new Hono<AppBindings>();
  authed.use("*", requireAuth);
  authed.use(
    "*",
    rateLimit((c) => c.env.RATE_LIMITER),
  );

  authed.get("/auth/me", (c) => c.json(c.get("user")));

  authed.get("/account", async (c) => c.json(await account(c.env).getState()));

  authed.put(
    "/account/mode",
    requireOwner,
    rateLimit((c) => c.env.TRADING_RATE_LIMITER),
    async (c) => {
      const input = await body(c, modeChangeSchema);
      const before = await account(c.env).getState();
      const after = await account(c.env).setMode(input.mode, input.confirmation);
      await audit(c.env, {
        actor: actorOf(c),
        action: "account.mode_change",
        target: OWNER_ACCOUNT,
        before: { mode: before.mode },
        after: { mode: after.mode, reason: input.reason },
        requestId: c.get("requestId"),
        ip: ipOf(c),
      });
      return c.json(after);
    },
  );

  authed.put(
    "/account/trading",
    requireOwner,
    rateLimit((c) => c.env.TRADING_RATE_LIMITER),
    async (c) => {
      const input = await body(c, z.object({ enabled: z.boolean(), reason: z.string().min(3).max(500) }));
      const after = await account(c.env).setTradingEnabled(input.enabled);
      await audit(c.env, {
        actor: actorOf(c),
        action: input.enabled ? "trading.enable" : "trading.disable",
        after: { reason: input.reason },
        requestId: c.get("requestId"),
        ip: ipOf(c),
      });
      return c.json(after);
    },
  );

  authed.get("/portfolio", async (c) => {
    const [acc, rs, pos] = await Promise.all([
      account(c.env).getState(),
      risk(c.env).getSnapshot(),
      positions(c.env).list(),
    ]);
    const st = rs.state;
    const dd = st.peakEquity > 0 ? ((st.peakEquity - st.equity) / st.peakEquity) * 100 : 0;
    const dailyLimit = (st.equity * rs.limits.maxDailyLossPct) / 100;
    const summary: DashboardSummary = {
      portfolioValue: st.equity,
      availableCapital: st.equity - st.openRisk,
      todayPnl: st.dailyRealisedPnl,
      overallPnl: 0,
      currentDrawdownPct: dd,
      openPositions: pos.length,
      regime: "UNKNOWN",
      aiStatus: "DISABLED",
      mode: acc.mode,
      riskUtilisationPct: dailyLimit > 0 ? (Math.max(0, -st.dailyRealisedPnl) / dailyLimit) * 100 : 0,
      dailyLossRemaining: Math.max(0, dailyLimit + Math.min(0, st.dailyRealisedPnl)),
      health: {
        api: "ok",
        gateway: acc.lease && acc.lease.expiresAt > Date.now() ? "ok" : "down",
        aiService: "unknown",
        marketData: "unknown",
        brokerSession: "unknown",
        checkedAt: Date.now(),
      },
    };
    return c.json(summary);
  });

  authed.get("/positions", async (c) => c.json(await positions(c.env).list()));
  authed.get("/orders", async (c) => c.json(await orders(c.env).listOpen()));

  /** Dry-run the deterministic risk gateway against current state. Never places an order. */
  authed.post("/orders/preview", async (c) => {
    const p = await body(
      c,
      z.object({
        instrument: instrumentSchema,
        decision: z.enum(["BUY", "SELL", "WAIT", "NO_TRADE", "EXIT", "REDUCE"]),
        entry: z.number().positive(),
        stop: z.number().positive(),
        targets: z.array(z.number().positive()).min(1).max(3),
        marginPerUnit: z.number().positive(),
      }),
    );
    const [acc, rs] = await Promise.all([account(c.env).getState(), risk(c.env).getSnapshot()]);
    const now = Date.now();
    const result = evaluateTrade(p, {
      mode: acc.mode,
      killSwitchActive: acc.killSwitch.active,
      sessionAllowsEntry: canOpenNewPosition(now),
      now,
      lastMarketDataAt: Number.NaN, // no live feed wired in Phase 1 => fails closed
      maxDataStalenessMs: Number(c.env.MAX_DATA_STALENESS_MS ?? 5000),
      limits: rs.limits,
      state: rs.state,
      availableMargin: rs.state.equity,
      marginPerUnit: p.marginPerUnit,
      symbolExposure: 0,
      correlatedExposure: 0,
      grossExposure: 0,
      minRewardRisk: 1.5,
      maxStopDistancePct: 5,
    });
    return c.json(result);
  });

  authed.get("/trades", async (c) => {
    const r = await c.env.DB.prepare("SELECT * FROM trades ORDER BY closed_at DESC LIMIT 100").all();
    return c.json(r.results);
  });

  authed.get("/signals", async (c) => {
    const r = await c.env.DB.prepare("SELECT * FROM signals ORDER BY created_at DESC LIMIT 100").all();
    return c.json(r.results);
  });

  authed.get("/strategies", async (c) => {
    const r = await c.env.DB.prepare("SELECT * FROM strategies ORDER BY id").all();
    return c.json(r.results);
  });

  authed.put("/strategies/:id", requireOwner, async (c) => {
    const input = await body(c, z.object({ enabled: z.boolean(), reason: z.string().min(3).max(500) }));
    const id = c.req.param("id");
    const acc = await account(c.env).getState();
    if (input.enabled && acc.mode === "SAFE_MODE") {
      return apiError(c, 409, "SAFE_MODE", "strategies cannot be activated in SAFE_MODE");
    }
    const r = await c.env.DB.prepare("UPDATE strategies SET enabled = ?, updated_at = ? WHERE id = ?")
      .bind(input.enabled ? 1 : 0, Date.now(), id)
      .run();
    if (!r.meta.changes) return apiError(c, 404, "NOT_FOUND", "strategy not found");
    await audit(c.env, {
      actor: actorOf(c),
      action: "strategy.toggle",
      target: id,
      after: input,
      requestId: c.get("requestId"),
    });
    return c.json({ id, enabled: input.enabled });
  });

  authed.get("/risk", async (c) => c.json(await risk(c.env).getSnapshot()));

  authed.put(
    "/risk/limits",
    requireOwner,
    rateLimit((c) => c.env.TRADING_RATE_LIMITER),
    async (c) => {
      const limits = await body(c, riskLimitsSchema);
      const acc = await account(c.env).getState();
      const before = await risk(c.env).getSnapshot();
      if (acc.mode === "SAFE_MODE" && limits.maxRiskPerTradePct > before.limits.maxRiskPerTradePct) {
        return apiError(c, 409, "SAFE_MODE", "risk cannot be increased in SAFE_MODE");
      }
      const after = await risk(c.env).updateLimits(limits);
      await audit(c.env, {
        actor: actorOf(c),
        action: "risk.limits_update",
        before: before.limits,
        after: after.limits,
        requestId: c.get("requestId"),
        ip: ipOf(c),
      });
      return c.json(after.limits);
    },
  );

  authed.get("/models", async (c) => {
    const r = await c.env.DB.prepare("SELECT * FROM model_versions ORDER BY created_at DESC LIMIT 50").all();
    return c.json(r.results);
  });

  authed.get("/backtests", async (c) => {
    const r = await c.env.DB.prepare("SELECT * FROM backtests ORDER BY created_at DESC LIMIT 50").all();
    return c.json(r.results);
  });

  authed.post("/backtests", requireOwner, async (c) => {
    const input = await body(
      c,
      z.object({ strategy: z.string().max(40), params: z.record(z.string(), z.unknown()).default({}) }),
    );
    const id = `bt_${crypto.randomUUID().replace(/-/g, "")}`;
    await c.env.DB.prepare(
      "INSERT INTO backtests (id, strategy, params, status, created_at) VALUES (?, ?, ?, 'QUEUED', ?)",
    )
      .bind(id, input.strategy, JSON.stringify(input.params), Date.now())
      .run();
    await c.env.Q_BACKTESTS.send({ id, ...input });
    return c.json({ id, status: "QUEUED" }, 202);
  });

  authed.get("/market/session", (c) => {
    const now = Date.now();
    return c.json({ phase: sessionPhase(now, DEFAULT_SESSION), canOpenNewPosition: canOpenNewPosition(now) });
  });

  authed.get("/market/brokers", (c) => c.json(listBrokers()));

  // ------------------------------------------------------------ admin
  authed.post("/admin/kill-switch", requireOwner, async (c) => {
    const input = await body(c, killSwitchSchema);
    const after = await account(c.env).setKillSwitch(input.active, input.trigger, input.reason);
    if (input.active) await risk(c.env).lock(input.trigger);
    await audit(c.env, {
      actor: actorOf(c),
      action: input.active ? "kill_switch.activate" : "kill_switch.deactivate",
      after: input,
      requestId: c.get("requestId"),
      ip: ipOf(c),
    });
    await realtime(c.env).broadcast("alert", { type: "KILL_SWITCH", ...input });
    return c.json(after);
  });

  authed.get("/admin/audit-logs", requireOwner, async (c) => {
    const r = await c.env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200").all();
    return c.json(r.results);
  });

  v1.route("/", authed);
  app.route("/api/v1", v1);
  return app;
}

export const app = createApp();
