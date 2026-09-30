import { z } from "zod";
import {
  ACCOUNT_IDS,
  BROKER_IDS,
  EXCHANGES,
  INSTRUMENT_TYPES,
  KILL_SWITCH_TRIGGERS,
  ORDER_TYPES,
  PRODUCT_TYPES,
  SIDES,
  TRADING_MODES,
} from "@atb/shared-types";

const positive = z.number().finite().positive();

/** True when q is an integer multiple of step (float-tolerant, for fractional crypto steps). */
export const isMultipleOf = (q: number, step: number) => {
  const k = q / step;
  return Math.abs(k - Math.round(k)) < 1e-6;
};

export const instrumentSchema = z
  .object({
    id: z.string().min(3).max(64),
    exchange: z.enum(EXCHANGES),
    tradingSymbol: z.string().min(1).max(64),
    instrumentType: z.enum(INSTRUMENT_TYPES),
    lotSize: positive,
    tickSize: positive,
    freezeQuantity: z.number().positive().optional(),
    expiry: z.string().optional(),
    strike: positive.optional(),
    brokerTokens: z.record(z.string(), z.string()).optional(),
    venue: z.string().min(2).max(40).optional(),
    venueSymbol: z.string().min(3).max(40).optional(),
    quoteCurrency: z.string().min(2).max(10).optional(),
    minQty: positive.optional(),
    minNotional: positive.optional(),
  })
  .refine((i) => i.exchange === "CRYPTO" || Number.isInteger(i.lotSize), {
    message: "lotSize must be an integer for Indian markets",
    path: ["lotSize"],
  })
  .refine((i) => i.exchange !== "CRYPTO" || (!!i.venue && !!i.venueSymbol), {
    message: "crypto instruments need venue (e.g. binance) and venueSymbol (e.g. BTC/USDT)",
    path: ["venue"],
  })
  .refine((i) => (i.exchange === "CRYPTO") === (i.instrumentType === "SPOT" || i.instrumentType === "PERP"), {
    message: "SPOT/PERP only on CRYPTO, and CRYPTO only with SPOT/PERP",
    path: ["instrumentType"],
  });

export const orderRequestSchema = z
  .object({
    clientOrderId: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    instrument: instrumentSchema,
    side: z.enum(SIDES),
    quantity: positive,
    orderType: z.enum(ORDER_TYPES),
    product: z.enum(PRODUCT_TYPES),
    price: positive,
    triggerPrice: positive.optional(),
    tag: z.string().max(20).optional(),
  })
  .refine((o) => o.orderType !== "SL_LIMIT" || o.triggerPrice !== undefined, {
    message: "SL_LIMIT requires triggerPrice",
    path: ["triggerPrice"],
  })
  .refine((o) => o.instrument.exchange === "CRYPTO" || Number.isInteger(o.quantity), {
    message: "quantity must be an integer for Indian markets",
    path: ["quantity"],
  })
  .refine((o) => isMultipleOf(o.quantity, o.instrument.lotSize), {
    message: "quantity must be a multiple of lotSize",
    path: ["quantity"],
  });

export const riskLimitsSchema = z.object({
  maxRiskPerTradePct: z.number().gt(0).max(2),
  maxDailyLossPct: z.number().gt(0).max(5),
  maxWeeklyLossPct: z.number().gt(0).max(10),
  maxDrawdownPct: z.number().gt(0).max(25),
  maxOpenPositions: z.number().int().min(1).max(20),
  maxSymbolExposurePct: z.number().gt(0).max(100),
  maxCorrelatedExposurePct: z.number().gt(0).max(100),
  maxLeverage: z.number().min(1).max(5),
  maxPositionValue: positive,
  maxOrdersPerMinute: z.number().int().min(1).max(120),
  maxOrdersPerSecond: z.number().int().min(1).max(8),
});

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(12).max(256),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export const accountIdSchema = z.enum(ACCOUNT_IDS);

export const modeChangeSchema = z.object({
  mode: z.enum(TRADING_MODES),
  confirmation: z.string().optional(),
  reason: z.string().min(3).max(500),
});

export const killSwitchSchema = z.object({
  active: z.boolean(),
  trigger: z.enum(KILL_SWITCH_TRIGGERS).default("MANUAL"),
  reason: z.string().min(3).max(500),
});

export const brokerSelectSchema = z.object({
  broker: z.enum(BROKER_IDS),
});

export type OrderRequestInput = z.infer<typeof orderRequestSchema>;
export type RiskLimitsInput = z.infer<typeof riskLimitsSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ModeChangeInput = z.infer<typeof modeChangeSchema>;
export type KillSwitchInput = z.infer<typeof killSwitchSchema>;

export { z };
