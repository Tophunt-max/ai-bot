import type { BacktestResult, ClosedTrade, Metrics, WalkForwardResult } from "@atb/engine";

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const f2 = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

export function metricsTable(m: Metrics): string {
  const rows: Array<[string, string]> = [
    ["Trades", String(m.trades)],
    ["Net P&L (after costs)", inr(m.netPnl)],
    ["Total return", `${f2(m.totalReturnPct)}%`],
    ["CAGR", `${f2(m.cagrPct)}%`],
    ["Sharpe", f2(m.sharpe)],
    ["Sortino", f2(m.sortino)],
    ["Max drawdown", `${f2(m.maxDrawdownPct)}%`],
    ["Win rate", `${f2(m.winRatePct)}%`],
    ["Profit factor", f2(m.profitFactor)],
    ["Expectancy", `${inr(m.expectancy)} (${f2(m.expectancyR)}R)`],
    ["Avg win / avg loss", `${inr(m.avgWin)} / ${inr(m.avgLoss)}`],
    ["Total costs (brokerage+STT+…)", inr(m.totalFees)],
    ["Risk of ruin (25% DD)", `${f2(m.riskOfRuinPct)}%`],
    ["Avg bars held", f2(m.avgBarsHeld)],
    ["Trading days", String(m.tradingDays)],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`).join("\n");
}

export function breakdown(trades: readonly ClosedTrade[], key: "strategy" | "regime" | "exitReason"): string {
  const g = new Map<string, { n: number; pnl: number; r: number }>();
  for (const t of trades) {
    const k = t[key] || "-";
    const e = g.get(k) ?? { n: 0, pnl: 0, r: 0 };
    e.n++;
    e.pnl += t.netPnl;
    e.r += t.rMultiple;
    g.set(k, e);
  }
  return [...g.entries()]
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .map(
      ([k, e]) =>
        `  ${k.padEnd(24)} n=${String(e.n).padStart(4)}  P&L ${inr(e.pnl).padStart(12)}  avg ${f2(e.r / e.n)}R`,
    )
    .join("\n");
}

export function tradesCsv(trades: readonly ClosedTrade[]): string {
  const cols: (keyof ClosedTrade)[] = [
    "id",
    "instrumentId",
    "side",
    "strategy",
    "regime",
    "quality",
    "qty",
    "entry",
    "exit",
    "stop",
    "riskAmount",
    "grossPnl",
    "fees",
    "slippage",
    "netPnl",
    "rMultiple",
    "mfe",
    "mae",
    "openedAt",
    "closedAt",
    "barsHeld",
    "exitReason",
  ];
  const esc = (v: unknown) => (typeof v === "string" && v.includes(",") ? `"${v}"` : String(v));
  return [
    cols.join(","),
    ...trades.map((t) =>
      cols
        .map((c) => esc(c === "openedAt" || c === "closedAt" ? new Date(t[c] as number).toISOString() : t[c]))
        .join(","),
    ),
  ].join("\n");
}

export function summarize(r: BacktestResult): string {
  const rej =
    Object.entries(r.signals.rejectedBy)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ") || "none";
  return [
    "── Backtest ──────────────────────────────────────────",
    metricsTable(r.metrics),
    `  Signals: ${r.signals.total} total, ${r.signals.approved} approved by risk gateway; rejected: ${rej}`,
    "── By strategy ──",
    breakdown(r.trades, "strategy"),
    "── By regime ──",
    breakdown(r.trades, "regime"),
    "── By exit ──",
    breakdown(r.trades, "exitReason"),
  ].join("\n");
}

export function summarizeWalkForward(w: WalkForwardResult): string {
  const folds = w.folds
    .map(
      (f) =>
        `  fold ${f.fold}: chose "${f.chosen}"  IS ${f.inSample.trades} trades Sharpe ${f2(f.inSample.sharpe)}  →  OOS ${f.outOfSample.trades} trades Sharpe ${f2(f.outOfSample.sharpe)} exp ${f2(f.outOfSample.expectancyR)}R`,
    )
    .join("\n");
  return [
    "── Walk-forward (only OUT-OF-SAMPLE counts) ──────────",
    folds,
    metricsTable(w.outOfSample),
    `  Monte-Carlo drawdown p50/p95/p99: ${f2(w.monteCarlo.p50)}% / ${f2(w.monteCarlo.p95)}% / ${f2(w.monteCarlo.p99)}%`,
    `  OOS/IS Sharpe ratio: ${f2(w.degradation)}`,
    `  VERDICT: ${w.verdict}${w.verdictReasons.length ? "\n   - " + w.verdictReasons.join("\n   - ") : ""}`,
    w.verdict === "PASS"
      ? "  Next step: PAPER → SHADOW for 1–3 months before any CANARY capital."
      : "  Do NOT trade this configuration with real money.",
  ].join("\n");
}
