import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen, inr } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

interface Trade {
  id: string;
  instrument_id: string;
  strategy: string | null;
  side: string;
  quantity: number;
  entry_price: number;
  exit_price: number;
  pnl: number;
  fees: number;
  exit_reason: string | null;
  mode: string;
}

export default function History() {
  const q = useQuery({ queryKey: qk.trades, queryFn: api.trades });
  const perf = useQuery({ queryKey: ["perf"], queryFn: () => api.performance() });
  const rows = (q.data ?? []) as Trade[];
  const total = rows.reduce((a, t) => a + t.pnl, 0);
  const wins = rows.filter((t) => t.pnl > 0).length;
  return (
    <Screen title="Trade journal">
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      {!q.isLoading && rows.length === 0 ? <Muted>No closed trades yet.</Muted> : null}
      {rows.length ? (
        <Card title="Summary (latest 100)">
          <Row label="Net P&L" value={inr(total)} tone={total >= 0 ? "good" : "bad"} />
          <Row label="Win rate" value={`${((wins / rows.length) * 100).toFixed(0)}%`} />
          {(perf.data?.exit ?? []).map((r) => (
            <Row key={r.k ?? "-"} label={`Exit ${r.k ?? "-"}`} value={`${r.n} · ${inr(r.pnl)}`} />
          ))}
        </Card>
      ) : null}
      {rows.map((t) => (
        <Card key={t.id} title={`${t.instrument_id} · ${t.mode}`}>
          <Row label="Side / Qty" value={`${t.side} ${t.quantity}`} />
          <Row label="Entry → Exit" value={`${t.entry_price} → ${t.exit_price}`} />
          <Row label="Net P&L" value={inr(t.pnl)} tone={t.pnl >= 0 ? "good" : "bad"} />
          <Row label="Fees" value={inr(t.fees)} />
          <Row label="Strategy" value={t.strategy ?? "—"} />
          <Row label="Exit reason" value={t.exit_reason ?? "—"} />
        </Card>
      ))}
    </Screen>
  );
}
