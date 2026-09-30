import { BrokerError } from "@atb/trading-core";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * JSON/form HTTP helper. For order-mutating calls pass `mutating: true`:
 * a timeout/network error then becomes UNKNOWN_STATE (must reconcile, never retry blindly).
 */
export async function request<T>(
  opts: HttpOptions,
  url: string,
  init: RequestInit & { mutating?: boolean },
): Promise<{ status: number; body: T }> {
  const f = opts.fetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5_000);
  let res: Response;
  try {
    res = await f(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (init.mutating) throw new BrokerError(`order call outcome unknown: ${msg}`, "UNKNOWN_STATE");
    throw new BrokerError(`network error: ${msg}`, "NETWORK", true);
  } finally {
    clearTimeout(timer);
  }

  let body: unknown;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (init.mutating && res.status >= 500) {
      throw new BrokerError(`order call outcome unknown: HTTP ${res.status}`, "UNKNOWN_STATE");
    }
    throw new BrokerError(`non-JSON response HTTP ${res.status}`, "BAD_RESPONSE");
  }

  if (res.status === 401) throw new BrokerError("session invalid/expired", "AUTH");
  if (res.status === 429) throw new BrokerError("broker rate limit", "RATE_LIMIT", true);
  if (res.status >= 500 && init.mutating) {
    throw new BrokerError(`order call outcome unknown: HTTP ${res.status}`, "UNKNOWN_STATE");
  }
  return { status: res.status, body: body as T };
}

export function form(data: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
}

/** Short, deterministic tag (<= 20 chars) derived from clientOrderId, for brokers without client ids. */
export async function shortTag(clientOrderId: string, prefix = "atb"): Promise<string> {
  const data = new TextEncoder().encode(clientOrderId);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex}`.slice(0, 20);
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
