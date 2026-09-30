import type { StrategyId, StrategySignal } from "@atb/shared-types";
import type { FeatureFrame } from "./features/frame";

/** A strategy only proposes. It can never place orders. */
export interface Strategy {
  id: StrategyId;
  evaluate(f: FeatureFrame, i: number, p?: StrategyParams): StrategySignal | null;
}

export interface StrategyParams {
  /** ATR multiple for the protective stop. */
  stopAtr: number;
  /** Target in multiples of risk (R). */
  targetR: number;
}

export const DEFAULT_PARAMS: Record<StrategyId, StrategyParams> = {
  TREND_FOLLOWING: { stopAtr: 2, targetR: 2.5 },
  MOMENTUM: { stopAtr: 1.5, targetR: 2 },
  BREAKOUT: { stopAtr: 1.5, targetR: 2.5 },
  PULLBACK: { stopAtr: 1.5, targetR: 2 },
  MEAN_REVERSION: { stopAtr: 1.5, targetR: 1.6 },
  VOLATILITY: { stopAtr: 1.5, targetR: 2 },
  RANGE_TRADING: { stopAtr: 1, targetR: 1.8 },
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function build(
  id: StrategyId,
  side: "BUY" | "SELL",
  entry: number,
  stopDistance: number,
  p: StrategyParams,
  quality: number,
  reason: string,
  explicitTarget?: number,
): StrategySignal | null {
  if (!(stopDistance > 0) || !Number.isFinite(entry)) return null;
  const dir = side === "BUY" ? 1 : -1;
  const stop = entry - dir * stopDistance;
  let target = entry + dir * stopDistance * p.targetR;
  if (explicitTarget !== undefined && Number.isFinite(explicitTarget)) target = explicitTarget;
  if (dir * (target - entry) <= 0 || stop <= 0) return null;
  return { strategy: id, signal: side, quality: clamp01(quality), entry, stop, target, reason };
}

const crossedAbove = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) =>
  a[i - 1]! <= b[i - 1]! && a[i]! > b[i]!;
const crossedBelow = (a: ArrayLike<number>, b: ArrayLike<number>, i: number) =>
  a[i - 1]! >= b[i - 1]! && a[i]! < b[i]!;

export const trendFollowing: Strategy = {
  id: "TREND_FOLLOWING",
  evaluate(f, i, p = DEFAULT_PARAMS.TREND_FOLLOWING) {
    const atr = f.atr14[i]!;
    const c = f.c[i]!;
    const adx = f.adx14[i]!;
    if (adx < 20) return null;
    const q = 0.4 + clamp01((adx - 20) / 30) * 0.4 + (f.htfTrend[i] !== 0 ? 0.2 : 0);
    if (crossedAbove(f.ema20, f.ema50, i) && f.htfTrend[i] !== -1 && c > f.ema200[i]!) {
      const structural = Number.isNaN(f.swingLow[i]!) ? Infinity : c - f.swingLow[i]! + 0.2 * atr;
      return build(
        "TREND_FOLLOWING",
        "BUY",
        c,
        Math.min(p.stopAtr * atr, Math.max(atr, structural)),
        p,
        q,
        "EMA20 crossed above EMA50 with ADX>20",
      );
    }
    if (crossedBelow(f.ema20, f.ema50, i) && f.htfTrend[i] !== 1 && c < f.ema200[i]!) {
      const structural = Number.isNaN(f.swingHigh[i]!) ? Infinity : f.swingHigh[i]! - c + 0.2 * atr;
      return build(
        "TREND_FOLLOWING",
        "SELL",
        c,
        Math.min(p.stopAtr * atr, Math.max(atr, structural)),
        p,
        q,
        "EMA20 crossed below EMA50 with ADX>20",
      );
    }
    return null;
  },
};

