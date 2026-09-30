import type {
  Balance,
  Exchange,
  Instrument,
  ModifyRequest,
  Order,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Position,
  ProductType,
} from "@atb/shared-types";
import { BrokerError, type BrokerAdapter } from "@atb/trading-core";
import { request, shortTag, type HttpOptions } from "./http";

export interface DhanConfig extends HttpOptions {
  clientId: string;
  accessToken: string;
  baseUrl?: string;
}

const SEGMENT: Record<Exchange, string> = {
  NSE: "NSE_EQ",
  BSE: "BSE_EQ",
  NFO: "NSE_FNO",
  BFO: "BSE_FNO",
  MCX: "MCX_COMM",
  CDS: "NSE_CURRENCY",
  CRYPTO: "UNSUPPORTED",
};
const SEGMENT_BACK: Record<string, Exchange> = Object.fromEntries(
  Object.entries(SEGMENT).map(([k, v]) => [v, k as Exchange]),
);
const PRODUCT: Record<ProductType, string> = { INTRADAY: "INTRADAY", DELIVERY: "CNC", NORMAL: "MARGIN" };
const PRODUCT_BACK: Record<string, ProductType> = { INTRADAY: "INTRADAY", CNC: "DELIVERY", MARGIN: "NORMAL" };

interface DhanOrder {
  orderId: string;
  correlationId?: string;
  orderStatus: string;
  transactionType: "BUY" | "SELL";
  exchangeSegment: string;
  productType: string;
  orderType: string;
  tradingSymbol?: string;
  securityId: string;
  quantity: number;
  filledQty?: number;
  price: number;
  triggerPrice?: number;
  averageTradedPrice?: number;
  omsErrorDescription?: string;
  updateTime?: string;
}

export function mapDhanStatus(s: string, filled: number): OrderStatus {
  switch (s.toUpperCase()) {
    case "TRADED":
      return "FILLED";
    case "PART_TRADED":
      return "PARTIALLY_FILLED";
    case "PENDING":
      return filled > 0 ? "PARTIALLY_FILLED" : "ACKNOWLEDGED";
    case "TRANSIT":
      return "SUBMITTED";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return filled > 0 ? "PARTIALLY_FILLED" : "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "UNKNOWN";
  }
}

/** DhanHQ v2 adapter. https://dhanhq.co/docs/v2/ — correlationId gives native idempotency. */
export class DhanAdapter implements BrokerAdapter {
  readonly id = "dhan" as const;
  private readonly base: string;

  constructor(private readonly cfg: DhanConfig) {
    this.base = cfg.baseUrl ?? "https://api.dhan.co/v2";
  }

