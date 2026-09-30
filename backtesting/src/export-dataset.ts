/**
 * Export rule-ensemble CANDIDATES + causal features for AI meta-label training.
 *
 *   pnpm --filter @atb/backtesting export-dataset -- --csv data/INFY-5m.csv --symbol INFY --out ../ai-service/data
 *
 * Writes <out>/candidates.csv and <out>/candles/<EXCHANGE>_<SYMBOL>.csv (Python labels them with
 * the triple-barrier method and trains with purged walk-forward CV).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_ENSEMBLE,
  DEFAULT_EXIT_POLICY,
  FeatureFrame,
  TIMEFRAME_MS,
  candlesToCsv,
  evaluateEnsemble,
  parseCandlesCsv,
  syntheticSession,
  validateCandles,
} from "@atb/engine";
import type { Timeframe } from "@atb/shared-types";
import { sessionPhase } from "@atb/trading-core";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    csv: { type: "string", multiple: true },
    symbol: { type: "string", multiple: true },
    exchange: { type: "string", default: "NSE" },
    tf: { type: "string", default: "5m" },
    out: { type: "string", default: "dataset" },
    synthetic: { type: "string" },
    "min-score": { type: "string", default: "0.2" },
  },
});

const tf = values.tf as Timeframe;
const tfMs = TIMEFRAME_MS[tf];
const sources: Array<{ id: string; candles: ReturnType<typeof parseCandlesCsv> }> = [];
if (values.synthetic) {
  sources.push({
    id: `${values.exchange}:SYNTH`,
    candles: syntheticSession({ days: Number(values.synthetic), timeframeMin: tfMs / 60_000 }),
  });
} else {
  (values.csv ?? []).forEach((file, k) => {
    const sym = values.symbol?.[k] ?? basename(file).split(/[-_.]/)[0]!.toUpperCase();
    sources.push({
      id: `${values.exchange}:${sym}`,
      candles: validateCandles(parseCandlesCsv(readFileSync(file, "utf8")), tfMs).clean,
    });
  });
}
if (sources.length === 0) throw new Error("--csv or --synthetic required");

// A looser score threshold yields more candidates; the meta model learns which ones to keep.
const ensemble = { ...DEFAULT_ENSEMBLE, minScore: Number(values["min-score"]) };
mkdirSync(join(values.out!, "candles"), { recursive: true });
let header: string[] | null = null;
const lines: string[] = [];

for (const src of sources) {
  writeFileSync(join(values.out!, "candles", `${src.id.replace(":", "_")}.csv`), candlesToCsv(src.candles));
  const f = new FeatureFrame(src.candles);
  for (let i = 0; i < f.n - 1; i++) {
    if (sessionPhase(f.t[i]! + tfMs - 1) !== "OPEN") continue;
    const { signal } = evaluateEnsemble(
      f,
      i,
      { instrumentId: src.id, modelVersion: "export", now: f.t[i]! + tfMs },
      ensemble,
    );
    if (signal.decision !== "BUY" && signal.decision !== "SELL") continue;
    const feats = f.vector(i);
    if (!header)
      header = [
        "instrument_id",
        "t",
        "side",
        "entry",
        "stop",
        "target",
        "max_bars",
        "strategies",
        "regime",
        ...Object.keys(feats).map((k) => `f_${k}`),
      ];
    const strategies = (signal.reasons.strategyAgreement ?? "").split(" → ")[0]!.replace(/,\s*/g, "|");
    lines.push(
      [
        src.id,
        f.t[i],
        signal.decision,
        signal.entry,
        signal.stop,
        signal.targets[1],
        DEFAULT_EXIT_POLICY.maxBars,
        strategies,
        signal.regime,
        ...Object.values(feats).map((v) => (Number.isFinite(v) ? v : "")),
      ].join(","),
    );
  }
}
writeFileSync(join(values.out!, "candidates.csv"), [header?.join(",") ?? "", ...lines].join("\n"));
console.info(
  `${lines.length} candidates from ${sources.length} instrument(s) → ${values.out}/candidates.csv`,
);
