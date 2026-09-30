import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

interface SignalRow {
  id: string;
  instrument_id: string;
  decision: string;
  regime: string;
  quality: number;
  reasons: string;
  risk_decision: string | null;
  risk_failed_check: string | null;
  created_at: number;
}

export default function Signals() {
  const q = useQuery({ queryKey: qk.signals, queryFn: api.signals });
  const rows = (q.data ?? []) as SignalRow[];
  return (
    <Screen title="Signals">
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      {!q.isLoading && rows.length === 0 ? <Muted>No signals recorded.</Muted> : null}
      {rows.map((sg) => {
        const reasons = JSON.parse(sg.reasons || "{}") as Record<string, string>;
        return (
          <Card
            key={sg.id}
            title={`${sg.instrument_id} · ${new Date(sg.created_at).toLocaleString("en-IN")}`}
          >
            <Row label="Decision" value={sg.decision} />
            <Row label="Regime" value={sg.regime} />
            <Row label="Quality (relative)" value={sg.quality.toFixed(2)} />
            <Row
              label="Risk gateway"
              value={sg.risk_decision ?? "—"}
              tone={sg.risk_decision === "REJECTED" ? "bad" : undefined}
            />
            {sg.risk_failed_check ? (
              <Row label="Failed check" value={sg.risk_failed_check} tone="bad" />
            ) : null}
            {Object.entries(reasons).map(([k, v]) => (
              <Row key={k} label={k} value={v} />
            ))}
          </Card>
        );
      })}
    </Screen>
  );
}
