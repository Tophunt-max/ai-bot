import type { InstrumentType, Side } from "@atb/shared-types";

export function roundToTick(
  price: number,
  tickSize: number,
  mode: "up" | "down" | "nearest" = "nearest",
): number {
  const n = price / tickSize;
  const r = mode === "up" ? Math.ceil(n - 1e-9) : mode === "down" ? Math.floor(n + 1e-9) : Math.round(n);
  return Number((r * tickSize).toFixed(4));
}

/** Protection band as a fraction of LTP. Conservative defaults; tune per broker/instrument. */
export function protectionBand(ltp: number, type: InstrumentType): number {
  if (type === "CE" || type === "PE") {
    if (ltp < 5) return 0.1;
    if (ltp < 10) return 0.05;
    if (ltp < 100) return 0.03;
    if (ltp < 500) return 0.02;
    return 0.01;
  }
  if (ltp < 100) return 0.02;
  if (ltp < 500) return 0.01;
  return 0.005;
}

/**
 * Marketable LIMIT price instead of a MARKET order.
 * BUY: at most LTP*(1+band); SELL: at least LTP*(1-band). Rounded to tick away from over-paying.
 */
export function protectedLimitPrice(ltp: number, side: Side, type: InstrumentType, tickSize: number): number {
  if (!(ltp > 0)) throw new Error("LTP unavailable — refusing to price order");
  const band = protectionBand(ltp, type);
  return side === "BUY"
    ? roundToTick(ltp * (1 + band), tickSize, "down")
    : roundToTick(ltp * (1 - band), tickSize, "up");
}
