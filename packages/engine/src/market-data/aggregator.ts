import type { Candle, Tick } from "@atb/shared-types";

const IST_OFFSET_MS = 330 * 60_000;

/**
 * Builds candles from ticks for one instrument/timeframe. Buckets are aligned to the IST
 * session open (09:15) so 5m/15m/75m bars match exchange conventions.
 * `onClose` fires exactly once per completed bar (when the first tick of the next bar arrives
 * or `flush(now)` sees the bucket has ended).
 */
export class CandleAggregator {
  private current: Candle | null = null;
  private lastVolume: number | null = null;

  constructor(
    private readonly timeframeMs: number,
    private readonly onClose: (c: Candle) => void,
    /** IST session open for Indian markets; null = 24x7 market aligned to UTC epoch (crypto). */
    private readonly sessionOpenMinutesIst: number | null = 9 * 60 + 15,
  ) {}

  bucketStart(ts: number): number {
    if (this.sessionOpenMinutesIst === null) return Math.floor(ts / this.timeframeMs) * this.timeframeMs;
    const dayStartIst = Math.floor((ts + IST_OFFSET_MS) / 86_400_000) * 86_400_000 - IST_OFFSET_MS;
    const sessionOpen = dayStartIst + this.sessionOpenMinutesIst * 60_000;
    const base = ts >= sessionOpen ? sessionOpen : dayStartIst;
    return base + Math.floor((ts - base) / this.timeframeMs) * this.timeframeMs;
  }

  /** `cumulativeVolume` true when feed sends day-cumulative volume (most Indian feeds). */
  onTick(tick: Tick, cumulativeVolume = false): void {
    if (!(tick.ltp > 0)) return;
    const b = this.bucketStart(tick.timestamp);
    let vol = tick.qty ?? 0;
    if (cumulativeVolume && tick.qty !== undefined) {
      vol = this.lastVolume === null ? 0 : Math.max(0, tick.qty - this.lastVolume);
      this.lastVolume = tick.qty;
    }
    if (this.current && b < this.current.t) return; // late tick from a closed bar: drop
    if (this.current && b > this.current.t) {
      this.onClose(this.current);
      this.current = null;
    }
    if (!this.current) {
      this.current = { t: b, o: tick.ltp, h: tick.ltp, l: tick.ltp, c: tick.ltp, v: vol };
      return;
    }
    const k = this.current;
    k.h = Math.max(k.h, tick.ltp);
    k.l = Math.min(k.l, tick.ltp);
    k.c = tick.ltp;
    k.v += vol;
  }

  /** Close the current bar if its time window has passed (call from a timer). */
  flush(now: number): void {
    if (this.current && now >= this.current.t + this.timeframeMs) {
      this.onClose(this.current);
      this.current = null;
    }
  }

  get partial(): Candle | null {
    return this.current;
  }
}

/** Aggregate base candles into higher-timeframe candles (e.g. 5m -> 15m), IST-aligned. */
export function resampleCandles(
  candles: readonly Candle[],
  timeframeMs: number,
  alwaysOpen = false,
): Candle[] {
  const bucket = new CandleAggregator(timeframeMs, () => undefined, alwaysOpen ? null : 9 * 60 + 15);
  const out: Candle[] = [];
  for (const k of candles) {
    const b = bucket.bucketStart(k.t);
    const cur = out[out.length - 1];
    if (cur && cur.t === b) {
      cur.h = Math.max(cur.h, k.h);
      cur.l = Math.min(cur.l, k.l);
      cur.c = k.c;
      cur.v += k.v;
    } else {
      out.push({ t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
    }
  }
  return out;
}
