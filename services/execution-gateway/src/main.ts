import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createBroker, isQuoteCapable, ZerodhaAdapter } from "@atb/brokers";
import {
  PollingProvider,
  ReplayProvider,
  TIMEFRAME_MS,
  parseCandlesCsv,
  type MarketDataProvider,
} from "@atb/engine";
import { PaperBroker } from "@atb/trading-core";
import { AiClient } from "./ai-client";
import { loadConfig } from "./config";
import { HttpControlPlane } from "./control-plane";
import { checkEgressIp, type EgressStatus } from "./egress";
import { TradingEngine, type PersistedState } from "./engine";
import { OrderExecutor } from "./executor";
import { EventReporter } from "./reporter";
import { createGatewayApp } from "./server";
import { StateStore } from "./state-store";
import { BrokerVenue, SimVenue } from "./venue";

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.info(
    JSON.stringify({ level, msg, service: "execution-gateway", time: new Date().toISOString(), ...extra }),
  );

const cfg = loadConfig();
const byId = new Map(cfg.instruments.map((i) => [i.id, i]));
// Paper broker prices come from the engine's live quote cache (set once the engine exists).
const ref: { engine?: TradingEngine } = {};
// In replay mode the engine runs on the historical clock (bar close times).
let replayClock = 0;
let replayWallAt = Date.now();
const engineNow = cfg.REPLAY_CSV ? () => replayClock : Date.now;

const paperBroker = new PaperBroker({
  startingCash: cfg.PAPER_STARTING_CASH,
  slippageBps: 3,
  priceFeed: (id) => ref.engine?.quotes.get(id)?.ltp,
});
const liveBroker = cfg.ACTIVE_BROKER === "paper" ? paperBroker : createBroker(cfg.ACTIVE_BROKER, process.env);

// ---- market data (read-only; allowed from any IP)
function buildProvider(): MarketDataProvider {
  if (cfg.REPLAY_CSV) {
    const first = cfg.instruments[0];
    if (!first) throw new Error("REPLAY_CSV needs INSTRUMENTS_FILE with at least one instrument");
    log("warn", "replay_mode", { file: cfg.REPLAY_CSV, instrument: first.id });
    return new ReplayProvider({ [first.id]: parseCandlesCsv(readFileSync(cfg.REPLAY_CSV, "utf8")) });
  }
  const dataBroker =
    cfg.DATA_BROKER !== "none"
      ? createBroker(cfg.DATA_BROKER, process.env)
      : cfg.ACTIVE_BROKER !== "paper"
        ? liveBroker
        : null;
  if (!dataBroker || !isQuoteCapable(dataBroker)) {
    log("error", "no_market_data_source", {
      hint: "set DATA_BROKER=zerodha|upstox|dhan (read-only) or REPLAY_CSV",
    });
    return new ReplayProvider({});
  }
  const history =
    dataBroker instanceof ZerodhaAdapter
      ? async (
          id: string,
          tf: Parameters<ZerodhaAdapter["getHistorical"]>[1],
          from?: number,
          to?: number,
        ) => {
          const token = byId.get(id)?.brokerTokens?.zerodha;
          if (!token) return [];
          return dataBroker.getHistorical(
            token,
            tf,
            new Date(from ?? Date.now() - 10 * 86_400_000),
            new Date(to ?? Date.now()),
          );
        }
      : undefined;
  return new PollingProvider(
    { getLtp: async (ids) => dataBroker.getLtp(ids.map((id) => byId.get(id)!).filter(Boolean)) },
    cfg.QUOTE_POLL_MS,
    history,
  );
}
const provider = buildProvider();

let egressCache: EgressStatus | null = null;
const checkEgress = async () => {
  if (!egressCache || Date.now() - egressCache.checkedAt > 60_000) {
    egressCache = await checkEgressIp(cfg.WHITELISTED_EGRESS_IPS, cfg.EGRESS_IP_CHECK_URL);
    if (!egressCache.ok)
      log("error", "egress_ip_not_whitelisted", { ip: egressCache.ip, error: egressCache.error });
  }
  return egressCache;
};

