import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function BrokerSettings() {
  const q = useQuery({ queryKey: qk.brokers, queryFn: api.brokers, staleTime: 3_600_000 });
  return (
    <Screen title="Broker">
      <Muted>
        Broker credentials are configured only on the Execution Gateway (static-IP server), never in this app.
        Orders are sent only from the whitelisted IP.
      </Muted>
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      <Card title="Supported Indian brokers">
        {(q.data ?? []).map((b) => (
          <Row
            key={b.id}
            label={b.name}
            value={b.adapter === "implemented" ? "READY" : "PLANNED"}
            tone={b.adapter === "implemented" ? "good" : undefined}
          />
        ))}
      </Card>
    </Screen>
  );
}
