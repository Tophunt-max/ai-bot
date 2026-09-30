import { canShort } from "@atb/shared-types";
import type {
  Instrument,
  ProductType,
  RiskCheckResult,
  RiskLimits,
  RiskState,
  SignalDecision,
  TradingMode,
} from "@atb/shared-types";
import { calculatePositionSize } from "./sizing";

export interface RiskContext {
  mode: TradingMode;
  killSwitchActive: boolean;
  sessionAllowsEntry: boolean;
  now: number;
  lastMarketDataAt: number;
  maxDataStalenessMs: number;
  limits: RiskLimits;
  state: RiskState;
  availableMargin: number;
  marginPerUnit: number;
  /** current gross exposure (INR) in this symbol and in its correlation cluster */
  symbolExposure: number;
  correlatedExposure: number;
  grossExposure: number;
  minRewardRisk: number;
  maxStopDistancePct: number;
  /** Product of the entry order; used to block impossible shorts (crypto spot, cash delivery). */
  product?: ProductType;
}

export interface TradeProposal {
  instrument: Instrument;
  decision: SignalDecision;
  entry: number;
  stop: number;
  targets: number[];
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxRiskPerTradePct: 0.5,
  maxDailyLossPct: 2,
  maxWeeklyLossPct: 4,
  maxDrawdownPct: 10,
  maxOpenPositions: 3,
  maxSymbolExposurePct: 30,
  maxCorrelatedExposurePct: 50,
  maxLeverage: 2,
  maxPositionValue: 300_000,
  maxOrdersPerMinute: 30,
  maxOrdersPerSecond: 5,
};

type Check = { name: string; fn: () => string | null };

const reject = (failedCheck: string, reasons: string[]): RiskCheckResult => ({
  approved: false,
  quantity: 0,
  failedCheck,
  reasons,
});

/**
 * Deterministic, AI-independent gate. The FIRST failing check rejects the order.
 * Any missing/NaN input fails closed.
 */
