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

export const instrumentSchema = z.object({
  id: z.string().min(3).max(64),
  exchange: z.enum(EXCHANGES),
  tradingSymbol: z.string().min(1).max(64),
  instrumentType: z.enum(INSTRUMENT_TYPES),
  lotSize: z.number().int().positive(),
  tickSize: positive,
  freezeQuantity: z.number().int().positive().optional(),
  expiry: z.string().optional(),
  strike: positive.optional(),
  brokerTokens: z.record(z.string(), z.string()).optional(),
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
    quantity: z.number().int().positive(),
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
  .refine((o) => o.quantity % o.instrument.lotSize === 0, {
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
