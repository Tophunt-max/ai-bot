import { useQuery } from "@tanstack/react-query";
import { Card, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function MarketRegime() {
  const q = useQuery({ queryKey: qk.portfolio, queryFn: api.portfolio });
  return (
    <Screen title="Market regime">
      <Card title="Current">
        <Row label="Regime" value={q.data?.regime ?? "UNKNOWN"} />
        <Row label="AI status" value={q.data?.aiStatus ?? "—"} />
      </Card>
      <Muted>
        The regime engine sets strategy weights. Weights are validated walk-forward, not assumed. UNKNOWN or
        ABNORMAL regimes block new trades.
      </Muted>
    </Screen>
  );
}
