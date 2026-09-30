/**
 * Shared domain types for AI Trading Bot V3.
 * Pure types + const enums-as-objects so they work in Workers, Node and React Native.
 */

// ---------------------------------------------------------------- modes
export const TRADING_MODES = ["BACKTEST", "PAPER", "SHADOW", "CANARY", "LIVE", "SAFE_MODE"] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const ENVIRONMENTS = ["development", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Modes each environment is allowed to run. LIVE/CANARY only in production. */
export const ALLOWED_MODES: Record<Environment, readonly TradingMode[]> = {
  development: ["BACKTEST", "PAPER", "SAFE_MODE"],
  staging: ["BACKTEST", "PAPER", "SHADOW", "SAFE_MODE"],
  production: ["BACKTEST", "PAPER", "SHADOW", "CANARY", "LIVE", "SAFE_MODE"],
};

// ---------------------------------------------------------------- accounts
/**
 * Two completely separate books:
 *  - demo: VIRTUAL money on REAL live market data (paper broker). Can never reach a real broker.
 *  - real: REAL money through the real broker (SHADOW first, then CANARY, then LIVE).
 */
export const ACCOUNT_IDS = ["demo", "real"] as const;
export type AccountId = (typeof ACCOUNT_IDS)[number];

export const ACCOUNT_ALLOWED_MODES: Record<AccountId, readonly TradingMode[]> = {
  demo: ["PAPER", "SAFE_MODE"],
  real: ["SHADOW", "CANARY", "LIVE", "SAFE_MODE"],
};

export const DEFAULT_ACCOUNT_MODE: Record<AccountId, TradingMode> = {
  demo: "PAPER",
  real: "SAFE_MODE",
};

export function isAccountId(x: unknown): x is AccountId {
  return x === "demo" || x === "real";
}

// ---------------------------------------------------------------- market
export const EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"] as const;
export type Exchange = (typeof EXCHANGES)[number];

export const INSTRUMENT_TYPES = ["EQ", "FUT", "CE", "PE", "INDEX"] as const;
export type InstrumentType = (typeof INSTRUMENT_TYPES)[number];

export const TIMEFRAMES = ["1m", "5m", "15m", "75m", "1h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Instrument {
  id: string; // internal id e.g. "NSE:RELIANCE"
  exchange: Exchange;
  tradingSymbol: string;
  instrumentType: InstrumentType;
  lotSize: number;
  tickSize: number;
  freezeQuantity?: number;
  expiry?: string; // ISO date
  strike?: number;
  /** Per-broker instrument token / security id mapping */
  brokerTokens?: Partial<Record<BrokerId, string>>;
}

export interface Quote {
  instrumentId: string;
  ltp: number;
  bid?: number;
  ask?: number;
  volume?: number;
  timestamp: number; // epoch ms
}

export interface Candle {
  t: number; // candle open epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Tick {
  instrumentId: string;
  ltp: number;
  qty?: number;
  timestamp: number;
}

export const MARKET_REGIMES = [
  "STRONG_BULL",
  "WEAK_BULL",
  "STRONG_BEAR",
  "WEAK_BEAR",
  "SIDEWAYS",
  "HIGH_VOLATILITY",
  "LOW_VOLATILITY",
  "ABNORMAL",
  "UNKNOWN",
] as const;
export type MarketRegime = (typeof MARKET_REGIMES)[number];

// ---------------------------------------------------------------- signals
export const SIGNAL_DECISIONS = ["BUY", "SELL", "WAIT", "NO_TRADE", "EXIT", "REDUCE"] as const;
export type SignalDecision = (typeof SIGNAL_DECISIONS)[number];

export const STRATEGY_IDS = [
  "TREND_FOLLOWING",
  "MOMENTUM",
  "BREAKOUT",
  "PULLBACK",
  "MEAN_REVERSION",
  "VOLATILITY",
  "RANGE_TRADING",
] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

export interface StrategySignal {
  strategy: StrategyId;
  signal: SignalDecision;
  /** Relative setup quality in [0,1]. NOT a probability of profit. */
  quality: number;
  entry: number;
  stop: number;
  target: number;
  reason: string;
}

export interface SignalReasons {
  trend?: string;
  momentum?: string;
  volatility?: string;
  marketStructure?: string;
  strategyAgreement?: string;
  riskReward?: string;
  liquidity?: string;
  regime?: string;
}

export interface FinalSignal {
  id: string;
  instrumentId: string;
  decision: SignalDecision;
  regime: MarketRegime;
  quality: number;
  qualityBand: "LOW" | "MEDIUM" | "HIGH";
  entry: number;
  stop: number;
  targets: number[]; // TP1..TP3
  strategiesAgreeing: number;
  strategiesTotal: number;
  modelVersion: string;
  reasons: SignalReasons;
  createdAt: number;
}

// ---------------------------------------------------------------- orders
export const SIDES = ["BUY", "SELL"] as const;
export type Side = (typeof SIDES)[number];

/** MARKET is intentionally absent: retail algo orders must be LIMIT with price protection. */
export const ORDER_TYPES = ["LIMIT", "SL_LIMIT"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const PRODUCT_TYPES = ["INTRADAY", "DELIVERY", "NORMAL"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const ORDER_STATUSES = [
  "CREATED",
  "VALIDATED",
  "SUBMITTED",
  "ACKNOWLEDGED",
  "PARTIALLY_FILLED",
  "FILLED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "UNKNOWN",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderRequest {
  /** Idempotency key. Same key => same order, never duplicated. */
  clientOrderId: string;
  instrument: Instrument;
  side: Side;
  quantity: number;
  orderType: OrderType;
  product: ProductType;
  price: number;
  triggerPrice?: number;
  tag?: string;
}

export interface ModifyRequest {
  quantity?: number;
  price?: number;
  triggerPrice?: number;
}

export interface OrderResult {
  clientOrderId: string;
  brokerOrderId?: string;
  status: OrderStatus;
  filledQuantity: number;
  averagePrice?: number;
  message?: string;
}

export interface Order extends OrderResult {
  instrumentId: string;
  side: Side;
  quantity: number;
  orderType: OrderType;
  product: ProductType;
  price: number;
  triggerPrice?: number;
  updatedAt: number;
}

export interface Position {
  instrumentId: string;
  quantity: number; // signed: +long / -short
  averagePrice: number;
  lastPrice?: number;
  realisedPnl: number;
  unrealisedPnl: number;
  product: ProductType;
}

export interface Balance {
  availableCash: number;
  usedMargin: number;
  totalEquity: number;
}

// ---------------------------------------------------------------- risk
export interface RiskLimits {
  maxRiskPerTradePct: number; // % of equity
  maxDailyLossPct: number;
  maxWeeklyLossPct: number;
  maxDrawdownPct: number;
  maxOpenPositions: number;
  maxSymbolExposurePct: number;
  maxCorrelatedExposurePct: number;
  maxLeverage: number;
  maxPositionValue: number; // INR
  maxOrdersPerMinute: number;
  maxOrdersPerSecond: number;
}

export const KILL_SWITCH_TRIGGERS = [
  "MANUAL",
  "EXCESSIVE_LOSS",
  "BROKER_FAILURE",
  "MARKET_DATA_FAILURE",
  "ABNORMAL_SLIPPAGE",
  "MODEL_ANOMALY",
  "POSITION_MISMATCH",
  "SYSTEM_FAILURE",
  "EGRESS_IP_MISMATCH",
  "BROKER_SESSION_EXPIRED",
] as const;
export type KillSwitchTrigger = (typeof KILL_SWITCH_TRIGGERS)[number];

export interface RiskState {
  equity: number;
  peakEquity: number;
  dailyRealisedPnl: number;
  weeklyRealisedPnl: number;
  openRisk: number;
  openPositions: number;
  tradingLocked: boolean;
  lockReason?: KillSwitchTrigger | string;
  updatedAt: number;
}

export interface RiskCheckResult {
  approved: boolean;
  quantity: number;
  failedCheck?: string;
  reasons: string[];
}

// ---------------------------------------------------------------- brokers
export const BROKER_IDS = [
  "paper",
  "zerodha",
  "upstox",
  "dhan",
  "angelone",
  "fyers",
  "kotakneo",
  "icicidirect",
  "fivepaisa",
  "shoonya",
  "flattrade",
  "zebu",
  "tradejini",
  "aliceblue",
  "iifl",
  "groww",
  "motilaloswal",
  "paytmmoney",
  "nuvama",
  "samco",
  "mstock",
  "definedge",
  "sharekhan",
] as const;
export type BrokerId = (typeof BROKER_IDS)[number];

// ---------------------------------------------------------------- models
export const MODEL_STATUSES = [
  "DRAFT",
  "VALIDATING",
  "PAPER",
  "SHADOW",
  "CANARY",
  "PRODUCTION",
  "RETIRED",
] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

// ---------------------------------------------------------------- api
export interface ApiError {
  error: { code: string; message: string; requestId?: string; details?: unknown };
}

export interface SystemHealth {
  api: "ok" | "degraded" | "down";
  gateway: "ok" | "degraded" | "down" | "unknown";
  aiService: "ok" | "degraded" | "down" | "unknown";
  marketData: "fresh" | "stale" | "unknown";
  brokerSession: "valid" | "expired" | "unknown";
  checkedAt: number;
}

export interface DashboardSummary {
  portfolioValue: number;
  availableCapital: number;
  todayPnl: number;
  overallPnl: number;
  currentDrawdownPct: number;
  openPositions: number;
  regime: MarketRegime;
  aiStatus: "ACTIVE" | "DEGRADED" | "DISABLED";
  mode: TradingMode;
  riskUtilisationPct: number;
  dailyLossRemaining: number;
  health: SystemHealth;
}
