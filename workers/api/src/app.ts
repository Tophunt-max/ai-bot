import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { sign } from "hono/jwt";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { listBrokers } from "@atb/brokers";
import {
  KILL_SWITCH_TRIGGERS,
  MODEL_STATUSES,
  type DashboardSummary,
  type ModelStatus,
} from "@atb/shared-types";
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
import type { EngineSnapshot } from "./do/position-manager";
import { audit } from "./lib/audit";
import { ingestEvents } from "./lib/ingest";
import { checkModelTransition } from "./lib/model-policy";
import { notify } from "./lib/notify";
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
    // Egress IP only matters for real-broker orders (CANARY/LIVE); PAPER/SHADOW never reach a broker.
    const modeNow = (await account(c.env).getState()).mode;
    if (!hb.egressIpOk && (modeNow === "CANARY" || modeNow === "LIVE"))
      await risk(c.env).lock("EGRESS_IP_MISMATCH");
    if (!hb.brokerSessionValid) await risk(c.env).lock("BROKER_SESSION_EXPIRED");
    await c.env.CACHE?.put("gateway-health", JSON.stringify({ ...hb, at: Date.now() }), {
      expirationTtl: 300,
    });
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
    const eq = r.state.equity;
    const lossPct = eq > 0 ? (Math.max(0, -r.state.dailyRealisedPnl) / eq) * 100 : 0;
    const ddPct = r.state.peakEquity > 0 ? ((r.state.peakEquity - eq) / r.state.peakEquity) * 100 : 0;
    const day = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    if (lossPct >= 0.75 * r.limits.maxDailyLossPct) {
      await notify(c.env, {
        event: "DAILY_LOSS_WARNING",
        message: `Daily loss ${lossPct.toFixed(2)}% of equity (limit ${r.limits.maxDailyLossPct}%)`,
        dedupeKey: `dlw-${day}`,
      });
    }
    if (ddPct >= 0.75 * r.limits.maxDrawdownPct) {
      await notify(c.env, {
        event: "DRAWDOWN_WARNING",
        message: `Drawdown ${ddPct.toFixed(2)}% (limit ${r.limits.maxDrawdownPct}%)`,
        dedupeKey: `ddw-${day}`,
      });
    }
    return c.json(r.state);
  });

  gw.post("/events", async (c) => {
    const input = await body(
      c,
      z.object({
        nodeId: z.string().min(3).max(40),
        events: z
          .array(
            z.object({
              id: z.string().min(3).max(200),
              type: z.enum(["SIGNAL", "ORDER", "TRADE_OPENED", "TRADE_CLOSED", "RISK_EVENT", "POSITIONS"]),
              at: z.number(),
              mode: z.string().max(20),
              payload: z.record(z.string(), z.unknown()),
            }),
          )
          .max(200),
      }),
    );
    const res = await ingestEvents(c.env, input.nodeId, input.events);
    for (const n of res.notifications) await notify(c.env, n);
    if (res.latestPositions) {
      const p = res.latestPositions.payload as unknown as Omit<EngineSnapshot, "at" | "mode">;
      await positions(c.env).setSnapshot({
        ...p,
        at: res.latestPositions.at,
        mode: res.latestPositions.mode,
      });
      await realtime(c.env).broadcast("position", p.positions);
      await realtime(c.env).broadcast("pnl", { equity: p.equity, dailyPnl: p.dailyPnl });
    }
    for (const e of input.events) {
      if (e.type === "SIGNAL") await realtime(c.env).broadcast("signal", e.payload);
      if (e.type === "ORDER" || e.type === "TRADE_OPENED" || e.type === "TRADE_CLOSED")
        await realtime(c.env).broadcast("order", { type: e.type, ...e.payload });
    }
    return c.json({ inserted: res.inserted, duplicates: res.duplicates });
  });

  /** Automatic kill switch requested by the gateway (independent of AI). */
  gw.post("/kill-switch", async (c) => {
    const input = await body(
      c,
      z.object({ trigger: z.enum(KILL_SWITCH_TRIGGERS), reason: z.string().min(3).max(500) }),
    );
    const before = await account(c.env).getState();
    const after = await account(c.env).setKillSwitch(true, input.trigger, input.reason);
    await risk(c.env).lock(input.trigger);
    await audit(c.env, {
      actor: "gateway",
      action: "kill_switch.auto_activate",
      before: before.killSwitch,
      after: input,
      requestId: c.get("requestId"),
    });
    if (!before.killSwitch.active) {
      await notify(c.env, {
        event: "KILL_SWITCH",
        message: `AUTO kill switch: ${input.trigger} — ${input.reason}`,
        dedupeKey: `ks-${input.trigger}-${Math.floor(Date.now() / 600_000)}`,
      });
    }
    await realtime(c.env).broadcast("alert", { type: "KILL_SWITCH", ...input });
    return c.json(after);
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
    const [acc, rs, pos, snap, totals, lastSig, gwHealth] = await Promise.all([
      account(c.env).getState(),
      risk(c.env).getSnapshot(),
      positions(c.env).list(),
      positions(c.env).getSnapshot(),
      c.env.DB.prepare("SELECT COALESCE(SUM(pnl),0) AS pnl FROM trades WHERE mode = ?")
        .bind((await account(c.env).getState()).mode)
        .first<{ pnl: number }>(),
      c.env.DB.prepare("SELECT regime FROM signals ORDER BY created_at DESC LIMIT 1").first<{
        regime: string;
      }>(),
      c.env.CACHE?.get("gateway-health", "json") as
        Promise<{ brokerSessionValid?: boolean; egressIpOk?: boolean; at?: number } | null> | undefined,
    ]);
    const st = rs.state;
    const dd = st.peakEquity > 0 ? ((st.peakEquity - st.equity) / st.peakEquity) * 100 : 0;
    const dailyLimit = (st.equity * rs.limits.maxDailyLossPct) / 100;
    const summary: DashboardSummary = {
      portfolioValue: st.equity,
      availableCapital: st.equity - st.openRisk,
      todayPnl: st.dailyRealisedPnl,
      overallPnl: totals?.pnl ?? 0,
      currentDrawdownPct: dd,
      openPositions: pos.length,
      regime: (lastSig?.regime as DashboardSummary["regime"]) ?? "UNKNOWN",
      aiStatus: !snap?.monitor
        ? "DISABLED"
        : snap.monitor.state === "NORMAL"
          ? "ACTIVE"
          : snap.monitor.state === "REDUCED"
            ? "DEGRADED"
            : "DISABLED",
      mode: acc.mode,
      riskUtilisationPct: dailyLimit > 0 ? (Math.max(0, -st.dailyRealisedPnl) / dailyLimit) * 100 : 0,
      dailyLossRemaining: Math.max(0, dailyLimit + Math.min(0, st.dailyRealisedPnl)),
      health: {
        api: "ok",
        gateway: acc.lease && acc.lease.expiresAt > Date.now() ? "ok" : "down",
        aiService: "unknown",
        marketData: snap && Date.now() - snap.at < 120_000 ? "fresh" : snap ? "stale" : "unknown",
        brokerSession:
          gwHealth?.brokerSessionValid === undefined
            ? "unknown"
            : gwHealth.brokerSessionValid
              ? "valid"
              : "expired",
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

  authed.post("/models", requireOwner, async (c) => {
    const m = await body(
      c,
      z.object({
        modelId: z.string().min(2).max(60),
        version: z.string().min(1).max(40),
        featuresVersion: z.string().max(40),
        datasetVersion: z.string().max(80),
        trainingDate: z.number(),
        validationMetrics: z.record(z.string(), z.unknown()).default({}),
        outOfSampleMetrics: z.record(z.string(), z.unknown()).default({}),
        artifactR2Key: z.string().max(200).optional(),
      }),
    );
    const id = `mv_${m.modelId}_${m.version}`.replace(/[^A-Za-z0-9_.-]/g, "_");
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO model_versions (id, model_id, version, features_version, dataset_version, training_date, validation_metrics,
         out_of_sample_metrics, artifact_r2_key, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
    )
      .bind(
        id,
        m.modelId,
        m.version,
        m.featuresVersion,
        m.datasetVersion,
        m.trainingDate,
        JSON.stringify(m.validationMetrics),
        JSON.stringify(m.outOfSampleMetrics),
        m.artifactR2Key ?? null,
        now,
        now,
      )
      .run();
    await audit(c.env, {
      actor: actorOf(c),
      action: "model.register",
      target: id,
      after: m,
      requestId: c.get("requestId"),
    });
    return c.json({ id, status: "DRAFT" }, 201);
  });

  authed.put("/models/:id/status", requireOwner, async (c) => {
    const input = await body(
      c,
      z.object({ status: z.enum(MODEL_STATUSES), reason: z.string().min(3).max(500) }),
    );
    const id = c.req.param("id");
    const row = await c.env.DB.prepare("SELECT model_id, status FROM model_versions WHERE id = ?")
      .bind(id)
      .first<{ model_id: string; status: ModelStatus }>();
    if (!row) return apiError(c, 404, "NOT_FOUND", "model version not found");
    const acc = await account(c.env).getState();
    if (acc.mode === "SAFE_MODE" && input.status !== "RETIRED")
      return apiError(c, 409, "SAFE_MODE", "no model deployment in SAFE_MODE");
    const check = checkModelTransition(row.status, input.status);
    if (check) return apiError(c, 409, "MODEL_TRANSITION_REJECTED", check);
    const now = Date.now();
    const stmts = [
      c.env.DB.prepare("UPDATE model_versions SET status = ?, updated_at = ? WHERE id = ?").bind(
        input.status,
        now,
        id,
      ),
    ];
    if (input.status === "PRODUCTION") {
      stmts.unshift(
        c.env.DB.prepare(
          "UPDATE model_versions SET status = 'RETIRED', updated_at = ? WHERE model_id = ? AND status = 'PRODUCTION' AND id != ?",
        ).bind(now, row.model_id, id),
      );
    }
    await c.env.DB.batch(stmts);
    await audit(c.env, {
      actor: actorOf(c),
      action: "model.status",
      target: id,
      before: row.status,
      after: input,
      requestId: c.get("requestId"),
    });
    return c.json({ id, status: input.status });
  });

  authed.post("/backtests/report", requireOwner, async (c) => {
    const input = await body(
      c,
      z.object({
        strategy: z.string().max(80).default("ensemble"),
        params: z.record(z.string(), z.unknown()).default({}),
        metrics: z.record(z.string(), z.unknown()),
        verdict: z.enum(["PASS", "FAIL"]).optional(),
        report: z.unknown().optional(),
      }),
    );
    const id = `bt_${crypto.randomUUID().replace(/-/g, "")}`;
    const key = `backtests/${id}.json`;
    if (input.report !== undefined)
      await c.env.ARTIFACTS.put(key, JSON.stringify(input.report), {
        httpMetadata: { contentType: "application/json" },
      });
    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO backtests (id, strategy, params, status, metrics, report_r2_key, created_at, finished_at) VALUES (?, ?, ?, 'DONE', ?, ?, ?, ?)",
    )
      .bind(
        id,
        input.strategy,
        JSON.stringify(input.params),
        JSON.stringify({ ...input.metrics, verdict: input.verdict }),
        input.report !== undefined ? key : null,
        now,
        now,
      )
      .run();
    return c.json({ id }, 201);
  });

  authed.get("/backtests/:id", async (c) => {
    const row = await c.env.DB.prepare("SELECT * FROM backtests WHERE id = ?")
      .bind(c.req.param("id"))
      .first<Record<string, unknown>>();
    if (!row) return apiError(c, 404, "NOT_FOUND", "backtest not found");
    return c.json(row);
  });

  authed.get("/stats/performance", async (c) => {
    const mode = c.req.query("mode") ?? (await account(c.env).getState()).mode;
    const by = async (col: "strategy" | "regime" | "exit_reason") =>
      (
        await c.env.DB.prepare(
          `SELECT ${col} AS k, COUNT(*) AS n, SUM(pnl) AS pnl, AVG(r_multiple) AS avg_r,
             SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS win_rate
           FROM trades WHERE mode = ? GROUP BY ${col} ORDER BY pnl DESC`,
        )
          .bind(mode)
          .all()
      ).results;
    const [strategy, regime, exit] = await Promise.all([by("strategy"), by("regime"), by("exit_reason")]);
    return c.json({ mode, strategy, regime, exit });
  });

  authed.post("/notifications/push-token", async (c) => {
    const input = await body(
      c,
      z.object({ token: z.string().min(10).max(200), platform: z.string().max(20).optional() }),
    );
    await c.env.DB.prepare(
      "INSERT OR REPLACE INTO push_tokens (token, user_id, platform, created_at) VALUES (?, 'owner', ?, ?)",
    )
      .bind(input.token, input.platform ?? null, Date.now())
      .run();
    return c.json({ ok: true });
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
