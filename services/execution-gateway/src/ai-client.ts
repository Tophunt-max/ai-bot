import { signRequest } from "@atb/trading-core";

export interface MetaRequest {
  instrument_id: string;
  side: "BUY" | "SELL";
  strategies: string[];
  regime: string;
  features: Record<string, number>;
  /** Model eligibility depends on mode (LIVE → PRODUCTION models only). */
  mode: "PAPER" | "SHADOW" | "CANARY" | "LIVE";
}

export interface MetaResponse {
  probability: number | null;
  model_version: string;
  status: string;
}

/**
 * Client for the AI service meta-label endpoint. Returns null on ANY failure so the caller
 * fails closed (no trade). The AI service never sees broker credentials or places orders.
 */
export class AiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly timeoutMs = 2000,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async meta(req: MetaRequest): Promise<MetaResponse | null> {
    const path = "/predict/meta";
    const body = JSON.stringify(req);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers = await signRequest(this.secret, "POST", path, body);
      const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const r = (await res.json()) as MetaResponse;
      return typeof r.probability === "number" || r.probability === null ? r : null;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}
