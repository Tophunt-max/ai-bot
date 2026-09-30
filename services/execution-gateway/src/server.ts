import { Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { verifySignedRequest } from "@atb/trading-core";
import type { TradingEngine } from "./engine";
import type { OrderExecutor } from "./executor";

/**
 * Gateway HTTP API. Reached ONLY via Cloudflare Tunnel (no public inbound port).
 * All mutating routes require the Worker's HMAC signature.
 */
export function createGatewayApp(executor: OrderExecutor, hmacSecret: string, engine?: TradingEngine) {
  const app = new Hono();
  app.use("*", secureHeaders());

  const signed: MiddlewareHandler = async (c, next) => {
    const body = c.req.method === "GET" ? "" : await c.req.raw.clone().text();
    const ok = await verifySignedRequest(
      hmacSecret,
      c.req.method,
      new URL(c.req.url).pathname,
      body,
      c.req.header("X-ATB-Timestamp"),
      c.req.header("X-ATB-Signature"),
    );
    if (!ok) return c.json({ error: { code: "UNAUTHENTICATED", message: "invalid signature" } }, 401);
    await next();
  };

  // Liveness only — exposes no secrets, IPs or balances.
  app.get("/health", (c) => c.json({ status: "ok", nodeId: executor.status.nodeId }));

  app.get("/v1/status", signed, (c) => c.json({ ...executor.status, blockReasons: executor.blockReasons() }));

  app.post("/v1/orders", signed, async (c) => {
    const outcome = await executor.submit(await c.req.json().catch(() => null));
    return c.json(outcome, outcome.accepted ? 200 : 409);
  });

  app.post("/v1/reconcile", signed, async (c) => c.json(await executor.reconcileUnknown()));

  app.get("/v1/engine", signed, (c) => c.json(engine ? engine.status() : { error: "engine not running" }));

  return app;
}
