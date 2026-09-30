/**
 * Download historical candles from Zerodha Kite (needs the historical-data add-on).
 *
 *   ZERODHA_API_KEY=... ZERODHA_ACCESS_TOKEN=... \
 *   pnpm --filter @atb/backtesting download:kite -- --token 408065 --symbol INFY --tf 5m --from 2024-01-01 --to 2025-12-31
 *
 * Writes data/<SYMBOL>-<tf>.csv (timestamp,open,high,low,close,volume). Read-only API: works from any IP.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ZerodhaAdapter } from "@atb/brokers";
import { candlesToCsv, validateCandles, TIMEFRAME_MS } from "@atb/engine";
import type { Timeframe } from "@atb/shared-types";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    token: { type: "string" },
    symbol: { type: "string" },
    tf: { type: "string", default: "5m" },
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string", default: "data" },
  },
});

const apiKey = process.env.ZERODHA_API_KEY;
const accessToken = process.env.ZERODHA_ACCESS_TOKEN;
if (!apiKey || !accessToken) throw new Error("set ZERODHA_API_KEY and ZERODHA_ACCESS_TOKEN");
if (!values.token || !values.symbol || !values.from || !values.to)
  throw new Error("--token --symbol --from --to required");

const tf = values.tf as Timeframe;
const kite = new ZerodhaAdapter({ apiKey, accessToken, timeoutMs: 20_000 });
const candles = await kite.getHistorical(values.token, tf, new Date(values.from), new Date(values.to));
const v = validateCandles(candles, TIMEFRAME_MS[tf]);
mkdirSync(values.out!, { recursive: true });
const file = `${values.out}/${values.symbol}-${tf}.csv`;
writeFileSync(file, candlesToCsv(v.clean));
console.info(`${file}: ${v.clean.length} candles (${v.issues.length} issues dropped/flagged)`);
