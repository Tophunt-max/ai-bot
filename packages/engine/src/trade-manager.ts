import type { Side } from "@atb/shared-types";

export interface ExitPolicy {
  /** Fractions of the INITIAL quantity closed at TP1 and TP2; the rest runs to TP3/trailing stop. */
  tp1Fraction: number;
  tp2Fraction: number;
  /** After TP1 the stop moves to entry +/- this many ATR (covers costs). */
  breakEvenBufferAtr: number;
  /** Chandelier trailing stop distance in ATR, active after TP1. */
  trailAtr: number;
  /** Exit if TP1 has not been reached within this many bars. */
  maxBarsWithoutProgress: number;
  /** Absolute max holding period in bars. */
  maxBars: number;
}

export const DEFAULT_EXIT_POLICY: ExitPolicy = {
  tp1Fraction: 0.5,
  tp2Fraction: 0.3,
  breakEvenBufferAtr: 0.1,
  trailAtr: 2.5,
  maxBarsWithoutProgress: 24,
  maxBars: 75,
};

export interface ManagedTrade {
  id: string;
  instrumentId: string;
  side: Side;
  lotSize: number;
  initialQty: number;
  qty: number;
  entry: number;
  initialStop: number;
  stop: number;
  targets: [number, number, number];
  tp1Done: boolean;
  tp2Done: boolean;
  openedAt: number;
  barsHeld: number;
  /** Best/worst excursion in price units (favourable positive). */
  mfe: number;
  mae: number;
  extreme: number; // best price since entry (for trailing)
  intraday: boolean;
}

export type ExitReason =
  "STOP" | "BREAKEVEN_STOP" | "TRAILING_STOP" | "TP1" | "TP2" | "TP3" | "TIME" | "EOD" | "MANUAL";

export interface ExitFill {
  reason: ExitReason;
  qty: number;
  price: number;
}

export interface BarUpdate {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  atr: number;
  /** true when the session is in its square-off window (intraday positions must close). */
  squareOff: boolean;
}

const roundLots = (qty: number, lot: number) => Math.floor(qty / lot + 1e-9) * lot;

export function openTrade(args: {
  id: string;
  instrumentId: string;
  side: Side;
  lotSize: number;
  qty: number;
  entry: number;
  stop: number;
  targets: number[];
  openedAt: number;
  intraday: boolean;
}): ManagedTrade {
  const dir = args.side === "BUY" ? 1 : -1;
  const risk = dir * (args.entry - args.stop);
  if (!(risk > 0)) throw new Error("stop must be on the protective side of entry");
  const t1 = args.targets[0] ?? args.entry + dir * risk;
  const t2 = args.targets[1] ?? args.entry + dir * risk * 2;
  const t3 = args.targets[2] ?? args.entry + dir * risk * 3;
  return {
    ...args,
    initialQty: args.qty,
    initialStop: args.stop,
    targets: [t1, t2, t3],
    tp1Done: false,
    tp2Done: false,
    barsHeld: 0,
    mfe: 0,
    mae: 0,
    extreme: args.entry,
  };
}

/**
 * Advances a trade by one bar and returns the exits that occurred (in order).
 * Conservative conventions (no look-ahead, pessimistic):
 *  - Gap through the stop fills at the OPEN.
 *  - If a bar touches both stop and a target, the STOP is assumed to hit first.
 *  - The stop can only move in the protective direction.
 */
export function onBar(tr: ManagedTrade, b: BarUpdate, p: ExitPolicy = DEFAULT_EXIT_POLICY): ExitFill[] {
  const fills: ExitFill[] = [];
  if (tr.qty <= 0) return fills;
  const long = tr.side === "BUY";
  const dir = long ? 1 : -1;
  tr.barsHeld++;

  const exit = (reason: ExitReason, qty: number, price: number) => {
    const q = Math.min(tr.qty, qty);
    if (q <= 0) return;
    tr.qty -= q;
    fills.push({ reason, qty: q, price });
  };
  const stopReason = (): ExitReason =>
    tr.tp1Done
      ? dir * (tr.stop - tr.entry) > 0.5 * Math.abs(tr.entry - tr.initialStop)
        ? "TRAILING_STOP"
        : "BREAKEVEN_STOP"
      : "STOP";

  // 1) Gap through stop at the open.
  if (long ? b.o <= tr.stop : b.o >= tr.stop) {
    exit(stopReason(), tr.qty, b.o);
    return fills;
  }

  // Excursions (price units, favourable positive)
  tr.mfe = Math.max(tr.mfe, dir * ((long ? b.h : b.l) - tr.entry));
  tr.mae = Math.min(tr.mae, dir * ((long ? b.l : b.h) - tr.entry));

  // 2) Stop touched intrabar => assume first.
  if (long ? b.l <= tr.stop : b.h >= tr.stop) {
    exit(stopReason(), tr.qty, tr.stop);
    return fills;
  }

  // 3) Targets (gap beyond target fills at the open, which is better for us — use target price conservatively).
  const hit = (target: number) => (long ? b.h >= target : b.l <= target);
  if (!tr.tp1Done && hit(tr.targets[0])) {
    tr.tp1Done = true;
    exit("TP1", Math.max(tr.lotSize, roundLots(tr.initialQty * p.tp1Fraction, tr.lotSize)), tr.targets[0]);
    const be = tr.entry + dir * p.breakEvenBufferAtr * b.atr;
    if (dir * (be - tr.stop) > 0) tr.stop = be;
  }
  if (tr.qty > 0 && tr.tp1Done && !tr.tp2Done && hit(tr.targets[1])) {
    tr.tp2Done = true;
    exit("TP2", Math.max(tr.lotSize, roundLots(tr.initialQty * p.tp2Fraction, tr.lotSize)), tr.targets[1]);
  }
  if (tr.qty > 0 && tr.tp2Done && hit(tr.targets[2])) exit("TP3", tr.qty, tr.targets[2]);
  if (tr.qty <= 0) return fills;

  // 4) Trailing stop after TP1 (chandelier on closes), tighten only.
  tr.extreme = long ? Math.max(tr.extreme, b.c) : Math.min(tr.extreme, b.c);
  if (tr.tp1Done && b.atr > 0) {
    const trail = tr.extreme - dir * p.trailAtr * b.atr;
    if (dir * (trail - tr.stop) > 0) tr.stop = trail;
  }

  // 5) Time / session exits at the close.
  if (tr.intraday && b.squareOff) exit("EOD", tr.qty, b.c);
  else if (!tr.tp1Done && tr.barsHeld >= p.maxBarsWithoutProgress) exit("TIME", tr.qty, b.c);
  else if (tr.barsHeld >= p.maxBars) exit("TIME", tr.qty, b.c);
  return fills;
}
