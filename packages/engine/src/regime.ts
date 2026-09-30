import type { MarketRegime } from "@atb/shared-types";
import type { FeatureFrame } from "./features/frame";

export interface RegimeResult {
  regime: MarketRegime;
  reasons: Record<string, string>;
}

/** Percentile rank of x[i] within the previous `lookback` values of x (causal). */
function pctRank(x: ArrayLike<number>, i: number, lookback: number): number {
  let below = 0;
  let count = 0;
  for (let j = Math.max(0, i - lookback); j < i; j++) {
    const v = x[j]!;
    if (Number.isNaN(v)) continue;
    count++;
    if (v < x[i]!) below++;
  }
  return count > 20 ? below / count : Number.NaN;
}

export function detectRegime(f: FeatureFrame, i: number): RegimeResult {
  if (!f.ready(i)) return { regime: "UNKNOWN", reasons: { data: "indicators warming up" } };
  const volRank = pctRank(f.atrPct, i, 200);
  const adxV = f.adx14[i]!;
  const trendAtr = (f.ema20[i]! - f.ema50[i]!) / f.atr14[i]!;
  const lastMove = Math.abs(f.logRet[i]!);
  const rvol = f.rvol20[i]!;
  const reasons: Record<string, string> = {
    trend: `ADX ${adxV.toFixed(1)}, (EMA20-EMA50)/ATR ${trendAtr.toFixed(2)}, HTF ${f.htfTrend[i]}`,
    volatility: `ATR% rank ${Number.isNaN(volRank) ? "n/a" : (volRank * 100).toFixed(0)}`,
  };

  if (rvol > 0 && lastMove > 6 * rvol) {
    reasons.abnormal = `last bar move ${(lastMove * 100).toFixed(2)}% > 6x realized vol`;
    return { regime: "ABNORMAL", reasons };
  }
  if (volRank > 0.92) return { regime: "HIGH_VOLATILITY", reasons };

  const bull = f.ema20[i]! > f.ema50[i]! && f.plusDI[i]! > f.minusDI[i]!;
  const bear = f.ema20[i]! < f.ema50[i]! && f.minusDI[i]! > f.plusDI[i]!;
  const htf = f.htfTrend[i]!;
  if (adxV >= 25 && bull) return { regime: trendAtr > 1 && htf === 1 ? "STRONG_BULL" : "WEAK_BULL", reasons };
  if (adxV >= 25 && bear)
    return { regime: trendAtr < -1 && htf === -1 ? "STRONG_BEAR" : "WEAK_BEAR", reasons };
  if (adxV >= 20 && bull) return { regime: "WEAK_BULL", reasons };
  if (adxV >= 20 && bear) return { regime: "WEAK_BEAR", reasons };
  if (volRank < 0.1 && adxV < 20) return { regime: "LOW_VOLATILITY", reasons };
  return { regime: "SIDEWAYS", reasons };
}
