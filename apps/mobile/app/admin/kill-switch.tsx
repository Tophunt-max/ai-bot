import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorText, Muted, Row, Screen } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function KillSwitch() {
  const qc = useQueryClient();
  const acc = useQuery({ queryKey: qk.account, queryFn: api.account });
  const m = useMutation({
    mutationFn: (active: boolean) =>
      api.killSwitch(active, active ? "manual kill switch from app" : "manual reset from app"),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.account });
      void qc.invalidateQueries({ queryKey: qk.portfolio });
    },
  });
  const ks = acc.data?.killSwitch;
  return (
    <Screen title="Kill switch">
      <Card>
        <Row label="Status" value={ks?.active ? "ACTIVE" : "off"} tone={ks?.active ? "bad" : "good"} />
        {ks?.trigger ? <Row label="Trigger" value={ks.trigger} /> : null}
        {ks?.reason ? <Row label="Reason" value={ks.reason} /> : null}
      </Card>
      <Button
        label="ACTIVATE KILL SWITCH"
        tone="danger"
        onPress={() => m.mutate(true)}
        disabled={m.isPending}
      />
      <Button
        label="Reset kill switch"
        tone="ghost"
        onPress={() => m.mutate(false)}
        disabled={m.isPending || !ks?.active}
      />
      {m.error ? <ErrorText error={m.error} /> : null}
      <Muted>
        Activation blocks new orders, forces SAFE_MODE and locks risk. Resetting does not leave SAFE_MODE —
        change the mode explicitly afterwards.
      </Muted>
    </Screen>
  );
}