  private headers(): Record<string, string> {
    return {
      "access-token": this.cfg.accessToken,
      "client-id": this.cfg.clientId,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private check<T>(status: number, body: T): T {
    if (status >= 200 && status < 300) return body;
    const b = body as { errorCode?: string; errorMessage?: string; errorType?: string };
    const msg = b.errorMessage ?? `dhan HTTP ${status}`;
    if (status === 401 || b.errorType === "Invalid_Authentication") throw new BrokerError(msg, "AUTH");
    if (/ip/i.test(msg) && status === 403) throw new BrokerError(msg, "IP_NOT_WHITELISTED");
    throw new BrokerError(msg, "REJECTED");
  }

  private async get<T>(path: string): Promise<T> {
    const r = await request<T>(this.cfg, `${this.base}${path}`, { method: "GET", headers: this.headers() });
    return this.check(r.status, r.body);
  }

  async connect(): Promise<void> {
    await this.get("/profile");
  }

  async isSessionValid(): Promise<boolean> {
    try {
      await this.get("/profile");
      return true;
    } catch (e) {
      if (e instanceof BrokerError && e.code === "AUTH") return false;
      throw e;
    }
  }

  async getBalance(): Promise<Balance> {
    // Dhan's field is historically spelled "availabelBalance"; accept both.
    const d = await this.get<{
      availabelBalance?: number;
      availableBalance?: number;
      utilizedAmount: number;
    }>("/fundlimit");
    const available = d.availableBalance ?? d.availabelBalance ?? 0;
    return {
      availableCash: available,
      usedMargin: d.utilizedAmount,
      totalEquity: available + d.utilizedAmount,
    };
  }

  async getPositions(): Promise<Position[]> {
    const d = await this.get<
      Array<{
        tradingSymbol: string;
        securityId: string;
        exchangeSegment: string;
        productType: string;
        netQty: number;
        costPrice: number;
        realizedProfit: number;
        unrealizedProfit: number;
      }>
    >("/positions");
    return d.map((p) => ({
      instrumentId: `${SEGMENT_BACK[p.exchangeSegment] ?? p.exchangeSegment}:${p.tradingSymbol}`,
      quantity: p.netQty,
      averagePrice: p.costPrice,
      realisedPnl: p.realizedProfit,
      unrealisedPnl: p.unrealizedProfit,
      product: PRODUCT_BACK[p.productType] ?? "NORMAL",
    }));
  }

  private toOrder(o: DhanOrder, clientOrderId?: string): Order {
    const filled = o.filledQty ?? 0;
    return {
      clientOrderId: clientOrderId ?? o.correlationId ?? "",
      brokerOrderId: o.orderId,
      instrumentId: `${SEGMENT_BACK[o.exchangeSegment] ?? o.exchangeSegment}:${o.tradingSymbol ?? o.securityId}`,
      side: o.transactionType,
      quantity: o.quantity,
      orderType: o.orderType === "STOP_LOSS" ? "SL_LIMIT" : "LIMIT",
      product: PRODUCT_BACK[o.productType] ?? "NORMAL",
      price: o.price,
      triggerPrice: o.triggerPrice || undefined,
      status: mapDhanStatus(o.orderStatus, filled),
      filledQuantity: filled,
      averagePrice: o.averageTradedPrice || undefined,
      message: o.omsErrorDescription,
      updatedAt: o.updateTime ? Date.parse(o.updateTime) : Date.now(),
    };
  }

  async getOrders(): Promise<Order[]> {
    return (await this.get<DhanOrder[]>("/orders")).map((o) => this.toOrder(o));
  }

  async findOrder(clientOrderId: string): Promise<Order | undefined> {
    const correlationId = await shortTag(clientOrderId);
    const r = await request<DhanOrder | DhanOrder[]>(
      this.cfg,
      `${this.base}/orders/external/${correlationId}`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );
    if (r.status !== 200) return undefined;
    const found = Array.isArray(r.body) ? r.body[0] : r.body;
    return found?.orderId ? this.toOrder(found, clientOrderId) : undefined;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const securityId = req.instrument.brokerTokens?.dhan;
    if (!securityId) throw new BrokerError(`no Dhan securityId for ${req.instrument.id}`, "REJECTED");
    const correlationId = await shortTag(req.clientOrderId);

    // Idempotency: look up by correlationId before placing.
    const lookup = await request<DhanOrder | DhanOrder[]>(
      this.cfg,
      `${this.base}/orders/external/${correlationId}`,
      { method: "GET", headers: this.headers() },
    );
    if (lookup.status === 200) {
      const found = Array.isArray(lookup.body) ? lookup.body[0] : lookup.body;
      if (found?.orderId) return this.toOrder(found, req.clientOrderId);
    }

    const r = await request<{ orderId: string; orderStatus: string }>(this.cfg, `${this.base}/orders`, {
      method: "POST",
      mutating: true,
      headers: this.headers(),
      body: JSON.stringify({
        dhanClientId: this.cfg.clientId,
        correlationId,
        transactionType: req.side,
        exchangeSegment: SEGMENT[req.instrument.exchange],
        productType: PRODUCT[req.product],
        orderType: req.orderType === "SL_LIMIT" ? "STOP_LOSS" : "LIMIT",
        validity: "DAY",
        securityId,
        quantity: req.quantity,
        price: req.price,
        triggerPrice: req.triggerPrice,
      }),
    });
    const body = this.check(r.status, r.body);
    return {
      clientOrderId: req.clientOrderId,
      brokerOrderId: body.orderId,
      status: mapDhanStatus(body.orderStatus ?? "TRANSIT", 0),
      filledQuantity: 0,
    };
  }

  async modifyOrder(brokerOrderId: string, m: ModifyRequest): Promise<OrderResult> {
    const r = await request<{ orderId: string; orderStatus: string }>(
      this.cfg,
      `${this.base}/orders/${encodeURIComponent(brokerOrderId)}`,
      {
        method: "PUT",
        mutating: true,
        headers: this.headers(),
        body: JSON.stringify({
          dhanClientId: this.cfg.clientId,
          orderId: brokerOrderId,
          orderType: m.triggerPrice !== undefined ? "STOP_LOSS" : "LIMIT",
          quantity: m.quantity,
          price: m.price,
          triggerPrice: m.triggerPrice,
          validity: "DAY",
        }),
      },
    );
    this.check(r.status, r.body);
    return { clientOrderId: "", brokerOrderId, status: "SUBMITTED", filledQuantity: 0 };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const r = await request<unknown>(this.cfg, `${this.base}/orders/${encodeURIComponent(brokerOrderId)}`, {
      method: "DELETE",
      mutating: true,
      headers: this.headers(),
    });
    this.check(r.status, r.body);
  }

  async getLtp(instruments: readonly Instrument[]): Promise<Record<string, number>> {
    const keyed = instruments.filter((i) => i.brokerTokens?.dhan);
    if (keyed.length === 0) return {};
    const req: Record<string, number[]> = {};
    for (const i of keyed) (req[SEGMENT[i.exchange]] ??= []).push(Number(i.brokerTokens!.dhan));
    const r = await request<{ data?: Record<string, Record<string, { last_price: number }>> }>(
      this.cfg,
      `${this.base}/marketfeed/ltp`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(req) },
    );
    const d = this.check(r.status, r.body).data ?? {};
    const out: Record<string, number> = {};
    for (const i of keyed) {
      const px = d[SEGMENT[i.exchange]]?.[i.brokerTokens!.dhan!]?.last_price;
      if (px && px > 0) out[i.id] = px;
    }
    return out;
  }
}
