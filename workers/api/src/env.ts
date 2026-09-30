import type { Environment } from "@atb/shared-types";
import type { OrderManagerDO } from "./do/order-manager";
import type { PositionManagerDO } from "./do/position-manager";
import type { RealtimeSessionDO } from "./do/realtime-session";
import type { RiskManagerDO } from "./do/risk-manager";
import type { TradingAccountDO } from "./do/trading-account";

export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ENVIRONMENT: Environment;
  OWNER_EMAIL: string;
  GATEWAY_URL: string;
  AI_SERVICE_URL: string;
  CORS_ORIGINS: string;
  MAX_DATA_STALENESS_MS: string;

  // secrets
  JWT_SECRET: string;
  OWNER_PASSWORD_HASH: string;
  GATEWAY_HMAC_SECRET: string;
  AI_SERVICE_SECRET?: string;
  CF_ACCESS_AUD?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;

  DB: D1Database;
  ARTIFACTS: R2Bucket;
  CACHE: KVNamespace;
  RATE_LIMITER?: RateLimitBinding;
  TRADING_RATE_LIMITER?: RateLimitBinding;

  TRADING_ACCOUNT: DurableObjectNamespace<TradingAccountDO>;
  RISK_MANAGER: DurableObjectNamespace<RiskManagerDO>;
  POSITION_MANAGER: DurableObjectNamespace<PositionManagerDO>;
  ORDER_MANAGER: DurableObjectNamespace<OrderManagerDO>;
  REALTIME: DurableObjectNamespace<RealtimeSessionDO>;

  Q_MARKET_DATA: Queue;
  Q_SIGNALS: Queue;
  Q_TRADE_EVENTS: Queue;
  Q_NOTIFICATIONS: Queue;
  Q_BACKTESTS: Queue;
  Q_MODEL_EVAL: Queue;
  Q_ANALYTICS: Queue;
}

export interface AuthUser {
  sub: string;
  role: "OWNER" | "VIEWER";
}

export type AppBindings = { Bindings: Env; Variables: { user: AuthUser; requestId: string } };

/** Personal use: exactly one trading account DO instance per broker account label. */
export const OWNER_ACCOUNT = "owner-primary";
