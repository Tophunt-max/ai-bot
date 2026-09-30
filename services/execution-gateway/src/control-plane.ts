import type { FetchLike } from "@atb/brokers";
import type { AccountId, KillSwitchTrigger, RiskLimits, TradingMode } from "@atb/shared-types";
import { signRequest } from "@atb/trading-core";

export interface HeartbeatRequest {
  nodeId: string;
  egressIp: string;
  egressIpOk: boolean;
  brokerSessionValid: boolean;
  marketDataAt?: number;
}

export interface HeartbeatResponse {
  leaseGranted: boolean;
  leaseHolder?: string;
  mode: TradingMode;
  tradingEnabled: boolean;
  killSwitch: { active: boolean; trigger?: KillSwitchTrigger; reason?: string };
  limits: RiskLimits;
}

export type GatewayEventType =
  "SIGNAL" | "ORDER" | "TRADE_OPENED" | "TRADE_CLOSED" | "RISK_EVENT" | "POSITIONS";

export interface GatewayEvent {
  id: string; // idempotency key for ingestion
  type: GatewayEventType;
  at: number;
  mode: TradingMode;
  payload: Record<string, unknown>;
}

export interface ReconciliationSnapshot {
  equity: number;
  dailyRealisedPnl: number;
  weeklyRealisedPnl: number;
  openRisk: number;
  openPositions: number;
}

export interface ControlPlane {
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  postEvents?(nodeId: string, events: GatewayEvent[]): Promise<void>;
  reconciliation?(snap: ReconciliationSnapshot): Promise<void>;
  killSwitch?(trigger: KillSwitchTrigger, reason: string): Promise<void>;
}

/**
 * Signed client for the Cloudflare Worker gateway endpoints. One instance per account
 * ("demo" / "real"); the account is part of the SIGNED body so it cannot be swapped in transit.
 */
export class HttpControlPlane implements ControlPlane {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    readonly account: AccountId,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  private async post<T>(path: string, payload: object): Promise<T> {
    const body = JSON.stringify({ ...payload, account: this.account });
    const fullPath = `/api/v1/system/gateway${path}`;
    const headers = await signRequest(this.secret, "POST", fullPath, body);
    const res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${fullPath}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`control plane ${path} HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.post("/heartbeat", req);
  }

  async postEvents(nodeId: string, events: GatewayEvent[]): Promise<void> {
    await this.post("/events", { nodeId, events });
  }

  async reconciliation(snap: ReconciliationSnapshot): Promise<void> {
    await this.post("/reconciliation", snap);
  }

  async killSwitch(trigger: KillSwitchTrigger, reason: string): Promise<void> {
    await this.post("/kill-switch", { trigger, reason });
  }
}
