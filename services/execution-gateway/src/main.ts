import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createBroker, isQuoteCapable, ZerodhaAdapter } from "@atb/brokers";
import {
  PollingProvider,
  ReplayProvider,
  TIMEFRAME_MS,
  parseCandlesCsv,
  type MarketDataProvider,
} from "@atb/engine";
import type { AccountId } from "@atb/shared-types";
import { PaperBroker, type BrokerAdapter } from "@atb/trading-core";
import { AiClient } from "./ai-client";
import { loadConfig } from "./config";
import { HttpControlPlane } from "./control-plane";
import { checkEgressIp, type EgressStatus } from "./egress";
import { TradingEngine, type PersistedState } from "./engine";
import { OrderExecutor } from "./executor";
import { EventReporter } from "./reporter";
import { createGatewayApp, type Book } from "./server";
import { StateStore } from "./state-store";
import { BrokerVenue, SimVenue } from "./venue";

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.info(
    JSON.stringify({ level, msg, service: "execution-gateway", time: new Date().toISOString(), ...extra }),
  );

const cfg = loadConfig();
const byId = new Map(cfg.instruments.map((i) => [i.id, i]));

// In replay mode the engines run on the historical clock (bar close times).
let replayClock = 0;
let replayWallAt = Date.now();
const engineNow = cfg.REPLAY_CSV ? () => replayClock : Date.now;
const limiterNow = cfg.REPLAY_CSV ? () => replayClock + (Date.now() - replayWallAt) : undefined;

// The REAL broker is only created when one is configured. DEMO never gets a reference to it.
const realBroker: BrokerAdapter | null =
  cfg.ACTIVE_BROKER === "paper" ? null : createBroker(cfg.ACTIVE_BROKER, process.env);

// ---- market data (read-only; allowed from any IP) — ONE feed shared by both books
function buildProvider(): MarketDataProvider {
  if (cfg.REPLAY_CSV) {
    const first = cfg.instruments[0];
    if (!first) throw new Error("REPLAY_CSV needs INSTRUMENTS_FILE with at least one instrument");
    log("warn", "replay_mode", { file: cfg.REPLAY_CSV, instrument: first.id });
    return new ReplayProvider({ [first.id]: parseCandlesCsv(readFileSync(cfg.REPLAY_CSV, "utf8")) });
  }
  const dataBroker = cfg.DATA_BROKER !== "none" ? createBroker(cfg.DATA_BROKER, process.env) : realBroker;
  if (!dataBroker || !isQuoteCapable(dataBroker)) {
    log("error", "no_market_data_source", {
      hint: "set DATA_BROKER=zerodha|upstox|dhan (read-only, needed for DEMO live data) or REPLAY_CSV",
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
    if (!egressCache.ok && realBroker)
      log("error", "egress_ip_not_whitelisted", { ip: egressCache.ip, error: egressCache.error });
  }
  return egressCache;
};

interface RunningBook extends Book {
  account: AccountId;
  engine: TradingEngine;
  reporter: EventReporter;
  heartbeat: () => Promise<void>;
}

/**
 * DEMO book: virtual money on REAL live quotes (paper broker; its "live" target is ALSO the paper
 *   broker, so a DEMO order can never reach a real broker even if a mode were misconfigured).
 * REAL book: real broker for CANARY/LIVE, simulated fills for SHADOW.
 */
function buildBook(account: AccountId): RunningBook {
  const ref: { engine?: TradingEngine } = {};
  const paper = new PaperBroker({
    startingCash: account === "demo" ? cfg.DEMO_STARTING_CASH : 1,
    slippageBps: 3,
    priceFeed: (id) => ref.engine?.quotes.get(id)?.ltp,
  });
  const live = account === "real" ? realBroker! : paper;
  const controlPlane = new HttpControlPlane(cfg.CONTROL_PLANE_URL, cfg.GATEWAY_HMAC_SECRET, account);
  const executor = new OrderExecutor({
    nodeId: cfg.GATEWAY_NODE_ID,
    paperBroker: paper,
    liveBroker: live,
    controlPlane,
    checkEgress,
    maxOrdersPerSecond: cfg.MAX_ORDERS_PER_SECOND,
    limiterNow,
  });
  const reporter = new EventReporter(`${cfg.GATEWAY_NODE_ID}-${account}`, controlPlane);
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
      store: new StateStore<PersistedState>(join(cfg.STATE_DIR, `engine-${account}.json`)),
      ai: cfg.AI_ENABLED ? new AiClient(cfg.AI_SERVICE_URL, cfg.AI_SERVICE_SECRET) : undefined,
      paperBroker: paper,
      log: (level, msg, extra) => log(level, msg, { account, ...extra }),
      now: engineNow,
    },
  );
  ref.engine = engine;
  const heartbeat = async () => {
    const hb = await executor.heartbeat();
    engine.applyControl(hb);
    if (!hb) log("warn", "control_plane_unreachable", { account });
    else if (!hb.leaseGranted) log("info", "standby", { account, leaseHolder: hb.leaseHolder });
  };
  return { account, executor, engine, reporter, heartbeat };
}

