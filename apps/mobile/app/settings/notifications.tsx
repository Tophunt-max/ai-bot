import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useState } from "react";
import { Platform } from "react-native";
import { Button, Card, ErrorText, Muted, Row, Screen } from "../../src/components/ui";
import { api } from "../../src/lib/api";

const EVENTS = [
  "NEW_SIGNAL",
  "TRADE_OPENED",
  "TRADE_CLOSED",
  "SL_HIT",
  "TP_HIT",
  "DAILY_LOSS_WARNING",
  "DRAWDOWN_WARNING",
  "KILL_SWITCH",
  "BROKER_ERROR",
  "MODEL_ALERT",
];

export default function NotificationSettings() {
  const [status, setStatus] = useState<string>("unknown");
  const [error, setError] = useState<unknown>(null);

  const enable = async () => {
    setError(null);
    try {
      const perm = await Notifications.requestPermissionsAsync();
      setStatus(perm.status);
      if (perm.status !== "granted") return;
      const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas
        ?.projectId;
      const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
      await api.registerPushToken(token.data, Platform.OS);
      setStatus("registered");
    } catch (e) {
      setError(e);
    }
  };

  return (
    <Screen title="Notifications">
      <Card title="Push">
        <Row label="Status" value={status} tone={status === "registered" ? "good" : undefined} />
        <Button label="Enable push notifications" disabled={Platform.OS === "web"} onPress={enable} />
        {error ? <ErrorText error={error} /> : null}
      </Card>
      <Card title="Events">
        {EVENTS.map((e) => (
          <Row key={e} label={e} value="Push + Telegram" />
        ))}
      </Card>
      <Muted>
        Telegram uses the TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID Worker secrets. Duplicate alerts are
        suppressed.
      </Muted>
    </Screen>
  );
}
