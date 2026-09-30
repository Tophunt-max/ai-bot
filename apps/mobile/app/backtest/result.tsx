import { Card, Muted, Row, Screen } from "../../src/components/ui";

const METRICS = [
  "Net P&L",
  "CAGR",
  "Sharpe",
  "Sortino",
  "Max drawdown",
  "Win rate",
  "Profit factor",
  "Expectancy",
  "Average win",
  "Average loss",
  "Risk of ruin",
];

export default function BacktestResult() {
  return (
    <Screen title="Backtest result">
      <Card title="Out-of-sample metrics">
        {METRICS.map((m) => (
          <Row key={m} label={m} value="—" />
        ))}
      </Card>
      <Muted>Ranked by risk-adjusted, out-of-sample performance — never by maximum backtest profit.</Muted>
    </Screen>
  );
}
