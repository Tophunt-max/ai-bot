import { readFileSync } from "node:fs";
import { BROKER_IDS, PRODUCT_TYPES, TIMEFRAMES, type Instrument } from "@atb/shared-types";
import { instrumentSchema } from "@atb/validation";
import { z } from "zod";

const bool = z
  .string()
  .default("false")
  .transform((s) => s === "true" || s === "1");

const schema = z.object({
  GATEWAY_NODE_ID: z.string().min(3).max(40),
  GATEWAY_PORT: z.coerce.number().int().default(8080),
  CONTROL_PLANE_URL: z.url(),
  GATEWAY_HMAC_SECRET: z.string().min(32, "GATEWAY_HMAC_SECRET must be >= 32 chars"),
  WHITELISTED_EGRESS_IPS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  EGRESS_IP_CHECK_URL: z.url().default("https://api.ipify.org"),
  MAX_ORDERS_PER_SECOND: z.coerce.number().int().min(1).max(8).default(5),
  ACTIVE_BROKER: z.enum(BROKER_IDS).default("paper"),
  /** Read-only market-data source (quotes/history work from any IP). Defaults to ACTIVE_BROKER. */
  DATA_BROKER: z.enum(["none", "zerodha", "upstox", "dhan"]).default("none"),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  PAPER_STARTING_CASH: z.coerce.number().positive().default(1_000_000),
  INSTRUMENTS_FILE: z.string().optional(),
  TIMEFRAME: z.enum(TIMEFRAMES).default("5m"),
  PRODUCT: z.enum(PRODUCT_TYPES).default("INTRADAY"),
  MARGIN_FRACTION: z.coerce.number().gt(0).max(1).default(0.2),
  STATE_FILE: z.string().default("/app/state/engine.json"),
  CANARY_CAPITAL_PCT: z.coerce.number().gt(0).max(100).default(5),
  AI_ENABLED: bool,
  AI_SERVICE_URL: z.string().default("http://ai-service:8000"),
  AI_SERVICE_SECRET: z.string().default(""),
  AI_MIN_PROBABILITY: z.coerce.number().min(0).max(1).default(0.55),
  QUOTE_POLL_MS: z.coerce.number().int().min(250).default(1000),
  /** Replay a CSV through the live engine (paper simulation without a broker feed). */
  REPLAY_CSV: z.string().optional(),
  REPLAY_DELAY_MS: z.coerce.number().int().min(0).default(0),
});

export type GatewayConfig = z.infer<typeof schema> & { instruments: Instrument[] };

export function loadInstruments(file?: string): Instrument[] {
  if (!file) return [];
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  return raw.map((x) => instrumentSchema.parse(x) as Instrument);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const cfg = schema.parse(env);
  if (cfg.ACTIVE_BROKER !== "paper" && cfg.WHITELISTED_EGRESS_IPS.length === 0) {
    throw new Error("WHITELISTED_EGRESS_IPS is required when ACTIVE_BROKER is a real broker");
  }
  if (cfg.WHITELISTED_EGRESS_IPS.length > 2) {
    throw new Error("brokers allow at most 2 whitelisted IPs (primary + secondary)");
  }
  if (cfg.AI_ENABLED && cfg.AI_SERVICE_SECRET.length < 32) {
    throw new Error("AI_ENABLED requires AI_SERVICE_SECRET (>= 32 chars)");
  }
  return { ...cfg, instruments: loadInstruments(cfg.INSTRUMENTS_FILE) };
}
