import type {
  FinalSignal,
  MarketRegime,
  SignalDecision,
  SignalReasons,
  StrategyId,
  StrategySignal,
} from "@atb/shared-types";
import type { FeatureFrame } from "./features/frame";
import { detectRegime } from "./regime";
import { ALL_STRATEGIES, DEFAULT_PARAMS, type Strategy, type StrategyParams } from "./strategies";

export type RegimeWeights = Record<MarketRegime, Partial<Record<StrategyId, number>>>;

/**
 * Starting weights (0..1). These are PRIORS — the walk-forward optimiser and live performance
 * monitor must validate/override them; they are not assumed to work universally.
 */
export const DEFAULT_REGIME_WEIGHTS: RegimeWeights = {
  STRONG_BULL: {
    TREND_FOLLOWING: 1,
    MOMENTUM: 0.9,
    PULLBACK: 1,
    BREAKOUT: 0.7,
    VOLATILITY: 0.5,
    MEAN_REVERSION: 0.1,
    RANGE_TRADING: 0,
  },
  WEAK_BULL: {
    TREND_FOLLOWING: 0.7,
    MOMENTUM: 0.6,
    PULLBACK: 0.8,
    BREAKOUT: 0.7,
    VOLATILITY: 0.5,
    MEAN_REVERSION: 0.3,
    RANGE_TRADING: 0.2,
  },
  STRONG_BEAR: {
    TREND_FOLLOWING: 1,
    MOMENTUM: 0.9,
    PULLBACK: 1,
    BREAKOUT: 0.7,
    VOLATILITY: 0.5,
    MEAN_REVERSION: 0.1,
    RANGE_TRADING: 0,
  },
  WEAK_BEAR: {
    TREND_FOLLOWING: 0.7,
    MOMENTUM: 0.6,
    PULLBACK: 0.8,
    BREAKOUT: 0.7,
    VOLATILITY: 0.5,
    MEAN_REVERSION: 0.3,
    RANGE_TRADING: 0.2,
  },
  SIDEWAYS: {
    MEAN_REVERSION: 1,
    RANGE_TRADING: 1,
    BREAKOUT: 0.3,
    VOLATILITY: 0.4,
    TREND_FOLLOWING: 0.1,
    MOMENTUM: 0.2,
    PULLBACK: 0.2,
  },
  LOW_VOLATILITY: {
    BREAKOUT: 0.8,
    VOLATILITY: 0.9,
    RANGE_TRADING: 0.6,
    MEAN_REVERSION: 0.5,
    TREND_FOLLOWING: 0.2,
    MOMENTUM: 0.2,
    PULLBACK: 0.2,
  },
  HIGH_VOLATILITY: { TREND_FOLLOWING: 0.3, MOMENTUM: 0.2 },
  ABNORMAL: {},
  UNKNOWN: {},
};

export interface EnsembleConfig {
  weights: RegimeWeights;
  /** Weighted score needed on one side to trade. */
  minScore: number;
  /** Minimum number of strategies agreeing on the chosen side. */
  minAgreeing: number;
  /** Strategies switched off by the owner/monitor. */
  disabled: ReadonlySet<StrategyId>;
  params: Record<StrategyId, StrategyParams>;
  /** Minimum reward/risk of TP2 (main target). */
  minRewardRisk: number;
}

export const DEFAULT_ENSEMBLE: EnsembleConfig = {
  weights: DEFAULT_REGIME_WEIGHTS,
  minScore: 0.35,
  minAgreeing: 1,
  disabled: new Set(),
  params: DEFAULT_PARAMS,
  minRewardRisk: 1.5,
};

/** Optional ML meta-labeler: probability-like score in [0,1] that the candidate succeeds. */
export type MetaScorer = (
  features: Record<string, number>,
  candidate: { side: "BUY" | "SELL"; strategies: StrategyId[] },
) => number | null;

