import { serve } from "@hono/node-server";
import { createBroker } from "@atb/brokers";
import { PaperBroker } from "@atb/trading-core";
import { loadConfig } from "./config";
import { HttpControlPlane } from "./control-plane";
import { checkEgressIp, type EgressStatus } from "./egress";
import { OrderExecutor } from "./executor";
import { createGatewayApp } from "./server";

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.info(
    JSON.stringify({ level, msg, service: "execution-gateway", time: new Date().toISOString(), ...extra }),
  );

const cfg = loadConfig();

const paperBroker = new PaperBroker({
  startingCash: cfg.PAPER_STARTING_CASH,
  slippageBps: 5,
  priceFeed: () => undefined, // wired to the market-data ingestor in Phase 4
});
const liveBroker = cfg.ACTIVE_BROKER === "paper" ? paperBroker : createBroker(cfg.ACTIVE_BROKER, process.env);

// Egress IP is checked at most once a minute (and on every start).
let egressCache: EgressStatus | null = null;
const checkEgress = async () => {
  if (!egressCache || Date.now() - egressCache.checkedAt > 60_000) {
    egressCache = await checkEgressIp(cfg.WHITELISTED_EGRESS_IPS, cfg.EGRESS_IP_CHECK_URL);
    if (!egressCache.ok)
      log("error", "egress_ip_not_whitelisted", { ip: egressCache.ip, error: egressCache.error });
  }
  return egressCache;
};

const executor = new OrderExecutor({
  nodeId: cfg.GATEWAY_NODE_ID,
  paperBroker,
  liveBroker,
  controlPlane: new HttpControlPlane(cfg.CONTROL_PLANE_URL, cfg.GATEWAY_HMAC_SECRET),
  checkEgress,
  maxOrdersPerSecond: cfg.MAX_ORDERS_PER_SECOND,
});

const tick = async () => {
  const hb = await executor.heartbeat();
  if (!hb) log("warn", "control_plane_unreachable");
  else if (!hb.leaseGranted) log("info", "standby", { leaseHolder: hb.leaseHolder });
};
await tick();
const timer = setInterval(() => void tick(), cfg.HEARTBEAT_INTERVAL_MS);

const server = serve({
  fetch: createGatewayApp(executor, cfg.GATEWAY_HMAC_SECRET).fetch,
  port: cfg.GATEWAY_PORT,
});
log("info", "gateway_started", {
  nodeId: cfg.GATEWAY_NODE_ID,
  broker: cfg.ACTIVE_BROKER,
  port: cfg.GATEWAY_PORT,
});

const shutdown = () => {
  log("info", "shutdown");
  clearInterval(timer);
  server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