export const momentum: Strategy = {
  id: "MOMENTUM",
  evaluate(f, i, p = DEFAULT_PARAMS.MOMENTUM) {
    const c = f.c[i]!;
    const atr = f.atr14[i]!;
    const r = f.rsi14[i]!;
    const h = f.macdHist[i]!;
    const hPrev = f.macdHist[i - 1]!;
    const rv = f.relVolume[i]!;
    if (!(rv > 1.2)) return null;
    const q = 0.3 + clamp01((rv - 1.2) / 1.8) * 0.4 + clamp01(Math.abs(r - 50) / 30) * 0.3;
    if (r > 60 && r < 78 && h > 0 && h > hPrev && c > f.ema20[i]! && f.rsi14[i - 1]! <= 60) {
      return build(
        "MOMENTUM",
        "BUY",
        c,
        p.stopAtr * atr,
        p,
        q,
        "RSI crossed 60, MACD histogram rising, volume expansion",
      );
    }
    if (r < 40 && r > 22 && h < 0 && h < hPrev && c < f.ema20[i]! && f.rsi14[i - 1]! >= 40) {
      return build(
        "MOMENTUM",
        "SELL",
        c,
        p.stopAtr * atr,
        p,
        q,
        "RSI crossed below 40, MACD histogram falling, volume expansion",
      );
    }
    return null;
  },
};

export const breakout: Strategy = {
  id: "BREAKOUT",
  evaluate(f, i, p = DEFAULT_PARAMS.BREAKOUT) {
    const c = f.c[i]!;
    const atr = f.atr14[i]!;
    const rv = f.relVolume[i]!;
    const squeezed = f.bbWidthAvg[i - 1]! > 0 && f.bbWidth[i - 1]! / f.bbWidthAvg[i - 1]! < 0.85;
    if (!(rv > 1.5) || !squeezed) return null;
    const q = 0.4 + clamp01((rv - 1.5) / 2) * 0.4 + (f.adx14[i]! > 20 ? 0.2 : 0);
    if (c > f.donHigh20[i]! && f.c[i - 1]! <= f.donHigh20[i - 1]!) {
      return build(
        "BREAKOUT",
        "BUY",
        c,
        p.stopAtr * atr,
        p,
        q,
        "Close above 20-bar high after squeeze on volume",
      );
    }
    if (c < f.donLow20[i]! && f.c[i - 1]! >= f.donLow20[i - 1]!) {
      return build(
        "BREAKOUT",
        "SELL",
        c,
        p.stopAtr * atr,
        p,
        q,
        "Close below 20-bar low after squeeze on volume",
      );
    }
    return null;
  },
};

export const pullback: Strategy = {
  id: "PULLBACK",
  evaluate(f, i, p = DEFAULT_PARAMS.PULLBACK) {
    const c = f.c[i]!;
    const atr = f.atr14[i]!;
    const e20 = f.ema20[i]!;
    const r = f.rsi14[i]!;
    if (f.adx14[i]! < 20) return null;
    const q = 0.5 + clamp01((f.adx14[i]! - 20) / 30) * 0.3 + (f.htfTrend[i] !== 0 ? 0.2 : 0);
    if (e20 > f.ema50[i]! && f.l[i]! <= e20 + 0.2 * atr && c > e20 && c > f.o[i]! && r > 40 && r < 58) {
      const stopDist = Math.max(0.8 * atr, Math.min(p.stopAtr * atr, c - f.l[i]! + 0.5 * atr));
      return build("PULLBACK", "BUY", c, stopDist, p, q, "Uptrend pullback to EMA20 with bullish rejection");
    }
    if (e20 < f.ema50[i]! && f.h[i]! >= e20 - 0.2 * atr && c < e20 && c < f.o[i]! && r < 60 && r > 42) {
      const stopDist = Math.max(0.8 * atr, Math.min(p.stopAtr * atr, f.h[i]! - c + 0.5 * atr));
      return build(
        "PULLBACK",
        "SELL",
        c,
        stopDist,
        p,
        q,
        "Downtrend pullback to EMA20 with bearish rejection",
      );
    }
    return null;
  },
};

