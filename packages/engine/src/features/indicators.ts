/**
 * Causal indicators: value[i] depends only on inputs[0..i]. NaN until warm-up completes.
 * All functions are O(n) over full arrays so the backtester and the live engine share code.
 */
export type Series = Float64Array;

const nanArray = (n: number) => new Float64Array(n).fill(Number.NaN);

export function sma(x: ArrayLike<number>, period: number): Series {
  const out = nanArray(x.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i]!;
    if (i >= period) sum -= x[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(x: ArrayLike<number>, period: number): Series {
  const out = nanArray(x.length);
  const k = 2 / (period + 1);
  let prev = Number.NaN;
  let seed = 0;
  for (let i = 0; i < x.length; i++) {
    if (i < period) {
      seed += x[i]!;
      if (i === period - 1) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = x[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder smoothing (RMA), used by RSI/ATR/ADX. */
export function rma(x: ArrayLike<number>, period: number): Series {
  const out = nanArray(x.length);
  let prev = Number.NaN;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    if (Number.isNaN(v)) continue;
    if (count < period) {
      seed += v;
      count++;
      if (count === period) {
        prev = seed / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

export function trueRange(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>): Series {
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const pc = i > 0 ? c[i - 1]! : c[i]!;
    out[i] = Math.max(h[i]! - l[i]!, Math.abs(h[i]! - pc), Math.abs(l[i]! - pc));
  }
  return out;
}

export function atr(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, period = 14): Series {
  return rma(trueRange(h, l, c), period);
}

export function rsi(c: ArrayLike<number>, period = 14): Series {
  const up = new Float64Array(c.length).fill(Number.NaN);
  const dn = new Float64Array(c.length).fill(Number.NaN);
  for (let i = 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    up[i] = Math.max(d, 0);
    dn[i] = Math.max(-d, 0);
  }
  const au = rma(up, period);
  const ad = rma(dn, period);
  const out = nanArray(c.length);
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(au[i]!) || Number.isNaN(ad[i]!)) continue;
    out[i] = ad[i] === 0 ? 100 : 100 - 100 / (1 + au[i]! / ad[i]!);
  }
  return out;
}

export function macd(c: ArrayLike<number>, fast = 12, slow = 26, signal = 9) {
  const f = ema(c, fast);
  const s = ema(c, slow);
  const line = nanArray(c.length);
  for (let i = 0; i < c.length; i++) line[i] = f[i]! - s[i]!;
  const firstValid = line.findIndex((v) => !Number.isNaN(v));
  const sig = nanArray(c.length);
  if (firstValid >= 0) {
    const tail = ema(line.subarray(firstValid), signal);
    sig.set(tail, firstValid);
  }
  const hist = nanArray(c.length);
  for (let i = 0; i < c.length; i++) hist[i] = line[i]! - sig[i]!;
  return { line, signal: sig, hist };
}

/** ADX with +DI/-DI (Wilder). */
export function adx(h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, period = 14) {
  const n = h.length;
  const plusDM = new Float64Array(n).fill(Number.NaN);
  const minusDM = new Float64Array(n).fill(Number.NaN);
  const tr = new Float64Array(n).fill(Number.NaN);
  const rawTr = trueRange(h, l, c);
  for (let i = 1; i < n; i++) {
    const upMove = h[i]! - h[i - 1]!;
    const downMove = l[i - 1]! - l[i]!;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = rawTr[i]!;
  }
  const atrS = rma(tr, period);
  const pdm = rma(plusDM, period);
  const mdm = rma(minusDM, period);
  const plusDI = nanArray(n);
  const minusDI = nanArray(n);
  const dx = nanArray(n);
  for (let i = 0; i < n; i++) {
    if (!(atrS[i]! > 0)) continue;
    plusDI[i] = (100 * pdm[i]!) / atrS[i]!;
    minusDI[i] = (100 * mdm[i]!) / atrS[i]!;
    const sum = plusDI[i]! + minusDI[i]!;
    dx[i] = sum > 0 ? (100 * Math.abs(plusDI[i]! - minusDI[i]!)) / sum : 0;
  }
  return { adx: rma(dx, period), plusDI, minusDI };
}

export function bollinger(c: ArrayLike<number>, period = 20, mult = 2) {
  const mid = sma(c, period);
  const upper = nanArray(c.length);
  const lower = nanArray(c.length);
  const width = nanArray(c.length);
  for (let i = period - 1; i < c.length; i++) {
    let ss = 0;
    for (let j = i - period + 1; j <= i; j++) ss += (c[j]! - mid[i]!) ** 2;
    const sd = Math.sqrt(ss / period);
    upper[i] = mid[i]! + mult * sd;
    lower[i] = mid[i]! - mult * sd;
    width[i] = mid[i]! > 0 ? (upper[i]! - lower[i]!) / mid[i]! : Number.NaN;
  }
  return { mid, upper, lower, width };
}

/** Highest high / lowest low of the PREVIOUS `period` bars (excludes current bar → breakout-safe). */
export function donchianPrev(h: ArrayLike<number>, l: ArrayLike<number>, period = 20) {
  const upper = nanArray(h.length);
  const lower = nanArray(h.length);
  for (let i = period; i < h.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (h[j]! > hi) hi = h[j]!;
      if (l[j]! < lo) lo = l[j]!;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

export function logReturns(c: ArrayLike<number>): Series {
  const out = nanArray(c.length);
  for (let i = 1; i < c.length; i++) out[i] = Math.log(c[i]! / c[i - 1]!);
  return out;
}

/** Rolling std of log returns (per bar). */
export function realizedVol(c: ArrayLike<number>, window = 20): Series {
  const r = logReturns(c);
  const out = nanArray(c.length);
  for (let i = window; i < c.length; i++) {
    let m = 0;
    for (let j = i - window + 1; j <= i; j++) m += r[j]!;
    m /= window;
    let ss = 0;
    for (let j = i - window + 1; j <= i; j++) ss += (r[j]! - m) ** 2;
    out[i] = Math.sqrt(ss / (window - 1));
  }
  return out;
}

export function relativeVolume(v: ArrayLike<number>, window = 20): Series {
  const avgPrev = nanArray(v.length);
  for (let i = window; i < v.length; i++) {
    let s = 0;
    for (let j = i - window; j < i; j++) s += v[j]!;
    avgPrev[i] = s / window;
  }
  const out = nanArray(v.length);
  for (let i = 0; i < v.length; i++) out[i] = avgPrev[i]! > 0 ? v[i]! / avgPrev[i]! : Number.NaN;
  return out;
}

/**
 * Fractal swing points confirmed `k` bars later. swingHigh[i] = price of the most recent swing
 * high that was CONFIRMED at or before bar i (so no look-ahead).
 */
export function confirmedSwings(h: ArrayLike<number>, l: ArrayLike<number>, k = 3) {
  const n = h.length;
  const swingHigh = nanArray(n);
  const swingLow = nanArray(n);
  let lastHigh = Number.NaN;
  let lastLow = Number.NaN;
  for (let i = 0; i < n; i++) {
    const p = i - k; // candidate pivot, now confirmable
    if (p >= k) {
      let isHigh = true;
      let isLow = true;
      for (let j = p - k; j <= p + k; j++) {
        if (j === p) continue;
        if (h[j]! >= h[p]!) isHigh = false;
        if (l[j]! <= l[p]!) isLow = false;
      }
      if (isHigh) lastHigh = h[p]!;
      if (isLow) lastLow = l[p]!;
    }
    swingHigh[i] = lastHigh;
    swingLow[i] = lastLow;
  }
  return { swingHigh, swingLow };
}
