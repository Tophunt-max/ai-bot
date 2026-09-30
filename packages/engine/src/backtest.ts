import type { Candle, Instrument, ProductType, RiskLimits, Side } from "@atb/shared-types";
import {
  DEFAULT_COST_RATES,
  DEFAULT_LIMITS,
  DEFAULT_SESSION,
  estimateCosts,
  evaluateTrade,
  protectedLimitPrice,
  sessionPhase,
  toIst,
  type CostRates,
  type SessionConfig,
} from "@atb/trading-core";
import { DEFAULT_ENSEMBLE, evaluateEnsemble, type EnsembleConfig, type MetaScorer } from "./ensemble";
import { FeatureFrame } from "./features/frame";
import { computeMetrics, type ClosedTrade, type EquityPoint, type Metrics } from "./metrics";
import { DEFAULT_EXIT_POLICY, onBar, openTrade, type ExitPolicy, type ManagedTrade } from "./trade-manager";

export interface BacktestConfig {
  initialCapital: number;
  timeframeMs: number;
  limits: RiskLimits;
  product: ProductType;
  /** Margin required as a fraction of notional (1 = cash delivery, ~0.2 = 5x intraday, ~0.15 futures). */
  marginFraction: number;
  slippageBps: number;
  costRates: CostRates;
  session: SessionConfig;
  ensemble: EnsembleConfig;
  exitPolicy: ExitPolicy;
  /** Max share of a bar's volume we may take (partial fills beyond). */
  participationPct: number;
  minRewardRisk: number;
  maxStopDistancePct: number;
  /** Only open trades inside [tradeFrom, tradeTo] — earlier bars are indicator warm-up. */
  tradeFrom?: number;
  tradeTo?: number;
  meta?: { scorer: MetaScorer; minProbability: number };
  modelVersion: string;
}

export const DEFAULT_BACKTEST: Omit<BacktestConfig, "timeframeMs"> = {
  initialCapital: 1_000_000,
  limits: DEFAULT_LIMITS,
  product: "INTRADAY",
  marginFraction: 0.2,
  slippageBps: 3,
  costRates: DEFAULT_COST_RATES,
  session: DEFAULT_SESSION,
  ensemble: DEFAULT_ENSEMBLE,
  exitPolicy: DEFAULT_EXIT_POLICY,
  participationPct: 10,
  minRewardRisk: 1.5,
  maxStopDistancePct: 5,
  modelVersion: "rules-ensemble-1.0.0",
};

export interface SeriesInput {
  instrument: Instrument;
  candles: Candle[];
}

export interface SignalLog {
  t: number;
  instrumentId: string;
  decision: string;
  approved: boolean;
  failedCheck?: string;
}

export interface BacktestResult {
  trades: ClosedTrade[];
  equity: EquityPoint[];
  metrics: Metrics;
  signals: { total: number; approved: number; rejectedBy: Record<string, number> };
  signalLog: SignalLog[];
}

interface OpenState {
  trade: ManagedTrade;
  strategy: string;
  regime: string;
  quality: number;
  riskAmount: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  exitNotional: number;
  exitQty: number;
  lastReason: string;
}

interface Pending {
  side: Side;
  qty: number;
  refPrice: number;
  stop: number;
  targets: number[];
  strategy: string;
  regime: string;
  quality: number;
}

/**
 * Event-driven backtester. Decisions are taken on bar CLOSE and executed at the NEXT bar's
 * OPEN as a protected LIMIT order (no look-ahead, no MARKET orders). Uses the same risk
 * gateway, cost model, ensemble and trade manager as live trading.
 */
