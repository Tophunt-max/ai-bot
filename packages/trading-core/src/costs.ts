import type { InstrumentType, ProductType, Side } from "@atb/shared-types";

/**
 * Indian statutory + brokerage cost model. Rates are CONFIG, not truth:
 * STT/stamp/exchange charges change via budgets & circulars — verify yearly and
 * override through settings. Values below are indicative defaults (fractions, not %).
 */
export interface CostRates {
  brokerageFlat: number; // INR per executed order
  brokeragePct: number; // fraction of turnover; min(flat, pct) is charged
  sttEquityDelivery: number; // both sides
  sttEquityIntradaySell: number;
  sttFuturesSell: number;
  sttOptionsSellPremium: number;
  exchangeEquity: number;
  exchangeFutures: number;
  exchangeOptionsPremium: number;
  sebiPerTurnover: number;
  stampEquityDeliveryBuy: number;
  stampEquityIntradayBuy: number;
  stampFuturesBuy: number;
  stampOptionsBuy: number;
  gst: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  brokerageFlat: 20,
  brokeragePct: 0.0003,
  sttEquityDelivery: 0.001,
  sttEquityIntradaySell: 0.00025,
  sttFuturesSell: 0.0002,
  sttOptionsSellPremium: 0.001,
  exchangeEquity: 0.0000297,
  exchangeFutures: 0.0000173,
  exchangeOptionsPremium: 0.0003503,
  sebiPerTurnover: 0.000001,
  stampEquityDeliveryBuy: 0.00015,
  stampEquityIntradayBuy: 0.00003,
  stampFuturesBuy: 0.00002,
  stampOptionsBuy: 0.00003,
  gst: 0.18,
};

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

export function estimateCosts(
  args: { side: Side; quantity: number; price: number; instrumentType: InstrumentType; product: ProductType },
  r: CostRates = DEFAULT_COST_RATES,
): CostBreakdown {
  const turnover = args.quantity * args.price;
  const buy = args.side === "BUY";
  const isOpt = args.instrumentType === "CE" || args.instrumentType === "PE";
  const isFut = args.instrumentType === "FUT";
  const delivery = args.product === "DELIVERY";

  const brokerage = delivery && !isFut && !isOpt ? 0 : Math.min(r.brokerageFlat, turnover * r.brokeragePct);

  let stt = 0;
  let exchange = 0;
  let stamp = 0;
  if (isOpt) {
    stt = buy ? 0 : turnover * r.sttOptionsSellPremium;
    exchange = turnover * r.exchangeOptionsPremium;
    stamp = buy ? turnover * r.stampOptionsBuy : 0;
  } else if (isFut) {
    stt = buy ? 0 : turnover * r.sttFuturesSell;
    exchange = turnover * r.exchangeFutures;
    stamp = buy ? turnover * r.stampFuturesBuy : 0;
  } else if (delivery) {
    stt = turnover * r.sttEquityDelivery;
    exchange = turnover * r.exchangeEquity;
    stamp = buy ? turnover * r.stampEquityDeliveryBuy : 0;
  } else {
    stt = buy ? 0 : turnover * r.sttEquityIntradaySell;
    exchange = turnover * r.exchangeEquity;
    stamp = buy ? turnover * r.stampEquityIntradayBuy : 0;
  }
  const sebi = turnover * r.sebiPerTurnover;
  const gst = (brokerage + exchange + sebi) * r.gst;
  const total = brokerage + stt + exchange + sebi + stamp + gst;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    brokerage: round(brokerage),
    stt: round(stt),
    exchange: round(exchange),
    sebi: round(sebi),
    stamp: round(stamp),
    gst: round(gst),
    total: round(total),
  };
}
