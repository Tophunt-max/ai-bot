import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { verify } from "hono/jwt";
import type { AppBindings, AuthUser, RateLimitBinding } from "./env";
import { verifySignedRequest } from "./lib/crypto";

export function apiError(c: Context, status: number, code: string, message: string, details?: unknown) {
  return c.json(
    { error: { code, message, requestId: c.get("requestId"), ...(details ? { details } : {}) } },
    status as 400,
  );
}

export async function verifyUserToken(token: string, secret: string): Promise<AuthUser | null> {
  if (!secret) return null;
  try {
    const p = (await verify(token, secret, "HS256")) as { sub?: string; role?: string };
    if (!p.sub || (p.role !== "OWNER" && p.role !== "VIEWER")) return null;
    return { sub: p.sub, role: p.role };
  } catch {
    return null;
  }
}

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const h = c.req.header("Authorization");
  const token = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
  const user = token ? await verifyUserToken(token, c.env.JWT_SECRET) : null;
  if (!user) return apiError(c, 401, "UNAUTHENTICATED", "valid bearer token required");
  c.set("user", user);
  await next();
};

export const requireOwner: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("user")?.role !== "OWNER") return apiError(c, 403, "FORBIDDEN", "owner role required");
  await next();
};

export function rateLimit(
  pick: (c: Context<AppBindings>) => RateLimitBinding | undefined,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const limiter = pick(c);
    if (limiter) {
      const key = c.get("user")?.sub ?? c.req.header("CF-Connecting-IP") ?? "anon";
      const { success } = await limiter.limit({ key: `${key}:${c.req.routePath}` });
      if (!success) return apiError(c, 429, "RATE_LIMITED", "too many requests");
    }
    await next();
  };
}

/** HMAC auth for Execution Gateway -> Worker calls. */
export const requireGateway: MiddlewareHandler<AppBindings> = async (c, next) => {
  const body = await c.req.raw.clone().text();
  const ok = await verifySignedRequest(
    c.env.GATEWAY_HMAC_SECRET,
    c.req.method,
    new URL(c.req.url).pathname,
    body,
    c.req.header("X-ATB-Timestamp"),
    c.req.header("X-ATB-Signature"),
  );
  if (!ok) throw new HTTPException(401, { message: "invalid gateway signature" });
  await next();
};
