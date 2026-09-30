import { Card, Muted, Row, Screen } from "../../src/components/ui";

export default function Security() {
  return (
    <Screen title="Security">
      <Card>
        <Row label="Session storage" value="Expo SecureStore" />
        <Row label="Broker secrets on device" value="Never" tone="good" />
        <Row label="API access" value="Owner JWT + Cloudflare Access" />
        <Row label="MFA" value="Planned (TOTP)" tone="warn" />
      </Card>
      <Muted>
        Sensitive actions (mode change, risk limits, kill switch) are written to an append-only audit log.
      </Muted>
    </Screen>
  );
}
