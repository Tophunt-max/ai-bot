import { Link, router } from "expo-router";
import { AccountSwitcher } from "../../src/components/account";
import { Button, Card, Screen } from "../../src/components/ui";
import { useAuth } from "../../src/stores/auth";

const link = { color: "#4ea1ff", paddingVertical: 6 } as const;

export default function Profile() {
  const signOut = useAuth((s) => s.signOut);
  return (
    <Screen title="Profile">
      <AccountSwitcher />
      <Card title="Risk">
        <Link href="/risk/overview" style={link}>
          Risk overview →
        </Link>
        <Link href="/risk/limits" style={link}>
          Risk limits →
        </Link>
        <Link href="/risk/drawdown" style={link}>
          Drawdown →
        </Link>
      </Card>
      <Card title="Backtesting">
        <Link href="/backtest" style={link}>
          Backtests →
        </Link>
      </Card>
      <Card title="Settings">
        <Link href="/settings/broker" style={link}>
          Broker →
        </Link>
        <Link href="/settings/notifications" style={link}>
          Notifications →
        </Link>
        <Link href="/settings/security" style={link}>
          Security →
        </Link>
      </Card>
      <Card title="Controls">
        <Link href="/admin/controls" style={link}>
          Trading controls →
        </Link>
        <Link href="/admin/kill-switch" style={link}>
          Kill switch →
        </Link>
        <Link href="/admin/audit-logs" style={link}>
          Audit logs →
        </Link>
      </Card>
      <Button
        label="Sign out"
        tone="ghost"
        onPress={async () => {
          await signOut();
          router.replace("/(auth)/login");
        }}
      />
    </Screen>
  );
}
