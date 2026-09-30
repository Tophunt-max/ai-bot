import type {
  AccountId,
  ApiError,
  DashboardSummary,
  KillSwitchTrigger,
  ModelStatus,
  RiskLimits,
  RiskState,
  TradingMode,
} from "@atb/shared-types";

export interface AccountState {
  account?: AccountId;
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

export interface BacktestRow {
  id: string;
  strategy: string | null;
  status: string;
  params: string;
  metrics: string; // JSON
  report_r2_key: string | null;
  created_at: number;
}

export interface ModelRow {
  id: string;
  model_id: string;
  version: string;
  features_version: string;
  dataset_version: string;
  status: ModelStatus;
  validation_metrics: string;
  out_of_sample_metrics: string;
  created_at: number;
}

export interface PerfRow {
  k: string | null;
  n: number;
  pnl: number;
  avg_r: number | null;
  win_rate: number;
}

export interface PerformanceStats {
  mode: TradingMode;
  strategy: PerfRow[];
  regime: PerfRow[];
  exit: PerfRow[];
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
  /** Which book every request targets: "demo" (virtual money) or "real" (real money). */
  getAccount?: () => AccountId;
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
}

/** Typed client for the Worker API. Holds NO broker secrets — only the user's session JWT. */
export function createApiClient(opts: ApiClientOptions) {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-ATB-Account": opts.getAccount?.() ?? "demo",
    };
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
    setStrategyEnabled: (id: string, enabled: boolean, reason: string) =>
      call<{ id: string; enabled: boolean }>("PUT", `/strategies/${encodeURIComponent(id)}`, {
        enabled,
        reason,
      }),
    backtests: () => call<BacktestRow[]>("GET", "/backtests"),
    backtest: (id: string) => call<BacktestRow>("GET", `/backtests/${encodeURIComponent(id)}`),
    models: () => call<ModelRow[]>("GET", "/models"),
    setModelStatus: (id: string, status: ModelStatus, reason: string) =>
      call<{ id: string; status: ModelStatus }>("PUT", `/models/${encodeURIComponent(id)}/status`, {
        status,
        reason,
      }),
    performance: (mode?: TradingMode) =>
      call<PerformanceStats>("GET", `/stats/performance${mode ? `?mode=${mode}` : ""}`),
    registerPushToken: (token: string, platform?: string) =>
      call<{ ok: boolean }>("POST", "/notifications/push-token", { token, platform }),
    brokers: () => call<BrokerInfo[]>("GET", "/market/brokers"),
    session: () => call<{ phase: string; canOpenNewPosition: boolean }>("GET", "/market/session"),
    killSwitch: (active: boolean, reason: string, trigger: KillSwitchTrigger = "MANUAL") =>
      call<AccountState>("POST", "/admin/kill-switch", { active, reason, trigger }),
    auditLogs: () => call<Array<Record<string, unknown>>>("GET", "/admin/audit-logs"),
    realtimeUrl: (token: string, account: AccountId = opts.getAccount?.() ?? "demo") =>
      `${base.replace(/^http/, "ws")}/api/v1/system/realtime?token=${encodeURIComponent(token)}&account=${account}`,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
