import { Hono, type MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { isAccountId, type AccountId } from "@atb/shared-types";
import { verifySignedRequest } from "@atb/trading-core";
import type { TradingEngine } from "./engine";
import type { OrderExecutor } from "./executor";

export interface Book {
  executor: OrderExecutor;
  engine?: TradingEngine;
}

/**
 * Gateway HTTP API. Reached ONLY via Cloudflare Tunnel (no public inbound port).
 * All routes except /health require the Worker's HMAC signature. Each account ("demo" / "real")
 * is a separate book with its own executor and engine.
 */
export function createGatewayApp(books: Partial<Record<AccountId, Book>>, hmacSecret: string) {
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

  const bookOf = (v: unknown): Book | undefined => (isAccountId(v) ? books[v] : undefined);

  // Liveness only — exposes no secrets, IPs or balances.
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      nodeId: Object.values(books)[0]?.executor.status.nodeId,
      books: Object.keys(books),
    }),
  );

  app.get("/v1/status", signed, (c) => {
    const b = bookOf(c.req.query("account") ?? "demo");
    if (!b)
      return c.json({ error: { code: "NO_BOOK", message: "account not running on this gateway" } }, 404);
    return c.json({ ...b.executor.status, blockReasons: b.executor.blockReasons() });
  });

  app.get("/v1/engine", signed, (c) => {
    const b = bookOf(c.req.query("account") ?? "demo");
    return c.json(b?.engine ? b.engine.status() : { error: "engine not running" });
  });

  // Account is taken from the SIGNED body, never from an unsigned query/header.
  app.post("/v1/orders", signed, async (c) => {
    const input = (await c.req.json().catch(() => null)) as { account?: unknown; order?: unknown } | null;
    const b = bookOf(input?.account);
    if (!b) return c.json({ accepted: false, reasons: ["unknown or disabled account"] }, 409);
    const outcome = await b.executor.submit(input?.order);
    return c.json(outcome, outcome.accepted ? 200 : 409);
  });

  app.post("/v1/reconcile", signed, async (c) => {
    const input = (await c.req.json().catch(() => null)) as { account?: unknown } | null;
    const b = bookOf(input?.account);
    if (!b) return c.json({ error: "unknown account" }, 404);
    return c.json(await b.executor.reconcileUnknown());
  });

  return app;
}
