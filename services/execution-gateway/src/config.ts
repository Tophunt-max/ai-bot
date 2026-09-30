import { BROKER_IDS } from "@atb/shared-types";
import { z } from "zod";

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
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  PAPER_STARTING_CASH: z.coerce.number().positive().default(1_000_000),
});

export type GatewayConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const cfg = schema.parse(env);
  if (cfg.ACTIVE_BROKER !== "paper" && cfg.WHITELISTED_EGRESS_IPS.length === 0) {
    throw new Error("WHITELISTED_EGRESS_IPS is required when ACTIVE_BROKER is a real broker");
  }
  if (cfg.WHITELISTED_EGRESS_IPS.length > 2) {
    throw new Error("brokers allow at most 2 whitelisted IPs (primary + secondary)");
  }
  return cfg;
}
