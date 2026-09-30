import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { Pressable } from "react-native";
import { Card, ErrorText, Loading, Muted, Row, Screen, inr } from "../../src/components/ui";
import { api } from "../../src/lib/api";

export default function Backtests() {
  const q = useQuery({ queryKey: ["backtests"], queryFn: api.backtests });
  return (
    <Screen title="Backtests">
      <Muted>
        Run on your machine: `pnpm --filter @atb/backtesting backtest -- --csv data/INFY-5m.csv
        --walk-forward`. Reports uploaded via POST /backtests/report show here. Only the walk-forward
        (out-of-sample) verdict matters.
      </Muted>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      {!q.isLoading && (q.data ?? []).length === 0 ? <Muted>No backtests yet.</Muted> : null}
      {(q.data ?? []).map((b) => {
        const m = JSON.parse(b.metrics || "{}") as Record<string, number | string>;
        return (
          <Pressable
            key={b.id}
            onPress={() => router.push({ pathname: "/backtest/result", params: { id: b.id } })}
          >
            <Card
              title={`${b.strategy ?? "ensemble"} · ${new Date(b.created_at).toLocaleDateString("en-IN")}`}
            >
              <Row
                label="Verdict"
                value={String(m.verdict ?? b.status)}
                tone={m.verdict === "PASS" ? "good" : m.verdict === "FAIL" ? "bad" : undefined}
              />
              <Row label="Net P&L" value={inr(Number(m.netPnl))} />
              <Row label="Sharpe" value={Number(m.sharpe ?? 0).toFixed(2)} />
              <Row label="Max drawdown" value={`${Number(m.maxDrawdownPct ?? 0).toFixed(2)}%`} />
            </Card>
          </Pressable>
        );
      })}
    </Screen>
  );
}
