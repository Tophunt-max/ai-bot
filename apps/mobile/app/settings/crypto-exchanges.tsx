import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Card, ErrorText, Loading, Muted, Row, Screen, colors, s } from "../../src/components/ui";
import { api } from "../../src/lib/api";

const FILTERS = [
  { id: "INDIA", label: "🇮🇳 India-ready" },
  { id: "ALL", label: "All" },
  { id: "PERP", label: "Perpetuals" },
] as const;

const INDIA_LABEL: Record<string, { text: string; tone?: "good" | "bad" | "warn" }> = {
  FIU_REGISTERED_REPORTED: { text: "FIU-IND registered (reported)", tone: "good" },
  INDIAN_EXCHANGE: { text: "Indian exchange", tone: "good" },
  EXITED_INDIA: { text: "Exited India", tone: "bad" },
  REGION_LOCKED: { text: "Region-locked", tone: "bad" },
  NOT_VERIFIED_FOR_INDIA: { text: "Not verified for India", tone: "warn" },
  NOT_IN_CCXT: { text: "Not supported yet", tone: "warn" },
};

export default function CryptoExchanges() {
  const q = useQuery({ queryKey: ["crypto-exchanges"], queryFn: api.cryptoExchanges, staleTime: 86_400_000 });
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("INDIA");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = q.data?.exchanges ?? [];
    return all
      .filter((e) =>
        filter === "INDIA"
          ? e.india === "FIU_REGISTERED_REPORTED" ||
            e.india === "INDIAN_EXCHANGE" ||
            e.india === "NOT_IN_CCXT"
          : filter === "PERP"
            ? e.perp
            : true,
      )
      .filter((e) => !search || `${e.id} ${e.name}`.toLowerCase().includes(search.toLowerCase()));
  }, [q.data, filter, search]);

  return (
    <Screen title="Crypto exchanges">
      <Muted>
        {q.data ? `${q.data.exchanges.length} exchanges via CCXT ${q.data.ccxtVersion}. ` : ""}
        Set the gateway's CRYPTO_EXCHANGE to the id shown. {q.data?.disclaimer}
      </Muted>
      <View style={{ flexDirection: "row", gap: 6 }}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.id}
            onPress={() => setFilter(f.id)}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 20,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: filter === f.id ? colors.blue : colors.card,
            }}
          >
            <Text style={{ color: "#fff", fontWeight: "600" }}>{f.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={s.input}
        value={search}
        onChangeText={setSearch}
        placeholder="Search (binance, delta, zebpay…)"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
      />
      {q.isLoading ? <Loading /> : null}
      {q.error ? <ErrorText error={q.error} /> : null}
      {rows.map((e) => {
        const india = INDIA_LABEL[e.india] ?? { text: e.india };
        return (
          <Card key={e.id} title={`${e.name} · ${e.id}`}>
            <Row label="India" value={india.text} tone={india.tone} />
            <Row
              label="Markets"
              value={
                [e.spot ? "Spot" : null, e.perp ? "Perpetuals" : null].filter(Boolean).join(" + ") || "—"
              }
            />
            <Row label="Live stream (websocket)" value={e.websocket ? "Yes" : "Polling"} />
            <Row
              label="History for backtests"
              value={e.ohlcv ? "Yes" : "No"}
              tone={e.ohlcv ? undefined : "warn"}
            />
            {e.note ? <Muted>{e.note}</Muted> : null}
          </Card>
        );
      })}
      {!q.isLoading && rows.length === 0 ? <Muted>No exchanges match.</Muted> : null}
    </Screen>
  );
}
