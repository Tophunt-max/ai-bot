import { useQuery } from "@tanstack/react-query";
import { Card, ErrorText, Loading, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function AuditLogs() {
  const q = useQuery({ queryKey: qk.audit, queryFn: api.auditLogs });
  return (
    <Screen title="Audit logs">
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      {!q.isLoading && (q.data ?? []).length === 0 ? <Muted>No entries.</Muted> : null}
      {(q.data ?? []).map((r) => (
        <Card key={String(r.id)} title={new Date(Number(r.created_at)).toLocaleString("en-IN")}>
          <Row label="Action" value={String(r.action)} />
          <Row label="Actor" value={String(r.actor)} />
          {r.target ? <Row label="Target" value={String(r.target)} /> : null}
        </Card>
      ))}
    </Screen>
  );
}
