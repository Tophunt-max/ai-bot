import type { FetchLike } from "@atb/brokers";

export interface EgressStatus {
  ip: string | null;
  ok: boolean;
  checkedAt: number;
  error?: string;
}

/**
 * Verifies this node's public egress IP is one of the broker-whitelisted static IPs.
 * Any failure => ok=false (fail closed: orders are blocked until it passes).
 */
export async function checkEgressIp(
  whitelist: readonly string[],
  url: string,
  fetchFn: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<EgressStatus> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetchFn(url, { signal: ctrl.signal });
    clearTimeout(t);
    const ip = (await res.text()).trim();
    if (!res.ok || !/^[0-9a-fA-F:.]{3,45}$/.test(ip)) {
      return { ip: null, ok: false, checkedAt: now(), error: `bad response HTTP ${res.status}` };
    }
    return { ip, ok: whitelist.includes(ip), checkedAt: now() };
  } catch (e) {
    return { ip: null, ok: false, checkedAt: now(), error: String(e) };
  }
}
