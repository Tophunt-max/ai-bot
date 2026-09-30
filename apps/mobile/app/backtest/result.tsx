import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Card, ErrorText, Loading, Muted, Row, Screen, inr } from "../../src/components/ui";
import { api } from "../../src/lib/api";

const pct = (v: unknown) => `${Number(v ?? 0).toFixed(2)}%`;
const n2 = (v: unknown) => Number(v ?? 0).toFixed(2);

export default function BacktestResult() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const q = useQuery({ queryKey: ["backtest", id], queryFn: () => api.backtest(id!), enabled: !!id });
  if (!id)
    return (
      <Screen title="Backtest result">
        <Muted>Open a backtest from the list.</Muted>
      </Screen>
    );
  if (q.isLoading)
    return (
      <Screen title="Backtest result">
        <Loading />
      </Screen>
    );
  if (q.error)
    return (
      <Screen title="Backtest result">
        <ErrorText error={q.error} />
      </Screen>
    );
  const m = JSON.parse(q.data!.metrics || "{}") as Record<string, unknown>;
  return (
    <Screen title="Backtest result">
      <Card title="Out-of-sample metrics (after costs)">
        <Row label="Verdict" value={String(m.verdict ?? "—")} tone={m.verdict === "PASS" ? "good" : "bad"} />
        <Row label="Trades" value={String(m.trades ?? "—")} />
        <Row label="Net P&L" value={inr(Number(m.netPnl))} />
        <Row label="CAGR" value={pct(m.cagrPct)} />
        <Row label="Sharpe" value={n2(m.sharpe)} />
        <Row label="Sortino" value={n2(m.sortino)} />
        <Row label="Max drawdown" value={pct(m.maxDrawdownPct)} />
        <Row label="Win rate" value={pct(m.winRatePct)} />
        <Row label="Profit factor" value={n2(m.profitFactor)} />
        <Row label="Expectancy" value={`${inr(Number(m.expectancy))} (${n2(m.expectancyR)}R)`} />
        <Row label="Average win" value={inr(Number(m.avgWin))} />
        <Row label="Average loss" value={inr(Number(m.avgLoss))} />
        <Row label="Total costs" value={inr(Number(m.totalFees))} />
        <Row label="Risk of ruin" value={pct(m.riskOfRuinPct)} />
      </Card>
      <Muted>Ranked by risk-adjusted, out-of-sample performance — never by maximum backtest profit.</Muted>
    </Screen>
  );
}
