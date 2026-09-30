import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { Card, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

interface SignalRow {
  instrument_id: string;
  decision: string;
  regime: string;
  quality: number;
  entry: number | null;
  stop: number | null;
  targets: string;
  strategies_agreeing: number;
  strategies_total: number;
  risk_decision: string | null;
  risk_failed_check: string | null;
}

const band = (q: number) => (q >= 0.7 ? "HIGH" : q >= 0.4 ? "MEDIUM" : "LOW");

export default function AiTrading() {
  const signals = useQuery({ queryKey: qk.signals, queryFn: api.signals });
  const session = useQuery({ queryKey: qk.session, queryFn: api.session });
  const latest = (signals.data?.[0] ?? null) as SignalRow | null;

  return (
    <Screen title="AI Trading">
      <Card title="Market session">
        <Row label="Phase" value={session.data?.phase ?? "—"} />
        <Row label="New entries allowed" value={session.data?.canOpenNewPosition ? "Yes" : "No"} />
      </Card>
      {latest ? (
        <Card title="Latest signal">
          <Row label="Market" value={latest.instrument_id} />
          <Row label="Regime" value={latest.regime} />
          <Row label="AI signal" value={latest.decision} />
          <Row label="Signal quality" value={band(latest.quality)} />
          <Row label="Entry" value={latest.entry ?? "—"} />
          <Row label="Stop loss" value={latest.stop ?? "—"} />
          <Row
            label="Take profit"
            value={(JSON.parse(latest.targets || "[]") as number[]).join(" / ") || "—"}
          />
          <Row
            label="Strategies agreeing"
            value={`${latest.strategies_agreeing} / ${latest.strategies_total}`}
          />
          <Row
            label="Risk gateway"
            value={latest.risk_decision ?? "PENDING"}
            tone={
              latest.risk_decision === "APPROVED"
                ? "good"
                : latest.risk_decision === "REJECTED"
                  ? "bad"
                  : undefined
            }
          />
          {latest.risk_failed_check ? (
            <Row label="Rejected by" value={latest.risk_failed_check} tone="bad" />
          ) : null}
        </Card>
      ) : (
        <Card title="Latest signal">
          <Muted>No signals yet. The AI is allowed (and often expected) to choose NO_TRADE.</Muted>
        </Card>
      )}
      <Card title="AI">
        <Link href="/ai/signals" style={{ color: "#4ea1ff" }}>
          All signals →
        </Link>
        <Link href="/ai/market-regime" style={{ color: "#4ea1ff" }}>
          Market regime →
        </Link>
        <Link href="/ai/strategies" style={{ color: "#4ea1ff" }}>
          Strategies →
        </Link>
        <Link href="/ai/model-status" style={{ color: "#4ea1ff" }}>
          Model status →
        </Link>
      </Card>
      <Muted>Signal quality is a relative score, not a probability of profit.</Muted>
    </Screen>
  );
}
