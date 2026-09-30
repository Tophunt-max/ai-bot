import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorText, Loading, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function Strategies() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.strategies, queryFn: api.strategies });
  const perf = useQuery({ queryKey: ["perf"], queryFn: () => api.performance() });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      api.setStrategyEnabled(v.id, v.enabled, "toggled from app"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.strategies }),
  });
  const statsFor = (id: string) => perf.data?.strategy.find((r) => (r.k ?? "").includes(id));

  return (
    <Screen title="Strategies">
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      {toggle.error ? <ErrorText error={toggle.error} /> : null}
      {(q.data ?? []).map((st) => {
        const s = statsFor(st.id);
        return (
          <Card key={st.id} title={st.name}>
            <Row
              label="Status"
              value={st.enabled ? "ENABLED" : "DISABLED"}
              tone={st.enabled ? "good" : undefined}
            />
            <Row label="Trades" value={s ? String(s.n) : "0"} />
            <Row
              label="Avg R"
              value={s?.avg_r != null ? s.avg_r.toFixed(2) : "—"}
              tone={(s?.avg_r ?? 0) < 0 ? "bad" : undefined}
            />
            <Button
              label={st.enabled ? "Disable" : "Enable"}
              tone={st.enabled ? "danger" : "primary"}
              onPress={() => toggle.mutate({ id: st.id, enabled: !st.enabled })}
            />
          </Card>
        );
      })}
      <Muted>
        Strategies only produce candidate signals. They can never place orders, and cannot be enabled in
        SAFE_MODE.
      </Muted>
    </Screen>
  );
}
