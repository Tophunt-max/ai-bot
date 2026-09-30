import { Redirect, Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { colors } from "../../src/components/ui";
import { useRealtime } from "../../src/lib/realtime";
import { ACCOUNT_THEME, useAccount } from "../../src/stores/account";
import { useAuth } from "../../src/stores/auth";

const icon =
  (glyph: string) =>
  ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function TabsLayout() {
  const token = useAuth((s) => s.token);
  const account = useAccount((s) => s.account);
  useRealtime();
  if (!token) return <Redirect href="/(auth)/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: ACCOUNT_THEME[account].color,
          borderTopWidth: 2,
        },
        tabBarActiveTintColor: ACCOUNT_THEME[account].color,
        tabBarInactiveTintColor: colors.muted,
      }}
    >
      <Tabs.Screen name="dashboard" options={{ title: "Dashboard", tabBarIcon: icon("◎") }} />
      <Tabs.Screen name="trading" options={{ title: "AI Trading", tabBarIcon: icon("⚡") }} />
      <Tabs.Screen name="positions" options={{ title: "Positions", tabBarIcon: icon("▤") }} />
      <Tabs.Screen name="history" options={{ title: "History", tabBarIcon: icon("↺") }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: icon("☰") }} />
    </Tabs>
  );
}
