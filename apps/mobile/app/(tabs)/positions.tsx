import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen, inr } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

interface Pos {
  instrumentId: string;
  quantity: number;
  averagePrice: number;
  lastPrice?: number;
  unrealisedPnl: number;
  stopPrice: number;
  targets: number[];
}

export default function Positions() {
  const q = useQuery({ queryKey: qk.positions, queryFn: api.positions });
  const rows = (q.data ?? []) as Pos[];
  return (
    <Screen title="Positions">
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      {!q.isLoading && rows.length === 0 ? <Muted>No open positions.</Muted> : null}
      {rows.map((p) => {
        const risk = Math.abs(p.averagePrice - p.stopPrice) * Math.abs(p.quantity);
        return (
          <Card key={p.instrumentId} title={p.instrumentId}>
            <Row label="Quantity" value={p.quantity} />
            <Row label="Entry" value={inr(p.averagePrice)} />
            <Row label="Current" value={inr(p.lastPrice)} />
            <Row label="P&L" value={inr(p.unrealisedPnl)} tone={p.unrealisedPnl >= 0 ? "good" : "bad"} />
            <Row label="Stop loss" value={inr(p.stopPrice)} />
            <Row label="Take profit" value={p.targets.map((t) => inr(t)).join(" / ") || "—"} />
            <Row label="Risk" value={inr(risk)} />
          </Card>
        );
      })}
    </Screen>
  );
}
