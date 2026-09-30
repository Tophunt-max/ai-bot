import type { AccountId } from "@atb/shared-types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { api, qk } from "../lib/api";
import { ACCOUNT_THEME, useAccount } from "../stores/account";
import { colors } from "./ui";

function confirmReal(): Promise<boolean> {
  const msg =
    "You are switching to the REAL MONEY account. Orders placed here use your actual broker funds. Continue?";
  if (Platform.OS === "web") {
    return Promise.resolve(typeof window !== "undefined" ? window.confirm(msg) : false);
  }
  return new Promise((resolve) =>
    Alert.alert("Switch to REAL money?", msg, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Switch to REAL", style: "destructive", onPress: () => resolve(true) },
    ]),
  );
}

/** Segmented DEMO | REAL switch. Switching clears all cached data so books never mix. */
export function AccountSwitcher() {
  const { account, setAccount } = useAccount();
  const qc = useQueryClient();
  const choose = async (a: AccountId) => {
    if (a === account) return;
    if (a === "real" && !(await confirmReal())) return;
    qc.removeQueries();
    await setAccount(a);
  };
  return (
    <View style={st.switch} accessibilityRole="tablist">
      {(["demo", "real"] as const).map((a) => {
        const t = ACCOUNT_THEME[a];
        const active = a === account;
        return (
          <Pressable
            key={a}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => void choose(a)}
            style={[st.seg, active && { backgroundColor: t.color }]}
          >
            <Text style={[st.segText, active && { color: "#fff" }]}>
              {t.emoji} {a === "demo" ? "Demo Trading" : "Real Trading"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Always-visible strip so it is impossible to confuse the two books. */
export function AccountBanner() {
  const account = useAccount((s) => s.account);
  const t = ACCOUNT_THEME[account];
  const acc = useQuery({ queryKey: qk.account, queryFn: api.account, staleTime: 10_000 });
  return (
    <View style={[st.banner, { backgroundColor: t.color }]}>
      <Text style={st.bannerTitle}>
        {t.emoji} {t.label}
        {acc.data ? ` · ${acc.data.mode}` : ""}
        {acc.data?.killSwitch.active ? " · KILL SWITCH" : ""}
      </Text>
      <Text style={st.bannerSub}>{t.sub}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  switch: {
    flexDirection: "row",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  seg: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  segText: { color: colors.muted, fontWeight: "700" },
  banner: { borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12 },
  bannerTitle: { color: "#fff", fontWeight: "800", letterSpacing: 0.5 },
  bannerSub: { color: "#ffffffcc", fontSize: 12, marginTop: 2 },
});
