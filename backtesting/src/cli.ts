/**
 * Backtest CLI.
 *
 *   pnpm --filter @atb/backtesting backtest -- --csv data/INFY-5m.csv --symbol INFY
 *   pnpm --filter @atb/backtesting backtest -- --csv data/NIFTYFUT.csv --symbol NIFTY26OCTFUT \
 *        --exchange NFO --type FUT --lot 75 --margin 0.15 --walk-forward --folds 4
 *   pnpm --filter @atb/backtesting backtest -- --synthetic 120      (pipeline smoke test only)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  TIMEFRAME_MS,
  parseCandlesCsv,
  runBacktest,
  runWalkForward,
  syntheticSession,
  validateCandles,
  type SeriesInput,
} from "@atb/engine";
import {
  EXCHANGES,
  INSTRUMENT_TYPES,
  PRODUCT_TYPES,
  TIMEFRAMES,
  type Exchange,
  type InstrumentType,
  type ProductType,
  type Timeframe,
  type Instrument,
} from "@atb/shared-types";
import { CRYPTO_SESSION, DEFAULT_LIMITS } from "@atb/trading-core";
import { setReportCurrency, summarize, summarizeWalkForward, tradesCsv } from "./report";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    csv: { type: "string", multiple: true },
    /** Instrument JSON (e.g. from download:crypto). Required for CRYPTO. */
    instrument: { type: "string", multiple: true },
    symbol: { type: "string", multiple: true },
    exchange: { type: "string", default: "NSE" },
    type: { type: "string", default: "EQ" },
    lot: { type: "string", default: "1" },
    tick: { type: "string", default: "0.05" },
    tf: { type: "string", default: "5m" },
    product: { type: "string", default: "INTRADAY" },
    margin: { type: "string", default: "0.2" },
    capital: { type: "string", default: "1000000" },
    risk: { type: "string", default: "0.5" },
    slippage: { type: "string", default: "3" },
    "walk-forward": { type: "boolean", default: false },
    folds: { type: "string", default: "4" },
    synthetic: { type: "string" },
    out: { type: "string", default: "backtest-output" },
    upload: { type: "boolean", default: false },
  },
});

function oneOf<T extends string>(v: string, allowed: readonly T[], name: string): T {
  if (!allowed.includes(v as T)) throw new Error(`--${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

const tf = oneOf<Timeframe>(values.tf!, TIMEFRAMES, "tf");
const exchange = oneOf<Exchange>(values.exchange!, EXCHANGES, "exchange");
const itype = oneOf<InstrumentType>(values.type!, INSTRUMENT_TYPES, "type");
const product = oneOf<ProductType>(values.product!, PRODUCT_TYPES, "product");

const series: SeriesInput[] = [];
if (values.synthetic) {
  series.push({
    instrument: {
      id: "NSE:SYNTH",
      exchange: "NSE",
      tradingSymbol: "SYNTH",
      instrumentType: "EQ",
      lotSize: 1,
      tickSize: 0.05,
    },
    candles: syntheticSession({ days: Number(values.synthetic), timeframeMin: TIMEFRAME_MS[tf] / 60_000 }),
  });
  console.warn(
    "⚠  Synthetic data: this only tests the pipeline. It says NOTHING about real profitability.\n",
  );
} else {
  const files = values.csv ?? [];
  if (files.length === 0) throw new Error("provide --csv <file> (repeatable) or --synthetic <days>");
  files.forEach((file, idx) => {
    const symbol = values.symbol?.[idx] ?? basename(file).split(/[-_.]/)[0]!.toUpperCase();
    const v = validateCandles(parseCandlesCsv(readFileSync(file, "utf8")), TIMEFRAME_MS[tf]);
    const issues = v.issues.reduce<Record<string, number>>(
      (a, x) => ((a[x.type] = (a[x.type] ?? 0) + 1), a),
      {},
    );
    console.info(
      `${symbol}: ${v.clean.length} candles${v.issues.length ? `, issues ${JSON.stringify(issues)}` : ""}`,
    );
    const instFile = values.instrument?.[idx];
    const instrument: Instrument = instFile
      ? (JSON.parse(readFileSync(instFile, "utf8")) as Instrument)
      : {
          id: `${exchange}:${symbol}`,
          exchange,
          tradingSymbol: symbol,
          instrumentType: itype,
          lotSize: Number(values.lot),
          tickSize: Number(values.tick),
        };
    series.push({ instrument, candles: v.clean });
  });
}

const crypto = series.some((s) => s.instrument.exchange === "CRYPTO");
if (crypto)
  console.info(
    "CRYPTO: 24x7 session, spot long-only, exchange fees (taker 0.1% + GST; 1% TDS reported separately)",
  );
setReportCurrency(series[0]?.instrument.quoteCurrency ?? "INR");
const cfg = {
  timeframeMs: TIMEFRAME_MS[tf],
  ...(crypto ? { session: CRYPTO_SESSION } : {}),
  initialCapital: Number(values.capital),
  product: crypto && values.product === "INTRADAY" ? ("DELIVERY" as const) : product,
  marginFraction: crypto && values.margin === "0.2" ? 1 : Number(values.margin),
  slippageBps: Number(values.slippage),
  limits: { ...DEFAULT_LIMITS, maxRiskPerTradePct: Number(values.risk) },
};

mkdirSync(values.out!, { recursive: true });
const result = runBacktest(series, cfg);
console.info(summarize(result));
writeFileSync(join(values.out!, "trades.csv"), tradesCsv(result.trades));
writeFileSync(
  join(values.out!, "report.json"),
  JSON.stringify({ config: cfg, metrics: result.metrics, signals: result.signals }, null, 2),
);

if (values["walk-forward"]) {
  const wf = runWalkForward(series, cfg, { folds: Number(values.folds) });
  console.info("\n" + summarizeWalkForward(wf));
  writeFileSync(
    join(values.out!, "walk-forward.json"),
    JSON.stringify(
      {
        verdict: wf.verdict,
        reasons: wf.verdictReasons,
        oos: wf.outOfSample,
        monteCarlo: wf.monteCarlo,
        folds: wf.folds,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(values.out!, "oos-trades.csv"), tradesCsv(wf.oosTrades));
}
console.info(`\nFiles written to ${values.out}/`);

// Optional: publish the report to the Worker (visible in the app under Backtests).
if (values.upload) {
  const url = process.env.ATB_API_URL;
  const token = process.env.ATB_API_TOKEN;
  if (!url || !token) throw new Error("--upload needs ATB_API_URL and ATB_API_TOKEN (owner JWT)");
  const wf = values["walk-forward"]
    ? JSON.parse(readFileSync(join(values.out!, "walk-forward.json"), "utf8"))
    : null;
  const metrics = wf ? { ...wf.oos, verdict: wf.verdict } : result.metrics;
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/backtests/report`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: "rules-ensemble",
      params: { ...cfg, symbols: series.map((s) => s.instrument.id) },
      metrics,
      verdict: wf?.verdict,
      report: { metrics: result.metrics, signals: result.signals, walkForward: wf },
    }),
  });
  console.info(`upload: HTTP ${res.status} ${await res.text()}`);
}
