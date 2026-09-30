import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Row, Screen, inr } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function RiskOverview() {
  const q = useQuery({ queryKey: qk.risk, queryFn: api.risk });
  if (q.isLoading)
    return (
      <Screen title="Risk">
        <Loading />
      </Screen>
    );
  if (q.error)
    return (
      <Screen title="Risk">
        <ErrorText error={q.error} />
      </Screen>
    );
  const { state: st, limits } = q.data!;
  const dailyLimit = (st.equity * limits.maxDailyLossPct) / 100;
  const dd = st.peakEquity > 0 ? ((st.peakEquity - st.equity) / st.peakEquity) * 100 : 0;
  return (
    <Screen title="Risk overview">
      <Card>
        <Row
          label="Daily loss"
          value={inr(Math.min(0, st.dailyRealisedPnl))}
          tone={st.dailyRealisedPnl < 0 ? "bad" : undefined}
        />
        <Row label="Daily limit" value={inr(dailyLimit)} />
        <Row label="Drawdown" value={`${dd.toFixed(2)}% / ${limits.maxDrawdownPct}%`} />
        <Row label="Open risk" value={inr(st.openRisk)} />
        <Row label="Open positions" value={`${st.openPositions} / ${limits.maxOpenPositions}`} />
        <Row label="Max leverage" value={`${limits.maxLeverage}x`} />
        <Row
          label="Trading status"
          value={st.tradingLocked ? `LOCKED (${st.lockReason ?? "?"})` : "ALLOWED"}
          tone={st.tradingLocked ? "bad" : "good"}
        />
      </Card>
    </Screen>
  );
}
