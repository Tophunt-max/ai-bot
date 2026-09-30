import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen, inr } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function Dashboard() {
  const q = useQuery({ queryKey: qk.portfolio, queryFn: api.portfolio });
  if (q.isLoading)
    return (
      <Screen title="Dashboard">
        <Loading />
      </Screen>
    );
  if (q.error)
    return (
      <Screen title="Dashboard">
        <ErrorText error={q.error} />
      </Screen>
    );
  const d = q.data!;
  const pnlTone = (n: number) => (n > 0 ? "good" : n < 0 ? "bad" : undefined);

  return (
    <Screen title="Dashboard">
      <Card title="Portfolio">
        <Row label="Total value" value={inr(d.portfolioValue)} />
        <Row label="Available capital" value={inr(d.availableCapital)} />
        <Row label="Today's P&L" value={inr(d.todayPnl)} tone={pnlTone(d.todayPnl)} />
        <Row label="Overall P&L" value={inr(d.overallPnl)} tone={pnlTone(d.overallPnl)} />
        <Row label="Open positions" value={d.openPositions} />
      </Card>
      <Card title="Risk">
        <Row
          label="Current drawdown"
          value={`${d.currentDrawdownPct.toFixed(2)}%`}
          tone={d.currentDrawdownPct > 5 ? "warn" : undefined}
        />
        <Row
          label="Daily loss used"
          value={`${d.riskUtilisationPct.toFixed(0)}%`}
          tone={d.riskUtilisationPct > 75 ? "bad" : undefined}
        />
        <Row label="Daily loss remaining" value={inr(d.dailyLossRemaining)} />
      </Card>
      <Card title="System">
        <Row
          label="Trading mode"
          value={d.mode}
          tone={d.mode === "SAFE_MODE" ? "bad" : d.mode === "LIVE" ? "warn" : undefined}
        />
        <Row label="Market regime" value={d.regime} />
        <Row label="AI status" value={d.aiStatus} />
        <Row
          label="Execution gateway"
          value={d.health.gateway}
          tone={d.health.gateway === "ok" ? "good" : "bad"}
        />
        <Row label="Market data" value={d.health.marketData} />
        <Row label="Broker session" value={d.health.brokerSession} />
      </Card>
      <Muted>Figures come from broker reconciliation. Nothing shown is a guarantee of future returns.</Muted>
    </Screen>
  );
}