export function runBacktest(
  series: readonly SeriesInput[],
  cfgIn: Partial<BacktestConfig> & { timeframeMs: number },
): BacktestResult {
  const cfg: BacktestConfig = { ...DEFAULT_BACKTEST, ...cfgIn };
  const frames = series.map((s) => new FeatureFrame(s.candles));
  const events: Array<[number, number, number]> = [];
  series.forEach((s, k) => s.candles.forEach((c, i) => events.push([c.t, k, i])));
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let cash = cfg.initialCapital;
  let peak = cfg.initialCapital;
  let dailyPnl = 0;
  let weeklyPnl = 0;
  let day = "";
  const open = new Map<number, OpenState>();
  const pending = new Map<number, Pending>();
  const lastClose = new Map<number, number>();
  const trades: ClosedTrade[] = [];
  const equity: EquityPoint[] = [];
  const signalLog: SignalLog[] = [];
  const rejectedBy: Record<string, number> = {};
  let totalSignals = 0;
  let approvedSignals = 0;
  let seq = 0;

  const costOf = (side: Side, qty: number, price: number, k: number) =>
    estimateCosts(
      {
        side,
        quantity: qty,
        price,
        instrumentType: series[k]!.instrument.instrumentType,
        product: cfg.product,
      },
      cfg.costRates,
    ).total;

  const markToMarket = () => {
    let unreal = 0;
    for (const [k, st] of open) {
      const px = lastClose.get(k) ?? st.trade.entry;
      unreal += (st.trade.side === "BUY" ? 1 : -1) * (px - st.trade.entry) * st.trade.qty;
    }
    return cash + unreal;
  };

  const finalize = (k: number, st: OpenState, closedAt: number) => {
    const net = st.grossPnl - st.fees;
    const tr = st.trade;
    const closed: ClosedTrade = {
      id: tr.id,
      instrumentId: tr.instrumentId,
      side: tr.side,
      strategy: st.strategy,
      regime: st.regime,
      quality: st.quality,
      qty: tr.initialQty,
      entry: tr.entry,
      exit: st.exitQty > 0 ? st.exitNotional / st.exitQty : tr.entry,
      stop: tr.initialStop,
      riskAmount: st.riskAmount,
      grossPnl: st.grossPnl,
      fees: st.fees,
      slippage: st.slippage,
      netPnl: net,
      rMultiple: st.riskAmount > 0 ? net / st.riskAmount : 0,
      mfe: tr.mfe,
      mae: tr.mae,
      openedAt: tr.openedAt,
      closedAt,
      barsHeld: tr.barsHeld,
      exitReason: st.lastReason,
    };
    trades.push(closed);
    open.delete(k);
  };

  const applyExit = (k: number, st: OpenState, reason: string, qty: number, rawPrice: number) => {
    const tr = st.trade;
    const long = tr.side === "BUY";
    const exitSide: Side = long ? "SELL" : "BUY";
    // Stop/time exits pay slippage; target exits are resting limits (no slippage).
    const slip = reason.startsWith("TP") ? 0 : (rawPrice * cfg.slippageBps) / 10_000;
    const price = long ? rawPrice - slip : rawPrice + slip;
    const pnl = (long ? 1 : -1) * (price - tr.entry) * qty;
    const fee = costOf(exitSide, qty, price, k);
    cash += pnl - fee;
    dailyPnl += pnl - fee;
    weeklyPnl += pnl - fee;
    st.grossPnl += pnl;
    st.fees += fee;
    st.slippage += slip * qty;
    st.exitNotional += price * qty;
    st.exitQty += qty;
    st.lastReason = reason;
  };

  for (const [t, k, i] of events) {
    const s = series[k]!;
    const f = frames[k]!;
    const bar = s.candles[i]!;
    const ist = toIst(t);
    if (ist.date !== day) {
      if (day && ist.weekday === 1) weeklyPnl = 0;
      day = ist.date;
      dailyPnl = 0;
    }

    // 1) Fill pending entry at this bar's open (protected LIMIT from the signal bar's close).
    const pend = pending.get(k);
    if (pend) {
      pending.delete(k);
      const limit = protectedLimitPrice(
        pend.refPrice,
        pend.side,
        s.instrument.instrumentType,
        s.instrument.tickSize,
      );
      const long = pend.side === "BUY";
      const marketable = long ? bar.o <= limit : bar.o >= limit;
      const slip = (bar.o * cfg.slippageBps) / 10_000;
      const fillPx = long ? Math.min(limit, bar.o + slip) : Math.max(limit, bar.o - slip);
      const protective = long ? pend.stop < fillPx : pend.stop > fillPx;
      const maxQty =
        Math.floor((bar.v * cfg.participationPct) / 100 / s.instrument.lotSize) * s.instrument.lotSize;
      const qty = Math.min(pend.qty, maxQty > 0 ? maxQty : pend.qty);
      if (marketable && protective && qty > 0) {
        const fee = costOf(pend.side, qty, fillPx, k);
        cash -= fee;
        dailyPnl -= fee;
        weeklyPnl -= fee;
        const trade = openTrade({
          id: `bt${++seq}`,
          instrumentId: s.instrument.id,
          side: pend.side,
          lotSize: s.instrument.lotSize,
          qty,
          entry: fillPx,
          stop: pend.stop,
          targets: pend.targets,
          openedAt: t,
          intraday: cfg.product === "INTRADAY",
        });
        open.set(k, {
          trade,
          strategy: pend.strategy,
          regime: pend.regime,
          quality: pend.quality,
          riskAmount: Math.abs(fillPx - pend.stop) * qty,
          grossPnl: 0,
          fees: fee,
          slippage: slip * qty,
          exitNotional: 0,
          exitQty: 0,
          lastReason: "",
        });
      }
    }

    // 2) Manage open trade with this bar.
    const closeTime = t + cfg.timeframeMs;
    const phase = sessionPhase(closeTime - 1, cfg.session);
    const nextBar = s.candles[i + 1];
    const lastBarOfDay = !nextBar || toIst(nextBar.t).date !== ist.date;
    const st = open.get(k);
    if (st) {
      const fills = onBar(
        st.trade,
        {
          t,
          o: bar.o,
          h: bar.h,
          l: bar.l,
          c: bar.c,
          atr: f.atr14[i]!,
          squareOff: phase === "SQUARE_OFF" || phase === "CLOSED" || lastBarOfDay,
        },
        cfg.exitPolicy,
      );
      for (const x of fills) applyExit(k, st, x.reason, x.qty, x.price);
      if (st.trade.qty <= 0) finalize(k, st, closeTime);
    }
    lastClose.set(k, bar.c);

    const eq = markToMarket();
    peak = Math.max(peak, eq);
    equity.push({ t: closeTime, equity: eq });

    // 3) New signal on this bar's close.
    const inWindow =
      (cfg.tradeFrom === undefined || t >= cfg.tradeFrom) && (cfg.tradeTo === undefined || t <= cfg.tradeTo);
    if (!inWindow || open.has(k) || pending.has(k) || !nextBar || lastBarOfDay) continue;
    const intradayOk = cfg.product !== "INTRADAY" || phase === "OPEN";
    if (!intradayOk) continue;

    const { signal } = evaluateEnsemble(
      f,
      i,
      { instrumentId: s.instrument.id, modelVersion: cfg.modelVersion, now: closeTime },
      cfg.ensemble,
      undefined,
      cfg.meta,
    );
    if (signal.decision !== "BUY" && signal.decision !== "SELL") continue;
    totalSignals++;

    let gross = 0;
    for (const [kk, o] of open) gross += (lastClose.get(kk) ?? o.trade.entry) * o.trade.qty;
    const usedMargin = gross * cfg.marginFraction;
    const risk = evaluateTrade(
      {
        instrument: s.instrument,
        decision: signal.decision,
        entry: signal.entry,
        stop: signal.stop,
        targets: signal.targets,
      },
      {
        mode: "PAPER",
        killSwitchActive: false,
        sessionAllowsEntry: true,
        now: closeTime,
        lastMarketDataAt: closeTime,
        maxDataStalenessMs: cfg.timeframeMs,
        limits: cfg.limits,
        state: {
          equity: eq,
          peakEquity: peak,
          dailyRealisedPnl: dailyPnl,
          weeklyRealisedPnl: weeklyPnl,
          openRisk: 0,
          openPositions: open.size,
          tradingLocked: false,
          updatedAt: closeTime,
        },
        availableMargin: Math.max(0, eq - usedMargin),
        marginPerUnit: signal.entry * cfg.marginFraction,
        symbolExposure: 0,
        correlatedExposure: gross,
        grossExposure: gross,
        minRewardRisk: cfg.minRewardRisk,
        maxStopDistancePct: cfg.maxStopDistancePct,
      },
    );
    signalLog.push({
      t: closeTime,
      instrumentId: s.instrument.id,
      decision: signal.decision,
      approved: risk.approved,
      failedCheck: risk.failedCheck,
    });
    if (!risk.approved) {
      rejectedBy[risk.failedCheck ?? "UNKNOWN"] = (rejectedBy[risk.failedCheck ?? "UNKNOWN"] ?? 0) + 1;
      continue;
    }
    approvedSignals++;
    const agreeing = signal.reasons.strategyAgreement?.split(" → ")[0] ?? "";
    pending.set(k, {
      side: signal.decision,
      qty: risk.quantity,
      refPrice: signal.entry,
      stop: signal.stop,
      targets: signal.targets,
      strategy: agreeing,
      regime: signal.regime,
      quality: signal.quality,
    });
  }

  // Close anything still open at the last known price.
  for (const [k, st] of [...open]) {
    applyExit(k, st, "END", st.trade.qty, lastClose.get(k) ?? st.trade.entry);
    st.trade.qty = 0;
    finalize(k, st, equity.at(-1)?.t ?? 0);
  }
  if (equity.length) equity[equity.length - 1] = { t: equity.at(-1)!.t, equity: cash };

  return {
    trades,
    equity,
    metrics: computeMetrics(trades, equity, cfg.initialCapital, cfg.limits.maxRiskPerTradePct),
    signals: { total: totalSignals, approved: approvedSignals, rejectedBy },
    signalLog,
  };
}
