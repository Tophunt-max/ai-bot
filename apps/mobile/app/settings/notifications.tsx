import * as Notifications from "expo-notifications";
import { useState } from "react";
import { Platform } from "react-native";
import { Button, Card, Muted, Row, Screen } from "../../src/components/ui";

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
  return (
    <Screen title="Notifications">
      <Card title="Push">
        <Row label="Permission" value={status} />
        <Button
          label="Enable push notifications"
          disabled={Platform.OS === "web"}
          onPress={async () => {
            const r = await Notifications.requestPermissionsAsync();
            setStatus(r.status);
          }}
        />
      </Card>
      <Card title="Events">
        {EVENTS.map((e) => (
          <Row key={e} label={e} value="Push + Telegram" />
        ))}
      </Card>
      <Muted>Telegram is configured with TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID Worker secrets.</Muted>
    </Screen>
  );
}
