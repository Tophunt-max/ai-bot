import { describe, expect, it } from "vitest";
import { runBacktest, syntheticSession } from "@atb/engine";
import { summarize, tradesCsv } from "../src/report";

describe("report", () => {
  it("renders a summary and a trades CSV", () => {
    const r = runBacktest(
      [
        {
          instrument: {
            id: "NSE:S",
            exchange: "NSE",
            tradingSymbol: "S",
            instrumentType: "EQ",
            lotSize: 1,
            tickSize: 0.05,
          },
          candles: syntheticSession({ days: 40 }),
        },
      ],
      { timeframeMs: 300_000 },
    );
    expect(summarize(r)).toContain("Profit factor");
    const csv = tradesCsv(r.trades).split("\n");
    expect(csv[0]).toContain("netPnl");
    expect(csv.length).toBe(r.trades.length + 1);
  });
});
