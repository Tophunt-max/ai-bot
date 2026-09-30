import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen, inr } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function RiskLimits() {
  const q = useQuery({ queryKey: qk.risk, queryFn: api.risk });
  if (q.isLoading)
    return (
      <Screen title="Risk limits">
        <Loading />
      </Screen>
    );
  if (q.error)
    return (
      <Screen title="Risk limits">
        <ErrorText error={q.error} />
      </Screen>
    );
  const l = q.data!.limits;
  return (
    <Screen title="Hard risk limits">
      <Card>
        <Row label="Max risk / trade" value={`${l.maxRiskPerTradePct}%`} />
        <Row label="Max daily loss" value={`${l.maxDailyLossPct}%`} />
        <Row label="Max weekly loss" value={`${l.maxWeeklyLossPct}%`} />
        <Row label="Max drawdown" value={`${l.maxDrawdownPct}%`} />
        <Row label="Max open positions" value={l.maxOpenPositions} />
        <Row label="Max symbol exposure" value={`${l.maxSymbolExposurePct}%`} />
        <Row label="Max correlated exposure" value={`${l.maxCorrelatedExposurePct}%`} />
        <Row label="Max leverage" value={`${l.maxLeverage}x`} />
        <Row label="Max position value" value={inr(l.maxPositionValue)} />
        <Row label="Max orders / min" value={l.maxOrdersPerMinute} />
        <Row label="Max orders / sec" value={l.maxOrdersPerSecond} />
      </Card>
      <Muted>The AI cannot change these. Edits are owner-only, validated server-side and audited.</Muted>
    </Screen>
  );
}