const controlPlane = new HttpControlPlane(cfg.CONTROL_PLANE_URL, cfg.GATEWAY_HMAC_SECRET);
const executor = new OrderExecutor({
  nodeId: cfg.GATEWAY_NODE_ID,
  paperBroker,
  liveBroker,
  controlPlane,
  checkEgress,
  maxOrdersPerSecond: cfg.MAX_ORDERS_PER_SECOND,
  // Replay compresses hours into seconds; rate-limit on simulated time so the simulation is realistic.
  limiterNow: cfg.REPLAY_CSV ? () => replayClock + (Date.now() - replayWallAt) : undefined,
});
const reporter = new EventReporter(cfg.GATEWAY_NODE_ID, controlPlane);
const engine = new TradingEngine(
  {
    instruments: cfg.instruments,
    timeframe: cfg.TIMEFRAME,
    product: cfg.PRODUCT,
    marginFraction: cfg.MARGIN_FRACTION,
    canaryCapitalPct: cfg.CANARY_CAPITAL_PCT,
    aiEnabled: cfg.AI_ENABLED,
    aiMinProbability: cfg.AI_MIN_PROBABILITY,
  },
  {
    executor,
    venues: {
      sim: new SimVenue(3),
      paper: new BrokerVenue(executor, "paper"),
      live: new BrokerVenue(executor, "live"),
    },
    provider,
    reporter,
    controlPlane,
    store: new StateStore<PersistedState>(cfg.STATE_FILE),
    ai: cfg.AI_ENABLED ? new AiClient(cfg.AI_SERVICE_URL, cfg.AI_SERVICE_SECRET) : undefined,
    paperBroker,
    log,
    now: engineNow,
  },
);
ref.engine = engine;

const every = (ms: number, fn: () => Promise<unknown> | unknown, name: string) =>
  setInterval(() => {
    Promise.resolve()
      .then(fn)
      .catch((e) => log("error", `${name}_failed`, { err: String(e) }));
  }, ms);

const heartbeat = async () => {
  const hb = await executor.heartbeat();
  engine.applyControl(hb);
  if (!hb) log("warn", "control_plane_unreachable");
  else if (!hb.leaseGranted) log("info", "standby", { leaseHolder: hb.leaseHolder });
};

await heartbeat();
await engine.init();
await engine.reconcile(); // first broker snapshot unlocks risk (fail-closed until then)
await heartbeat(); // pick up the unlocked state before trading

const timers = [
  every(cfg.HEARTBEAT_INTERVAL_MS, heartbeat, "heartbeat"),
  every(1000, () => engine.flush(), "bar_flush"),
  every(2000, () => reporter.flush(), "report_flush"),
  every(10_000, () => engine.healthCheck(), "health"),
  every(10_000, () => executor.reconcileUnknown(), "unknown_reconcile"),
  every(30_000, () => engine.reconcile(), "reconcile"),
];

const abort = new AbortController();
if (cfg.REPLAY_CSV) {
  // Replay: feed candles straight into the engine (paper simulation on history).
  void (async () => {
    const id = cfg.instruments[0]!.id;
    const candles = await provider.getOHLCV(id, cfg.TIMEFRAME);
    let replayed = 0;
    for (const c of candles) {
      replayClock = c.t + TIMEFRAME_MS[cfg.TIMEFRAME];
      replayWallAt = Date.now();
      await engine.onCandle(id, c);
      // Yield regularly so heartbeat/reporting timers keep running during a fast replay.
      if (cfg.REPLAY_DELAY_MS) await new Promise((r) => setTimeout(r, cfg.REPLAY_DELAY_MS));
      else if (++replayed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    log("info", "replay_done", engine.status());
  })();
} else if (cfg.instruments.length) {
  void engine.run(abort.signal).catch((e) => log("error", "market_data_stream_failed", { err: String(e) }));
} else {
  log("warn", "no_instruments_configured", { hint: "set INSTRUMENTS_FILE" });
}

const server = serve({
  fetch: createGatewayApp(executor, cfg.GATEWAY_HMAC_SECRET, engine).fetch,
  port: cfg.GATEWAY_PORT,
});
log("info", "gateway_started", {
  nodeId: cfg.GATEWAY_NODE_ID,
  broker: cfg.ACTIVE_BROKER,
  data: cfg.DATA_BROKER,
  instruments: cfg.instruments.length,
  port: cfg.GATEWAY_PORT,
});

const shutdown = async () => {
  log("info", "shutdown");
  abort.abort();
  timers.forEach(clearInterval);
  await reporter.flush().catch(() => undefined);
  server.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
