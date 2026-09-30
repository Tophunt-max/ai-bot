/**
 * Download crypto candles from ANY CCXT exchange (public data, no API key needed).
 *
 *   pnpm --filter @atb/backtesting download:crypto -- --exchange binance --symbol BTC/USDT --tf 5m --from 2025-01-01 --to 2026-09-01
 *
 * Writes data/<exchange>_<BASE>-<QUOTE>-<tf>.csv and a matching .instrument.json (lot/tick sizes
 * from the exchange) that the backtest CLI can use with --instrument.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CcxtAdapter } from "@atb/brokers";
import { TIMEFRAME_MS, candlesToCsv, validateCandles } from "@atb/engine";
import type { Timeframe } from "@atb/shared-types";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    exchange: { type: "string", default: "binance" },
    symbol: { type: "string", default: "BTC/USDT" },
    tf: { type: "string", default: "5m" },
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string", default: "data" },
  },
});

const tf = values.tf as Timeframe;
const to = values.to ? new Date(values.to) : new Date();
const from = values.from ? new Date(values.from) : new Date(to.getTime() - 90 * 86_400_000);
const quote = values.symbol!.split("/")[1]?.split(":")[0] ?? "USDT";
const a = new CcxtAdapter({
  exchangeId: values.exchange!,
  quoteCurrency: quote,
  instruments: [],
  timeoutMs: 20_000,
});

const instrument = await a.instrumentFor(values.symbol!);
const candles = await a.getHistorical(values.symbol!, tf, from, to);
const v = validateCandles(candles, TIMEFRAME_MS[tf], { sessionBreakMs: 0 });
const base = `${values.out}/${values.exchange}_${values.symbol!.replace(/[/:]/g, "-")}-${tf}`;
mkdirSync(values.out!, { recursive: true });
writeFileSync(`${base}.csv`, candlesToCsv(v.clean));
writeFileSync(`${base}.instrument.json`, JSON.stringify(instrument, null, 2));
const gaps = v.issues.filter((i) => i.type === "MISSING_CANDLES").length;
console.info(`${base}.csv: ${v.clean.length} candles (${gaps} gaps, ${v.issues.length - gaps} other issues)`);
console.info(
  `${base}.instrument.json: lot ${instrument.lotSize}, tick ${instrument.tickSize}, min notional ${instrument.minNotional ?? "-"}`,
);
