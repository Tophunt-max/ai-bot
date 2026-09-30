import type { AccountKind, Market } from "@atb/shared-types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { api, qk } from "../lib/api";
import { ACCOUNT_THEME, selectAccount, useAccount } from "../stores/account";
import { colors } from "./ui";

function confirmReal(market: Market): Promise<boolean> {
  const msg =
    market === "CRYPTO"
      ? "You are switching to REAL crypto trading. Orders use your actual exchange funds. Crypto is not SEBI-regulated; 30% tax + 1% TDS apply. Continue?"
      : "You are switching to the REAL MONEY stock account. Orders use your actual broker funds. Continue?";
  if (Platform.OS === "web")
    return Promise.resolve(typeof window !== "undefined" ? window.confirm(msg) : false);
  return new Promise((resolve) =>
    Alert.alert("Switch to REAL money?", msg, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Switch to REAL", style: "destructive", onPress: () => resolve(true) },
    ]),
  );
}

function Segments<T extends string>({
  options,
  value,
  onChange,
  activeColor,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  activeColor: string;
}) {
  return (
    <View style={st.switch} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[st.seg, active && { backgroundColor: activeColor }]}
          >
            <Text style={[st.segText, active && { color: "#fff" }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Two switches: market (📈 Stocks | 🪙 Crypto) and type (🧪 Demo | 💰 Real). Four fully separate
 * books. Switching clears all cached data so they never mix; REAL asks for confirmation.
 */
export function AccountSwitcher() {
  const { account, market, kind, setAccount } = useAccount();
  const qc = useQueryClient();
  const go = async (m: Market, k: AccountKind) => {
    const next = selectAccount(m, k);
    if (next === account) return;
    if (k === "REAL" && !(await confirmReal(m))) return;
    qc.removeQueries();
    await setAccount(next);
  };
  const color = ACCOUNT_THEME[account].color;
  return (
    <View style={{ gap: 6 }}>
      <Segments
        options={[
          { value: "STOCKS", label: "📈 Stocks" },
          { value: "CRYPTO", label: "🪙 Crypto" },
        ]}
        value={market}
        onChange={(m) => void go(m, kind)}
        activeColor={color}
      />
      <Segments
        options={[
          { value: "DEMO", label: "🧪 Demo Trading" },
          { value: "REAL", label: "💰 Real Trading" },
        ]}
        value={kind}
        onChange={(k) => void go(market, k)}
        activeColor={color}
      />
    </View>
  );
}

/** Always-visible strip so it is impossible to confuse the books. */
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
