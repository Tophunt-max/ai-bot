import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function Strategies() {
  const q = useQuery({ queryKey: qk.strategies, queryFn: api.strategies });
  return (
    <Screen title="Strategies">
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      <Card>
        {(q.data ?? []).map((st) => (
          <Row
            key={st.id}
            label={st.name}
            value={st.enabled ? "ENABLED" : "DISABLED"}
            tone={st.enabled ? "good" : undefined}
          />
        ))}
      </Card>
      <Muted>Strategies only produce candidate signals. They can never place orders.</Muted>
    </Screen>
  );
}