const books: RunningBook[] = [buildBook("demo")];
if (realBroker) books.push(buildBook("real"));
else
  log("warn", "real_book_disabled", { hint: "set ACTIVE_BROKER=zerodha|upstox|dhan to enable REAL trading" });

const every = (ms: number, fn: () => Promise<unknown> | unknown, name: string) =>
  setInterval(() => {
    Promise.resolve()
      .then(fn)
      .catch((e) => log("error", `${name}_failed`, { err: String(e) }));
  }, ms);

for (const b of books) {
  await b.heartbeat();
  await b.engine.init();
  await b.engine.reconcile(); // first broker snapshot unlocks risk (fail-closed until then)
  await b.heartbeat(); // pick up the unlocked state before trading
}

const timers = books.flatMap((b) => [
  every(cfg.HEARTBEAT_INTERVAL_MS, b.heartbeat, `heartbeat_${b.account}`),
  every(1000, () => b.engine.flush(), `bar_flush_${b.account}`),
  every(2000, () => b.reporter.flush(), `report_flush_${b.account}`),
  every(10_000, () => b.engine.healthCheck(), `health_${b.account}`),
  every(10_000, () => b.executor.reconcileUnknown(), `unknown_reconcile_${b.account}`),
  every(30_000, () => b.engine.reconcile(), `reconcile_${b.account}`),
]);

const abort = new AbortController();
if (cfg.REPLAY_CSV) {
  // Replay: feed candles straight into every book (paper simulation on history).
  void (async () => {
    const id = cfg.instruments[0]!.id;
    const candles = await provider.getOHLCV(id, cfg.TIMEFRAME);
    let replayed = 0;
    for (const c of candles) {
      replayClock = c.t + TIMEFRAME_MS[cfg.TIMEFRAME];
      replayWallAt = Date.now();
      for (const b of books) await b.engine.onCandle(id, c);
      if (cfg.REPLAY_DELAY_MS) await new Promise((r) => setTimeout(r, cfg.REPLAY_DELAY_MS));
      else if (++replayed % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    for (const b of books) log("info", "replay_done", { account: b.account, ...b.engine.status() });
  })();
} else if (cfg.instruments.length) {
  // One market-data subscription fans out to both books (same prices for DEMO and REAL).
  void (async () => {
    for await (const tick of provider.subscribe(
      cfg.instruments.map((i) => i.id),
      abort.signal,
    )) {
      for (const b of books) b.engine.onTick(tick);
    }
  })().catch((e) => log("error", "market_data_stream_failed", { err: String(e) }));
} else {
  log("warn", "no_instruments_configured", { hint: "set INSTRUMENTS_FILE" });
}

const server = serve({
  fetch: createGatewayApp(Object.fromEntries(books.map((b) => [b.account, b])), cfg.GATEWAY_HMAC_SECRET)
    .fetch,
  port: cfg.GATEWAY_PORT,
});
log("info", "gateway_started", {
  nodeId: cfg.GATEWAY_NODE_ID,
  books: books.map((b) => b.account),
  realBroker: cfg.ACTIVE_BROKER,
  data: cfg.DATA_BROKER,
  instruments: cfg.instruments.length,
  port: cfg.GATEWAY_PORT,
});

const shutdown = async () => {
  log("info", "shutdown");
  abort.abort();
  timers.forEach(clearInterval);
  await Promise.all(books.map((b) => b.reporter.flush().catch(() => undefined)));
  server.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
