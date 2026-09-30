import type { StrategyId } from "@atb/shared-types";
import { runBacktest, type BacktestConfig, type SeriesInput } from "./backtest";
import { DEFAULT_ENSEMBLE, type EnsembleConfig } from "./ensemble";
import {
  computeMetrics,
  monteCarloDrawdown,
  type ClosedTrade,
  type EquityPoint,
  type Metrics,
} from "./metrics";
import { DEFAULT_PARAMS } from "./strategies";

export interface ParamSet {
  name: string;
  minScore: number;
  stopAtrScale: number;
  targetRScale: number;
}

export const DEFAULT_GRID: ParamSet[] = [
  { name: "base", minScore: 0.35, stopAtrScale: 1, targetRScale: 1 },
  { name: "strict", minScore: 0.5, stopAtrScale: 1, targetRScale: 1 },
  { name: "wide-stop", minScore: 0.35, stopAtrScale: 1.3, targetRScale: 1 },
  { name: "far-target", minScore: 0.35, stopAtrScale: 1, targetRScale: 1.3 },
  { name: "strict-wide", minScore: 0.5, stopAtrScale: 1.3, targetRScale: 1.2 },
];

export function ensembleFor(p: ParamSet, base: EnsembleConfig = DEFAULT_ENSEMBLE): EnsembleConfig {
  const params = Object.fromEntries(
    (Object.keys(DEFAULT_PARAMS) as StrategyId[]).map((id) => [
      id,
      {
        stopAtr: DEFAULT_PARAMS[id].stopAtr * p.stopAtrScale,
        targetR: DEFAULT_PARAMS[id].targetR * p.targetRScale,
      },
    ]),
  ) as EnsembleConfig["params"];
  return { ...base, minScore: p.minScore, params };
}

export interface FoldResult {
  fold: number;
  trainFrom: number;
  trainTo: number;
  testFrom: number;
  testTo: number;
  chosen: string;
  inSample: Metrics;
  outOfSample: Metrics;
}

export interface WalkForwardResult {
  folds: FoldResult[];
  outOfSample: Metrics;
  oosTrades: ClosedTrade[];
  monteCarlo: { p50: number; p95: number; p99: number };
  /** OOS Sharpe / mean IS Sharpe — well below 1 signals overfitting. */
  degradation: number;
  verdict: "PASS" | "FAIL";
  verdictReasons: string[];
}

/** Objective: risk-adjusted, penalise too few trades. Never raw profit. */
function score(m: Metrics, minTrades: number): number {
  if (m.trades < minTrades) return -Infinity;
  return m.sharpe - 0.02 * m.maxDrawdownPct;
}

/**
 * Rolling walk-forward: for each fold pick the best ParamSet on the TRAIN window, then run it
 * untouched on the following TEST window. Only stitched TEST results count.
 */
export function runWalkForward(
  series: readonly SeriesInput[],
  cfg: Partial<BacktestConfig> & { timeframeMs: number },
  opts: { folds?: number; trainFraction?: number; grid?: ParamSet[]; minTradesPerFold?: number } = {},
): WalkForwardResult {
  const folds = opts.folds ?? 4;
  const trainFrac = opts.trainFraction ?? 0.7;
  const grid = opts.grid ?? DEFAULT_GRID;
  const minTrades = opts.minTradesPerFold ?? 5;
  const allT = series.flatMap((s) => s.candles.map((c) => c.t));
  const start = Math.min(...allT);
  const end = Math.max(...allT);
  // Each fold is a window; windows overlap in train, never in test.
  const testSpan = ((end - start) * (1 - trainFrac)) / folds;
  const trainSpan = (end - start) * trainFrac;

  const results: FoldResult[] = [];
  const oosTrades: ClosedTrade[] = [];
  const initial = cfg.initialCapital ?? 1_000_000;

  for (let fIdx = 0; fIdx < folds; fIdx++) {
    const trainFrom = start + fIdx * testSpan;
    const trainTo = trainFrom + trainSpan;
    const testFrom = trainTo;
    const testTo = fIdx === folds - 1 ? end : testFrom + testSpan;

    let best: { p: ParamSet; m: Metrics; s: number } | null = null;
    for (const p of grid) {
      const r = runBacktest(series, {
        ...cfg,
        ensemble: ensembleFor(p, cfg.ensemble),
        tradeFrom: trainFrom,
        tradeTo: trainTo,
      });
      const s = score(r.metrics, minTrades);
      if (!best || s > best.s) best = { p, m: r.metrics, s };
    }
    const chosen = best!.p;
    const oos = runBacktest(series, {
      ...cfg,
      ensemble: ensembleFor(chosen, cfg.ensemble),
      tradeFrom: testFrom,
      tradeTo: testTo,
    });
    oosTrades.push(...oos.trades);
    results.push({
      fold: fIdx + 1,
      trainFrom,
      trainTo,
      testFrom,
      testTo,
      chosen: chosen.name,
      inSample: best!.m,
      outOfSample: oos.metrics,
    });
  }

  oosTrades.sort((a, b) => a.closedAt - b.closedAt);
  const curve: EquityPoint[] = [{ t: start, equity: initial }];
  let eq = initial;
  for (const t of oosTrades) {
    eq += t.netPnl;
    curve.push({ t: t.closedAt, equity: eq });
  }
  const riskPct = cfg.limits?.maxRiskPerTradePct ?? 0.5;
  const oosMetrics = computeMetrics(oosTrades, curve, initial, riskPct);
  const meanIsSharpe = results.reduce((s, r) => s + r.inSample.sharpe, 0) / Math.max(1, results.length);
  const degradation = meanIsSharpe > 0 ? oosMetrics.sharpe / meanIsSharpe : 0;
  const mc = monteCarloDrawdown(
    oosTrades.map((t) => t.rMultiple),
    riskPct,
  );

  const reasons: string[] = [];
  if (oosMetrics.trades < minTrades * folds) reasons.push(`too few OOS trades (${oosMetrics.trades})`);
  if (!(oosMetrics.expectancyR > 0.05))
    reasons.push(`OOS expectancy ${oosMetrics.expectancyR.toFixed(3)}R not > 0.05R after costs`);
  if (!(oosMetrics.profitFactor > 1.15))
    reasons.push(`OOS profit factor ${oosMetrics.profitFactor.toFixed(2)} not > 1.15`);
  if (mc.p95 > 20) reasons.push(`Monte-Carlo p95 drawdown ${mc.p95.toFixed(1)}% > 20%`);
  if (degradation < 0.3) reasons.push(`OOS/IS Sharpe ratio ${degradation.toFixed(2)} < 0.3 (likely overfit)`);

  return {
    folds: results,
    outOfSample: oosMetrics,
    oosTrades,
    monteCarlo: mc,
    degradation,
    verdict: reasons.length === 0 ? "PASS" : "FAIL",
    verdictReasons: reasons,
  };
}
