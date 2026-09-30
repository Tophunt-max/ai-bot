import type { Candle } from "@atb/shared-types";

/**
 * Deterministic synthetic intraday data (NSE hours, 5m bars) with alternating trend / range /
 * high-vol regimes. FOR TESTING THE PIPELINE ONLY — results on synthetic data say nothing
 * about real-market profitability.
 */
export function syntheticSession(opts: {
  days: number;
  start?: number; // epoch ms of first trading day 00:00 IST
  startPrice?: number;
  timeframeMin?: number;
  seed?: number;
}): Candle[] {
  const tf = (opts.timeframeMin ?? 5) * 60_000;
  let s = (opts.seed ?? 7) >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const out: Candle[] = [];
  let px = opts.startPrice ?? 1000;
  let day = opts.start ?? Date.UTC(2025, 0, 6) - 330 * 60_000; // Monday 00:00 IST
  let produced = 0;
  let regimeDrift = 0;
  let regimeVol = 0.0012;
  while (produced < opts.days) {
    const wd = new Date(day + 330 * 60_000).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      if (produced % 7 === 0) {
        const r = rand();
        regimeDrift = r < 0.35 ? 0.00025 : r < 0.6 ? -0.00025 : 0;
        regimeVol = r > 0.9 ? 0.003 : 0.0012;
      }
      const open = day + (9 * 60 + 15) * 60_000;
      const bars = Math.floor((375 * 60_000) / tf);
      px *= 1 + gauss() * 0.004; // overnight gap
      for (let b = 0; b < bars; b++) {
        const o = px;
        const ret = regimeDrift + gauss() * regimeVol;
        const c = o * Math.exp(ret);
        const h = Math.max(o, c) * (1 + Math.abs(gauss()) * regimeVol * 0.5);
        const l = Math.min(o, c) * (1 - Math.abs(gauss()) * regimeVol * 0.5);
        const v = Math.round(50_000 * (1 + Math.abs(gauss())) * (b < 6 || b > bars - 6 ? 2 : 1));
        out.push({ t: open + b * tf, o, h, l, c, v });
        px = c;
      }
      produced++;
    }
    day += 86_400_000;
  }
  return out;
}

/** 24x7 synthetic crypto candles (UTC-aligned), regime-switching. Pipeline tests only. */
export function synthetic24x7(opts: {
  days: number;
  start?: number;
  startPrice?: number;
  timeframeMin?: number;
  seed?: number;
}): Candle[] {
  const tf = (opts.timeframeMin ?? 5) * 60_000;
  let s = (opts.seed ?? 3) >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const bars = Math.floor((opts.days * 86_400_000) / tf);
  const t0 = Math.floor((opts.start ?? Date.UTC(2025, 0, 1)) / tf) * tf;
  const out: Candle[] = [];
  let px = opts.startPrice ?? 60_000;
  let drift = 0;
  let vol = 0.0015;
  for (let b = 0; b < bars; b++) {
    if (b % 2000 === 0) {
      const r = rand();
      drift = r < 0.35 ? 0.0003 : r < 0.6 ? -0.0003 : 0;
      vol = r > 0.9 ? 0.004 : 0.0015;
    }
    const o = px;
    const c = o * Math.exp(drift + gauss() * vol);
    const h = Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.5);
    const l = Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.5);
    out.push({ t: t0 + b * tf, o, h, l, c, v: 5 + Math.abs(gauss()) * 20 });
    px = c;
  }
  return out;
}
