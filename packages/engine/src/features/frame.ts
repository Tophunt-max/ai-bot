import type { Candle } from "@atb/shared-types";
import {
  adx,
  atr,
  bollinger,
  confirmedSwings,
  donchianPrev,
  ema,
  logReturns,
  macd,
  realizedVol,
  relativeVolume,
  rsi,
  sma,
  type Series,
} from "./indicators";

export const FEATURES_VERSION = "f-1.0.0";

/** Column-oriented candle store + all causal indicators. Build once, read by index. */
export class FeatureFrame {
  readonly n: number;
  readonly t: Float64Array;
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
  readonly v: Float64Array;

  readonly ema9: Series;
  readonly ema20: Series;
  readonly ema50: Series;
  readonly ema200: Series;
  readonly sma20: Series;
  readonly rsi14: Series;
  readonly macdHist: Series;
  readonly atr14: Series;
  readonly atrPct: Series;
  readonly adx14: Series;
  readonly plusDI: Series;
  readonly minusDI: Series;
  readonly bbUpper: Series;
  readonly bbLower: Series;
  readonly bbWidth: Series;
  readonly bbWidthAvg: Series;
  readonly donHigh20: Series;
  readonly donLow20: Series;
  readonly rvol20: Series;
  readonly relVolume: Series;
  readonly logRet: Series;
  readonly swingHigh: Series;
  readonly swingLow: Series;
  /** Higher-timeframe (e.g. 4x base) EMA20 slope sign, aligned to CLOSED HTF bars only. */
  readonly htfTrend: Float64Array;

  constructor(
    readonly candles: readonly Candle[],
    htfFactor = 4,
  ) {
    const n = candles.length;
    this.n = n;
    this.t = Float64Array.from(candles, (x) => x.t);
    this.o = Float64Array.from(candles, (x) => x.o);
    this.h = Float64Array.from(candles, (x) => x.h);
    this.l = Float64Array.from(candles, (x) => x.l);
    this.c = Float64Array.from(candles, (x) => x.c);
    this.v = Float64Array.from(candles, (x) => x.v);

    this.ema9 = ema(this.c, 9);
    this.ema20 = ema(this.c, 20);
    this.ema50 = ema(this.c, 50);
    this.ema200 = ema(this.c, 200);
    this.sma20 = sma(this.c, 20);
    this.rsi14 = rsi(this.c, 14);
    this.macdHist = macd(this.c).hist;
    this.atr14 = atr(this.h, this.l, this.c, 14);
    this.atrPct = Float64Array.from(this.atr14, (x, j) => x / this.c[j]!);
    const a = adx(this.h, this.l, this.c, 14);
    this.adx14 = a.adx;
    this.plusDI = a.plusDI;
    this.minusDI = a.minusDI;
    const bb = bollinger(this.c, 20, 2);
    this.bbUpper = bb.upper;
    this.bbLower = bb.lower;
    this.bbWidth = bb.width;
    this.bbWidthAvg = sma(
      Float64Array.from(bb.width, (x) => (Number.isNaN(x) ? 0 : x)),
      50,
    );
    const d = donchianPrev(this.h, this.l, 20);
    this.donHigh20 = d.upper;
    this.donLow20 = d.lower;
    this.rvol20 = realizedVol(this.c, 20);
    this.relVolume = relativeVolume(this.v, 20);
    this.logRet = logReturns(this.c);
    const sw = confirmedSwings(this.h, this.l, 3);
    this.swingHigh = sw.swingHigh;
    this.swingLow = sw.swingLow;
    this.htfTrend = higherTimeframeTrend(this.c, htfFactor);
  }

  /** True once long indicators are warmed up at bar i. */
  ready(i: number): boolean {
    return i >= 60 && !Number.isNaN(this.adx14[i]!) && !Number.isNaN(this.ema50[i]!) && this.atr14[i]! > 0;
  }

  /** Numeric feature vector at bar i (for the ML meta-labeler). Only uses data <= i. */
  vector(i: number): Record<string, number> {
    const c = this.c[i]!;
    const atrV = this.atr14[i]!;
    return {
      ret1: this.logRet[i]!,
      ret5: i >= 5 ? Math.log(c / this.c[i - 5]!) : Number.NaN,
      ret20: i >= 20 ? Math.log(c / this.c[i - 20]!) : Number.NaN,
      ema20_50_atr: (this.ema20[i]! - this.ema50[i]!) / atrV,
      close_ema20_atr: (c - this.ema20[i]!) / atrV,
      rsi14: this.rsi14[i]!,
      macd_hist_atr: this.macdHist[i]! / atrV,
      adx14: this.adx14[i]!,
      di_diff: this.plusDI[i]! - this.minusDI[i]!,
      atr_pct: atrV / c,
      rvol20: this.rvol20[i]!,
      bb_width: this.bbWidth[i]!,
      bb_squeeze: this.bbWidthAvg[i]! > 0 ? this.bbWidth[i]! / this.bbWidthAvg[i]! : Number.NaN,
      rel_volume: this.relVolume[i]!,
      dist_don_high_atr: (this.donHigh20[i]! - c) / atrV,
      dist_don_low_atr: (c - this.donLow20[i]!) / atrV,
      htf_trend: this.htfTrend[i]!,
      body_pct: (c - this.o[i]!) / Math.max(1e-9, this.h[i]! - this.l[i]!),
    };
  }
}

/**
 * Resample closes into blocks of `factor` bars. For base bar i we may only use HTF bars that
 * CLOSED at or before i: block b covers [b*f, b*f+f-1]; it is known from index b*f+f-1 onward.
 * Returns +1 (EMA rising), -1 (falling), 0/NaN otherwise.
 */
export function higherTimeframeTrend(c: ArrayLike<number>, factor: number, period = 20): Float64Array {
  const n = c.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const blocks = Math.floor(n / factor);
  const htfClose = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) htfClose[b] = c[b * factor + factor - 1]!;
  const e = ema(htfClose, period);
  for (let i = 0; i < n; i++) {
    const lastClosed = Math.floor((i + 1) / factor) - 1;
    if (lastClosed < 1) continue;
    const cur = e[lastClosed]!;
    const prev = e[lastClosed - 1]!;
    if (Number.isNaN(cur) || Number.isNaN(prev)) continue;
    out[i] = cur > prev ? 1 : cur < prev ? -1 : 0;
  }
  return out;
}
