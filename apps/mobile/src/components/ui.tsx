import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BannerSlot } from "./banner-slot";

export const colors = {
  bg: "#0b0f14",
  card: "#131a22",
  border: "#1f2a36",
  text: "#e6edf3",
  muted: "#8b98a5",
  green: "#2ecc71",
  red: "#ff5c5c",
  amber: "#f5a623",
  blue: "#4ea1ff",
};

export const inr = (n: number | undefined | null) =>
  n === undefined || n === null || Number.isNaN(n)
    ? "—"
    : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export function Screen({
  children,
  title,
  banner = true,
}: {
  children: ReactNode;
  title?: string;
  banner?: boolean;
}) {
  return (
    <SafeAreaView style={s.screen} edges={["top", "left", "right"]}>
      <ScrollView contentContainerStyle={s.scroll}>
        {banner ? <BannerSlot /> : null}
        {title ? <Text style={s.title}>{title}</Text> : null}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Card({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <View style={s.card}>
      {title ? <Text style={s.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}

export function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: "good" | "bad" | "warn";
}) {
  const color =
    tone === "good"
      ? colors.green
      : tone === "bad"
        ? colors.red
        : tone === "warn"
          ? colors.amber
          : colors.text;
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.value, { color }]}>{value}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  tone = "primary",
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: "primary" | "danger" | "ghost";
  disabled?: boolean;
}) {
  const bg = tone === "danger" ? colors.red : tone === "ghost" ? "transparent" : colors.blue;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <Text style={s.btnText}>{label}</Text>
    </Pressable>
  );
}

export function Loading() {
  return <ActivityIndicator color={colors.blue} style={{ marginTop: 24 }} />;
}

export function ErrorText({ error }: { error: unknown }) {
  return (
    <Text style={{ color: colors.red, marginVertical: 8 }}>
      {error instanceof Error ? error.message : String(error)}
    </Text>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: 16, gap: 12 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700", marginBottom: 4 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  cardTitle: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3 },
  label: { color: colors.muted, fontSize: 14 },
  value: { color: colors.text, fontSize: 14, fontWeight: "600" },
  btn: {
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  btnText: { color: "#fff", fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 13 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    padding: 12,
    fontSize: 16,
  },
});
