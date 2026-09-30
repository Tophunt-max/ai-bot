import { Link } from "expo-router";
import { Card, Muted, Screen } from "../../src/components/ui";

export default function Backtests() {
  return (
    <Screen title="Backtests">
      <Card>
        <Muted>
          The event-driven backtester (commissions, STT, slippage, gaps, session rules, walk-forward) arrives
          in Phase 7. Jobs are queued via POST /api/v1/backtests and reports are stored in R2.
        </Muted>
        <Link href="/backtest/result" style={{ color: "#4ea1ff", marginTop: 8 }}>
          Sample result layout →
        </Link>
      </Card>
    </Screen>
  );
}