export interface EnsembleOutput {
  signal: FinalSignal;
  candidates: StrategySignal[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function evaluateEnsemble(
  f: FeatureFrame,
  i: number,
  ctx: { instrumentId: string; modelVersion: string; now: number },
  cfg: EnsembleConfig = DEFAULT_ENSEMBLE,
  strategies: readonly Strategy[] = ALL_STRATEGIES,
  meta?: { scorer: MetaScorer; minProbability: number },
): EnsembleOutput {
  const { regime, reasons: regimeReasons } = detectRegime(f, i);
  const base = {
    id: `${ctx.instrumentId}:${f.t[i]}`,
    instrumentId: ctx.instrumentId,
    regime,
    modelVersion: ctx.modelVersion,
    createdAt: ctx.now,
    strategiesTotal: strategies.length,
  };
  const noTrade = (
    why: string,
    decision: SignalDecision = "NO_TRADE",
    candidates: StrategySignal[] = [],
  ): EnsembleOutput => ({
    signal: {
      ...base,
      decision,
      quality: 0,
      qualityBand: "LOW",
      entry: f.c[i]!,
      stop: Number.NaN,
      targets: [],
      strategiesAgreeing: 0,
      reasons: { regime: `${regime}: ${Object.values(regimeReasons).join("; ")}`, strategyAgreement: why },
    },
    candidates,
  });

  if (regime === "UNKNOWN" || regime === "ABNORMAL") return noTrade(`regime ${regime} blocks trading`);

  const weights = cfg.weights[regime];
  const candidates: StrategySignal[] = [];
  for (const s of strategies) {
    if (cfg.disabled.has(s.id) || !(weights[s.id]! > 0)) continue;
    const sig = s.evaluate(f, i, cfg.params[s.id]);
    if (sig) candidates.push(sig);
  }
  if (candidates.length === 0) return noTrade("no strategy setup");

  let buy = 0;
  let sell = 0;
  for (const c of candidates) {
    const w = weights[c.strategy] ?? 0;
    if (c.signal === "BUY") buy += w * c.quality;
    if (c.signal === "SELL") sell += w * c.quality;
  }
  if (buy > 0 && sell > 0 && Math.min(buy, sell) / Math.max(buy, sell) > 0.5) {
    return noTrade(
      `conflicting strategies (buy ${buy.toFixed(2)} vs sell ${sell.toFixed(2)})`,
      "WAIT",
      candidates,
    );
  }
  const side: "BUY" | "SELL" = buy >= sell ? "BUY" : "SELL";
  const agreeing = candidates.filter((c) => c.signal === side);
  const score = side === "BUY" ? buy : sell;
  if (agreeing.length < cfg.minAgreeing)
    return noTrade(`${agreeing.length} agreeing < ${cfg.minAgreeing}`, "WAIT", candidates);
  if (score < cfg.minScore) return noTrade(`score ${score.toFixed(2)} < ${cfg.minScore}`, "WAIT", candidates);

  const entry = f.c[i]!;
  const dir = side === "BUY" ? 1 : -1;
  const stop = median(agreeing.map((a) => a.stop));
  const risk = dir * (entry - stop);
  if (!(risk > 0)) return noTrade("invalid consensus stop", "NO_TRADE", candidates);
  const mainTarget = median(agreeing.map((a) => a.target));
  const rr = (dir * (mainTarget - entry)) / risk;
  if (rr < cfg.minRewardRisk)
    return noTrade(`reward/risk ${rr.toFixed(2)} < ${cfg.minRewardRisk}`, "NO_TRADE", candidates);

  // TP1 = 1R (partial + break-even), TP2 = consensus target, TP3 = runner at 1.5x TP2 distance.
  const targets = [entry + dir * risk, mainTarget, entry + (mainTarget - entry) * 1.5];
  let quality = Math.min(1, score / Math.max(1, agreeing.length) + 0.1 * (agreeing.length - 1));

  const vector = f.vector(i);
  let mlNote = "no ML filter";
  if (meta) {
    const p = meta.scorer(vector, { side, strategies: agreeing.map((a) => a.strategy) });
    if (p === null || !Number.isFinite(p))
      return noTrade("ML filter unavailable — blocking (fail closed)", "NO_TRADE", candidates);
    mlNote = `meta-label score ${p.toFixed(2)} (min ${meta.minProbability})`;
    if (p < meta.minProbability) return noTrade(`ML filter rejected: ${mlNote}`, "NO_TRADE", candidates);
    quality = Math.min(1, 0.5 * quality + 0.5 * p);
  }

  const reasons: SignalReasons = {
    regime: `${regime}: ${regimeReasons.trend}`,
    trend: `EMA20 ${f.ema20[i]!.toFixed(2)} vs EMA50 ${f.ema50[i]!.toFixed(2)}, ADX ${f.adx14[i]!.toFixed(1)}`,
    momentum: `RSI ${f.rsi14[i]!.toFixed(1)}, MACD hist ${f.macdHist[i]!.toFixed(3)}`,
    volatility: `ATR ${f.atr14[i]!.toFixed(2)} (${((f.atr14[i]! / entry) * 100).toFixed(2)}%)`,
    marketStructure: `swing H ${f.swingHigh[i]!.toFixed(2)} / L ${f.swingLow[i]!.toFixed(2)}`,
    strategyAgreement: `${agreeing.map((a) => a.strategy).join(", ")} → ${side}; ${mlNote}`,
    riskReward: `R:R ${rr.toFixed(2)} to TP2`,
    liquidity: `relative volume ${f.relVolume[i]!.toFixed(2)}`,
  };

  return {
    signal: {
      ...base,
      decision: side,
      quality,
      qualityBand: quality >= 0.7 ? "HIGH" : quality >= 0.45 ? "MEDIUM" : "LOW",
      entry,
      stop,
      targets,
      strategiesAgreeing: agreeing.length,
      reasons,
    },
    candidates,
  };
}
