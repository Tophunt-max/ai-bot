import { toIst } from "@atb/trading-core";

export interface ClosedTrade {
  id: string;
  instrumentId: string;
  side: "BUY" | "SELL";
  strategy: string;
  regime: string;
  quality: number;
  qty: number;
  entry: number;
  exit: number;
  stop: number;
  riskAmount: number; // INR at risk at entry
  grossPnl: number;
  fees: number;
  slippage: number; // INR
  netPnl: number;
  rMultiple: number;
  mfe: number; // price units
  mae: number;
  openedAt: number;
  closedAt: number;
  barsHeld: number;
  exitReason: string;
}

export interface EquityPoint {
  t: number;
  equity: number;
}

export interface Metrics {
  trades: number;
  netPnl: number;
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  expectancy: number; // INR per trade
  expectancyR: number;
  avgWin: number;
  avgLoss: number;
  payoffRatio: number;
  totalFees: number;
  riskOfRuinPct: number;
  avgBarsHeld: number;
  tradingDays: number;
}

/** Daily returns from an equity curve, grouped by IST date (last point of each day). */
export function dailyReturns(curve: readonly EquityPoint[]): number[] {
  const byDay = new Map<string, number>();
  for (const p of curve) byDay.set(toIst(p.t).date, p.equity);
  const vals = [...byDay.values()];
  const out: number[] = [];
  for (let i = 1; i < vals.length; i++) out.push(vals[i]! / vals[i - 1]! - 1);
  return out;
}

export function maxDrawdownPct(curve: readonly EquityPoint[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  return mdd * 100;
}

/**
 * Risk of ruin via the classic unit-bet approximation: RoR = ((1-E)/(1+E))^U, where E is the
 * expectancy per unit risked (clamped) and U = number of risk units until the drawdown limit.
 */
export function riskOfRuin(expectancyR: number, riskPct: number, ruinDrawdownPct: number): number {
  if (!(riskPct > 0)) return Number.NaN;
  const units = ruinDrawdownPct / riskPct;
  const e = Math.max(-0.99, Math.min(0.99, expectancyR));
  if (e <= 0) return 100;
  return Math.pow((1 - e) / (1 + e), units) * 100;
}

export function computeMetrics(
  trades: readonly ClosedTrade[],
  curve: readonly EquityPoint[],
  initialCapital: number,
  riskPct: number,
  ruinDrawdownPct = 25,
): Metrics {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const netPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const finalEquity = curve.at(-1)?.equity ?? initialCapital;
  const rets = dailyReturns(curve);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const sd =
    rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const downside = rets.filter((r) => r < 0);
  const dsd = downside.length > 1 ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : 0;
  const years = Math.max(rets.length, 1) / 252;
  const expectancyR = trades.length ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  return {
    trades: trades.length,
    netPnl,
    totalReturnPct: ((finalEquity - initialCapital) / initialCapital) * 100,
    cagrPct: finalEquity > 0 ? (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100 : -100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(252) : 0,
    maxDrawdownPct: maxDrawdownPct(curve),
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: trades.length ? netPnl / trades.length : 0,
    expectancyR,
    avgWin,
    avgLoss,
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    totalFees: trades.reduce((s, t) => s + t.fees, 0),
    riskOfRuinPct: riskOfRuin(expectancyR, riskPct, ruinDrawdownPct),
    avgBarsHeld: trades.length ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : 0,
    tradingDays: rets.length + 1,
  };
}

/** Shuffle trade order to estimate the drawdown distribution (path risk). */
export function monteCarloDrawdown(
  rMultiples: readonly number[],
  riskPct: number,
  runs = 1000,
  seed = 42,
): { p50: number; p95: number; p99: number } {
  if (rMultiples.length === 0) return { p50: 0, p95: 0, p99: 0 };
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const dds: number[] = [];
  const arr = [...rMultiples];
  for (let r = 0; r < runs; r++) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    let eq = 1;
    let peak = 1;
    let mdd = 0;
    for (const x of arr) {
      eq *= 1 + (x * riskPct) / 100;
      peak = Math.max(peak, eq);
      mdd = Math.max(mdd, (peak - eq) / peak);
    }
    dds.push(mdd * 100);
  }
  dds.sort((a, b) => a - b);
  const q = (p: number) => dds[Math.min(dds.length - 1, Math.floor(p * dds.length))]!;
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}