export const meanReversion: Strategy = {
  id: "MEAN_REVERSION",
  evaluate(f, i, p = DEFAULT_PARAMS.MEAN_REVERSION) {
    const c = f.c[i]!;
    const atr = f.atr14[i]!;
    const r = f.rsi14[i]!;
    if (f.adx14[i]! > 22) return null;
    const mid = f.sma20[i]!;
    if (c < f.bbLower[i]! && r < 30) {
      return build(
        "MEAN_REVERSION",
        "BUY",
        c,
        p.stopAtr * atr,
        p,
        0.4 + clamp01((30 - r) / 20) * 0.5,
        "Below lower Bollinger band with RSI<30 in non-trending market",
        mid,
      );
    }
    if (c > f.bbUpper[i]! && r > 70) {
      return build(
        "MEAN_REVERSION",
        "SELL",
        c,
        p.stopAtr * atr,
        p,
        0.4 + clamp01((r - 70) / 20) * 0.5,
        "Above upper Bollinger band with RSI>70 in non-trending market",
        mid,
      );
    }
    return null;
  },
};

export const volatility: Strategy = {
  id: "VOLATILITY",
  evaluate(f, i, p = DEFAULT_PARAMS.VOLATILITY) {
    const c = f.c[i]!;
    const atr = f.atr14[i]!;
    const avg = f.bbWidthAvg[i]!;
    if (!(avg > 0)) return null;
    // Expansion bar after a squeeze: width crosses back above its average.
    const expanding = f.bbWidth[i - 1]! < 0.8 * f.bbWidthAvg[i - 1]! && f.bbWidth[i]! >= 0.95 * avg;
    if (!expanding) return null;
    const q = 0.4 + clamp01(Math.abs(f.macdHist[i]! / atr)) * 0.4;
    if (c > f.ema20[i]! && f.macdHist[i]! > 0)
      return build(
        "VOLATILITY",
        "BUY",
        c,
        p.stopAtr * atr,
        p,
        q,
        "Volatility expansion after squeeze, upward bias",
      );
    if (c < f.ema20[i]! && f.macdHist[i]! < 0)
      return build(
        "VOLATILITY",
        "SELL",
        c,
        p.stopAtr * atr,
        p,
        q,
        "Volatility expansion after squeeze, downward bias",
      );
    return null;
  },
};

export const rangeTrading: Strategy = {
  id: "RANGE_TRADING",
  evaluate(f, i, p = DEFAULT_PARAMS.RANGE_TRADING) {
    const c = f.c[i]!;
    const atr = f.atr14[i]!;
    const hi = f.donHigh20[i]!;
    const lo = f.donLow20[i]!;
    if (f.adx14[i]! > 18 || !(hi > lo) || (hi - lo) / atr < 3) return null;
    const mid = (hi + lo) / 2;
    const bullBar = c > f.o[i]!;
    const bearBar = c < f.o[i]!;
    if (f.l[i]! <= lo + 0.3 * atr && bullBar && c > lo) {
      return build(
        "RANGE_TRADING",
        "BUY",
        c,
        Math.max(0.5 * atr, c - lo + p.stopAtr * 0.5 * atr),
        p,
        0.55,
        "Bounce from range support in a non-trending market",
        mid + (hi - mid) * 0.5,
      );
    }
    if (f.h[i]! >= hi - 0.3 * atr && bearBar && c < hi) {
      return build(
        "RANGE_TRADING",
        "SELL",
        c,
        Math.max(0.5 * atr, hi - c + p.stopAtr * 0.5 * atr),
        p,
        0.55,
        "Rejection at range resistance in a non-trending market",
        mid - (mid - lo) * 0.5,
      );
    }
    return null;
  },
};

export const ALL_STRATEGIES: readonly Strategy[] = [
  trendFollowing,
  momentum,
  breakout,
  pullback,
  meanReversion,
  volatility,
  rangeTrading,
];
