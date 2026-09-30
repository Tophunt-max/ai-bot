import { Card, Muted, Row, Screen } from "../../src/components/ui";

export default function ModelStatus() {
  return (
    <Screen title="Model status">
      <Card title="Active model">
        <Row label="Version" value="baseline-0.1.0" />
        <Row label="Status" value="PAPER" />
        <Row label="Behaviour" value="Observation only (NO_TRADE)" />
      </Card>
      <Muted>
        Lifecycle: DRAFT → VALIDATING → PAPER → SHADOW → CANARY → PRODUCTION. New models are never
        auto-deployed to production. Drift or degradation reduces risk or disables the model.
      </Muted>
    </Screen>
  );
}
