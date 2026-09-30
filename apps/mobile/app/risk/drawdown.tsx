import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { Card, Loading, Muted, Row, Screen, colors, inr } from "../../src/components/ui";
import { api, qk } from "../../src/lib/api";

export default function Drawdown() {
  const q = useQuery({ queryKey: qk.risk, queryFn: api.risk });
  if (!q.data)
    return (
      <Screen title="Drawdown">
        <Loading />
      </Screen>
    );
  const { state: st, limits } = q.data;
  const dd = st.peakEquity > 0 ? ((st.peakEquity - st.equity) / st.peakEquity) * 100 : 0;
  const used = Math.min(100, (dd / limits.maxDrawdownPct) * 100);
  return (
    <Screen title="Drawdown">
      <Card>
        <Row label="Peak equity" value={inr(st.peakEquity)} />
        <Row label="Current equity" value={inr(st.equity)} />
        <Row label="Drawdown" value={`${dd.toFixed(2)}%`} />
        <Row label="Limit" value={`${limits.maxDrawdownPct}%`} />
        <View style={{ height: 8, backgroundColor: colors.border, borderRadius: 4, marginTop: 8 }}>
          <View
            style={{
              width: `${used}%`,
              height: 8,
              borderRadius: 4,
              backgroundColor: used > 75 ? colors.red : colors.amber,
            }}
          />
        </View>
      </Card>
      <Muted>Reaching the limit locks trading automatically and requires a manual, audited unlock.</Muted>
    </Screen>
  );
}
