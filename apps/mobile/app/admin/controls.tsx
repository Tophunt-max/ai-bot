import { ACCOUNT_ALLOWED_MODES, type TradingMode } from "@atb/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { TextInput } from "react-native";
import { Button, Card, ErrorText, Muted, Row, Screen, colors, s } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";
import { useAccount } from "../../src/stores/account";

export default function Controls() {
  const qc = useQueryClient();
  const account = useAccount((s) => s.account);
  const MODES = ACCOUNT_ALLOWED_MODES[account];
  const acc = useQuery({ queryKey: qk.account, queryFn: api.account });
  const [confirmation, setConfirmation] = useState("");
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.account });
    void qc.invalidateQueries({ queryKey: qk.portfolio });
  };
  const mode = useMutation({
    mutationFn: (m: TradingMode) => api.setMode(m, "changed from app", confirmation || undefined),
    onSuccess: invalidate,
  });
  const trading = useMutation({
    mutationFn: (enabled: boolean) => api.setTradingEnabled(enabled, "toggled from app"),
    onSuccess: invalidate,
  });

  return (
    <Screen title="Trading controls">
      <Card title="State">
        <Row label="Mode" value={acc.data?.mode ?? "—"} />
        <Row
          label="Trading enabled"
          value={acc.data?.tradingEnabled ? "YES" : "NO"}
          tone={acc.data?.tradingEnabled ? "warn" : undefined}
        />
        <Row
          label="Kill switch"
          value={acc.data?.killSwitch.active ? "ACTIVE" : "off"}
          tone={acc.data?.killSwitch.active ? "bad" : "good"}
        />
        <Row label="Active gateway" value={acc.data?.lease?.nodeId ?? "none"} />
      </Card>
      <Card title="Trading">
        <Button label="Enable trading" onPress={() => trading.mutate(true)} />
        <Button label="Disable trading" tone="danger" onPress={() => trading.mutate(false)} />
        {trading.error ? <ErrorText error={trading.error} /> : null}
      </Card>
      <Card title="Mode">
        <Muted>
          {account === "demo" || account === "crypto_demo"
            ? "DEMO account: always virtual money (PAPER). It can never send orders to your real broker."
            : "REAL account: SHADOW (no orders) → CANARY (small real size) → LIVE. CANARY/LIVE need the typed confirmation “ENABLE CANARY” / “ENABLE LIVE”; LIVE only from CANARY."}
        </Muted>
        <TextInput
          style={s.input}
          value={confirmation}
          onChangeText={setConfirmation}
          placeholder="confirmation"
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
        />
        {MODES.map((m) => (
          <Button
            key={m}
            label={`Switch to ${m}`}
            tone={m === "LIVE" ? "danger" : "primary"}
            onPress={() => mode.mutate(m)}
          />
        ))}
        {mode.error ? <ErrorText error={mode.error} /> : null}
      </Card>
    </Screen>
  );
}
