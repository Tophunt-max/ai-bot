import type { Candle, Quote } from "@atb/shared-types";

export type DataIssue =
  | { type: "INVALID_OHLC"; t: number }
  | { type: "DUPLICATE_TS"; t: number }
  | { type: "OUT_OF_ORDER"; t: number }
  | { type: "MISSING_CANDLES"; from: number; to: number; missing: number }
  | { type: "ABNORMAL_MOVE"; t: number; movePct: number }
  | { type: "NON_POSITIVE_PRICE"; t: number };

export interface ValidationResult {
  ok: boolean;
  issues: DataIssue[];
  clean: Candle[];
}

/**
 * Validates and cleans a candle series. Invalid/duplicate/out-of-order candles are dropped.
 * Gaps inside a trading session are reported (sessions break overnight, so only gaps smaller
 * than `sessionBreakMs` count as missing data).
 */
export function validateCandles(
  candles: readonly Candle[],
  timeframeMs: number,
  opts: { sessionBreakMs?: number; abnormalMovePct?: number } = {},
): ValidationResult {
  const sessionBreak = opts.sessionBreakMs ?? 3 * 60 * 60 * 1000;
  const abnormal = opts.abnormalMovePct ?? 20;
  const issues: DataIssue[] = [];
  const clean: Candle[] = [];
  for (const k of candles) {
    if (!(k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0)) {
      issues.push({ type: "NON_POSITIVE_PRICE", t: k.t });
      continue;
    }
    if (k.l > Math.min(k.o, k.c) || k.h < Math.max(k.o, k.c) || k.l > k.h) {
      issues.push({ type: "INVALID_OHLC", t: k.t });
      continue;
    }
    const prev = clean[clean.length - 1];
    if (prev) {
      if (k.t === prev.t) {
        issues.push({ type: "DUPLICATE_TS", t: k.t });
        continue;
      }
      if (k.t < prev.t) {
        issues.push({ type: "OUT_OF_ORDER", t: k.t });
        continue;
      }
      const gap = k.t - prev.t;
      if (gap > timeframeMs && gap < sessionBreak) {
        issues.push({
          type: "MISSING_CANDLES",
          from: prev.t,
          to: k.t,
          missing: Math.round(gap / timeframeMs) - 1,
        });
      }
      const move = (Math.abs(k.c - prev.c) / prev.c) * 100;
      if (move > abnormal) issues.push({ type: "ABNORMAL_MOVE", t: k.t, movePct: move });
    }
    clean.push(k);
  }
  return { ok: issues.length === 0, issues, clean };
}

export interface QuoteHealth {
  fresh: boolean;
  reason?: string;
}

/** Live quote sanity: staleness and abnormal spread. Stale => NEW TRADES BLOCKED. */
export function checkQuote(
  q: Quote | undefined,
  now: number,
  maxAgeMs: number,
  maxSpreadPct = 1,
): QuoteHealth {
  if (!q) return { fresh: false, reason: "no quote" };
  if (!(q.ltp > 0)) return { fresh: false, reason: "invalid ltp" };
  if (now - q.timestamp > maxAgeMs) return { fresh: false, reason: `stale by ${now - q.timestamp}ms` };
  if (q.bid !== undefined && q.ask !== undefined && q.bid > 0 && q.ask > 0) {
    const spread = ((q.ask - q.bid) / q.ltp) * 100;
    if (spread < 0) return { fresh: false, reason: "crossed book" };
    if (spread > maxSpreadPct) return { fresh: false, reason: `abnormal spread ${spread.toFixed(2)}%` };
  }
  return { fresh: true };
}