export function evaluateTrade(p: TradeProposal, c: RiskContext): RiskCheckResult {
  const eq = c.state.equity;
  // Loss as a positive % of equity; NaN/unknown equity => Infinity (fails closed).
  const lossPct = (pnl: number) =>
    eq > 0 && Number.isFinite(pnl) ? (Math.max(0, -pnl) / eq) * 100 : Infinity;
  const isLong = p.decision === "BUY";
  const reasons: string[] = [];

  const checks: Check[] = [
    { name: "KILL_SWITCH", fn: () => (c.killSwitchActive ? "kill switch active" : null) },
    {
      name: "TRADING_LOCK",
      fn: () => (c.state.tradingLocked ? `trading locked: ${c.state.lockReason ?? "unknown"}` : null),
    },
    {
      name: "MODE",
      fn: () =>
        c.mode === "SAFE_MODE" || c.mode === "BACKTEST" ? `mode ${c.mode} cannot open trades` : null,
    },
    {
      name: "DECISION",
      fn: () =>
        p.decision === "BUY" || p.decision === "SELL" ? null : `decision ${p.decision} is not an entry`,
    },
    {
      name: "SHORT_NOT_ALLOWED",
      fn: () =>
        p.decision === "SELL" && !canShort(p.instrument, c.product ?? "INTRADAY")
          ? `${p.instrument.instrumentType}/${c.product ?? "INTRADAY"} cannot be sold short`
          : null,
    },
    {
      name: "SESSION",
      fn: () => (c.sessionAllowsEntry ? null : "market session does not allow new entries"),
    },
    {
      name: "DATA_FRESHNESS",
      fn: () =>
        Number.isFinite(c.lastMarketDataAt) && c.now - c.lastMarketDataAt <= c.maxDataStalenessMs
          ? null
          : "market data stale",
    },
    { name: "EQUITY", fn: () => (eq > 0 ? null : "equity unknown or non-positive") },
    {
      name: "OPEN_POSITIONS",
      fn: () =>
        c.state.openPositions < c.limits.maxOpenPositions
          ? null
          : `open positions ${c.state.openPositions} >= ${c.limits.maxOpenPositions}`,
    },
    {
      name: "DAILY_LOSS",
      fn: () =>
        lossPct(c.state.dailyRealisedPnl) < c.limits.maxDailyLossPct ? null : "daily loss limit reached",
    },
    {
      name: "WEEKLY_LOSS",
      fn: () =>
        lossPct(c.state.weeklyRealisedPnl) < c.limits.maxWeeklyLossPct ? null : "weekly loss limit reached",
    },
    {
      name: "DRAWDOWN",
      fn: () => {
        const dd = c.state.peakEquity > 0 ? ((c.state.peakEquity - eq) / c.state.peakEquity) * 100 : Infinity;
        return dd < c.limits.maxDrawdownPct ? null : `drawdown ${dd.toFixed(2)}% >= limit`;
      },
    },
    {
      name: "STOP_LOSS",
      fn: () => {
        if (!(p.stop > 0) || !(p.entry > 0)) return "stop/entry missing";
        if (isLong ? p.stop >= p.entry : p.stop <= p.entry) return "stop on wrong side of entry";
        const distPct = (Math.abs(p.entry - p.stop) / p.entry) * 100;
        return distPct <= c.maxStopDistancePct ? null : `stop distance ${distPct.toFixed(2)}% too wide`;
      },
    },
    {
      name: "TAKE_PROFIT",
      fn: () => {
        if (p.targets.length === 0) return "no target";
        if (p.targets.some((t) => (isLong ? t <= p.entry : t >= p.entry)))
          return "target on wrong side of entry";
        // TP1 is a partial/break-even level; reward/risk is judged on the primary target (TP2 when present).
        const primary = p.targets[p.targets.length > 1 ? 1 : 0]!;
        const rr = Math.abs(primary - p.entry) / Math.abs(p.entry - p.stop);
        return rr >= c.minRewardRisk ? null : `reward/risk ${rr.toFixed(2)} < ${c.minRewardRisk}`;
      },
    },
  ];

  for (const check of checks) {
    const failure = check.fn();
    if (failure) return reject(check.name, [...reasons, failure]);
    reasons.push(`${check.name} ok`);
  }

  const symbolHeadroom = (eq * c.limits.maxSymbolExposurePct) / 100 - c.symbolExposure;
  const corrHeadroom = (eq * c.limits.maxCorrelatedExposurePct) / 100 - c.correlatedExposure;
  const leverageHeadroom = eq * c.limits.maxLeverage - c.grossExposure;

  const size = calculatePositionSize({
    equity: eq,
    riskPct: c.limits.maxRiskPerTradePct,
    entry: p.entry,
    stop: p.stop,
    lotSize: p.instrument.lotSize,
    maxPositionValue: c.limits.maxPositionValue,
    availableMargin: c.availableMargin,
    marginPerUnit: c.marginPerUnit,
    maxExposureValue: Math.max(0, Math.min(symbolHeadroom, corrHeadroom, leverageHeadroom)),
    brokerMaxQuantity: p.instrument.freezeQuantity,
  });

  if (size.quantity <= 0) {
    return reject("POSITION_SIZE", [...reasons, `size 0 (limited by ${size.limitedBy})`]);
  }
  const inst = p.instrument;
  if (
    (inst.minQty !== undefined && size.quantity < inst.minQty) ||
    (inst.minNotional !== undefined && size.quantity * p.entry < inst.minNotional)
  ) {
    return reject("BELOW_EXCHANGE_MINIMUM", [
      ...reasons,
      `size ${size.quantity} below exchange minimum (qty ${inst.minQty ?? "-"}, notional ${inst.minNotional ?? "-"})`,
    ]);
  }
  reasons.push(`POSITION_SIZE ok: ${size.quantity} (limited by ${size.limitedBy})`);
  return { approved: true, quantity: size.quantity, reasons };
}
