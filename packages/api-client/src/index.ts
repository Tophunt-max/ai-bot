import type {
  ApiError,
  DashboardSummary,
  KillSwitchTrigger,
  RiskLimits,
  RiskState,
  TradingMode,
} from "@atb/shared-types";

export interface AccountState {
  mode: TradingMode;
  status: string;
  tradingEnabled: boolean;
  killSwitch: { active: boolean; trigger?: KillSwitchTrigger; reason?: string; at?: number };
  lease?: { nodeId: string; expiresAt: number };
  updatedAt: number;
}

export interface BrokerInfo {
  id: string;
  name: string;
  adapter: "implemented" | "planned";
  dailyLogin: boolean;
  docsUrl?: string;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null> | string | null;
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

/** Typed client for the Worker API. Holds NO broker secrets — only the user's session JWT. */
export function createApiClient(opts: ApiClientOptions) {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      const token = await opts.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await f(`${base}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T | ApiError;
    if (!res.ok) {
      const e = (data as ApiError).error ?? { code: "HTTP_ERROR", message: `HTTP ${res.status}` };
      if (res.status === 401) opts.onUnauthorized?.();
      throw new ApiClientError(res.status, e.code, e.message, e.requestId);
    }
    return data as T;
  }

  return {
    health: () => call<{ status: string; environment: string }>("GET", "/system/health", undefined, false),
    login: (email: string, password: string, totp?: string) =>
      call<{ token: string; expiresIn: number }>("POST", "/auth/login", { email, password, totp }, false),
    me: () => call<{ sub: string; role: string }>("GET", "/auth/me"),
    account: () => call<AccountState>("GET", "/account"),
    setMode: (mode: TradingMode, reason: string, confirmation?: string) =>
      call<AccountState>("PUT", "/account/mode", { mode, reason, confirmation }),
    setTradingEnabled: (enabled: boolean, reason: string) =>
      call<AccountState>("PUT", "/account/trading", { enabled, reason }),
    portfolio: () => call<DashboardSummary>("GET", "/portfolio"),
    positions: () => call<unknown[]>("GET", "/positions"),
    orders: () => call<unknown[]>("GET", "/orders"),
    trades: () => call<unknown[]>("GET", "/trades"),
    signals: () => call<unknown[]>("GET", "/signals"),
    strategies: () => call<Array<{ id: string; name: string; enabled: number }>>("GET", "/strategies"),
    risk: () => call<{ limits: RiskLimits; state: RiskState }>("GET", "/risk"),
    updateRiskLimits: (limits: RiskLimits) => call<RiskLimits>("PUT", "/risk/limits", limits),
    brokers: () => call<BrokerInfo[]>("GET", "/market/brokers"),
    session: () => call<{ phase: string; canOpenNewPosition: boolean }>("GET", "/market/session"),
    killSwitch: (active: boolean, reason: string, trigger: KillSwitchTrigger = "MANUAL") =>
      call<AccountState>("POST", "/admin/kill-switch", { active, reason, trigger }),
    auditLogs: () => call<Array<Record<string, unknown>>>("GET", "/admin/audit-logs"),
    realtimeUrl: (token: string) =>
      `${base.replace(/^http/, "ws")}/api/v1/system/realtime?token=${encodeURIComponent(token)}`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
