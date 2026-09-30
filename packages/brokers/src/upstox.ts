import type {
  Balance,
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

export interface UpstoxConfig extends HttpOptions {
  accessToken: string;
  baseUrl?: string;
  /** Upstox serves order placement from a separate low-latency host; configurable. */
  orderBaseUrl?: string;
}

type Envelope<T> = {
  status: "success" | "error";
  data?: T;
  errors?: Array<{ errorCode: string; message: string }>;
};

interface UpstoxOrder {
  order_id: string;
  tag?: string | null;
  status: string;
  exchange: string;
  trading_symbol?: string;
  tradingsymbol?: string;
  instrument_token: string;
  transaction_type: "BUY" | "SELL";
  order_type: string;
  product: string;
  quantity: number;
  filled_quantity: number;
  average_price: number;
  price: number;
  trigger_price: number;
  status_message?: string | null;
  order_timestamp?: string;
}

const PRODUCT: Record<ProductType, string> = { INTRADAY: "I", DELIVERY: "D", NORMAL: "D" };
const PRODUCT_BACK: Record<string, ProductType> = { I: "INTRADAY", D: "DELIVERY" };

export function mapUpstoxStatus(s: string, filled: number): OrderStatus {
  switch (s.toLowerCase()) {
    case "complete":
      return "FILLED";
    case "rejected":
      return "REJECTED";
    case "cancelled":
      return filled > 0 ? "PARTIALLY_FILLED" : "CANCELLED";
    case "open":
    case "trigger pending":
      return filled > 0 ? "PARTIALLY_FILLED" : "ACKNOWLEDGED";
    case "put order req received":
    case "validation pending":
    case "open pending":
    case "modify pending":
    case "cancel pending":
    case "after market order req received":
      return "SUBMITTED";
    default:
      return "UNKNOWN";
  }
}

/** Upstox API v2 adapter. https://upstox.com/developer/api-documentation/ */
export class UpstoxAdapter implements BrokerAdapter {
  readonly id = "upstox" as const;
  private readonly base: string;
  private readonly orderBase: string;

  constructor(private readonly cfg: UpstoxConfig) {
    this.base = cfg.baseUrl ?? "https://api.upstox.com/v2";
    this.orderBase = cfg.orderBaseUrl ?? this.base;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private unwrap<T>(status: number, b: Envelope<T>): T {
    if (status < 300 && b.status === "success" && b.data !== undefined) return b.data;
    const err = b.errors?.[0];
    const msg = err?.message ?? `upstox HTTP ${status}`;
    if (status === 401 || err?.errorCode === "UDAPI100050") throw new BrokerError(msg, "AUTH");
    if (/ip/i.test(msg) && status === 403) throw new BrokerError(msg, "IP_NOT_WHITELISTED");
    throw new BrokerError(msg, "REJECTED");
  }

  private async get<T>(path: string): Promise<T> {
    const r = await request<Envelope<T>>(this.cfg, `${this.base}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    return this.unwrap(r.status, r.body);
  }

  async connect(): Promise<void> {
    await this.get("/user/profile");
  }

  async isSessionValid(): Promise<boolean> {
    try {
      await this.get("/user/profile");
      return true;
    } catch (e) {
      if (e instanceof BrokerError && e.code === "AUTH") return false;
      throw e;
    }
  }

  async getBalance(): Promise<Balance> {
    const d = await this.get<{ equity: { available_margin: number; used_margin: number } }>(
      "/user/get-funds-and-margin?segment=SEC",
    );
    return {
      availableCash: d.equity.available_margin,
      usedMargin: d.equity.used_margin,
      totalEquity: d.equity.available_margin + d.equity.used_margin,
    };
  }

  async getPositions(): Promise<Position[]> {
    const d = await this.get<
      Array<{
        exchange: string;
        trading_symbol?: string;
        tradingsymbol?: string;
        quantity: number;
        average_price: number;
        last_price: number;
        realised: number;
        unrealised: number;
        product: string;
      }>
    >("/portfolio/short-term-positions");
    return d.map((p) => ({
      instrumentId: `${p.exchange}:${p.trading_symbol ?? p.tradingsymbol}`,
      quantity: p.quantity,
      averagePrice: p.average_price,
      lastPrice: p.last_price,
      realisedPnl: p.realised,
      unrealisedPnl: p.unrealised,
      product: PRODUCT_BACK[p.product] ?? "NORMAL",
    }));
  }

  private toOrder(o: UpstoxOrder): Order {
    return {
      clientOrderId: o.tag ?? "",
      brokerOrderId: o.order_id,
      instrumentId: `${o.exchange}:${o.trading_symbol ?? o.tradingsymbol ?? o.instrument_token}`,
      side: o.transaction_type,
      quantity: o.quantity,
      orderType: o.order_type === "SL" ? "SL_LIMIT" : "LIMIT",
      product: PRODUCT_BACK[o.product] ?? "NORMAL",
      price: o.price,
      triggerPrice: o.trigger_price || undefined,
      status: mapUpstoxStatus(o.status, o.filled_quantity),
      filledQuantity: o.filled_quantity,
      averagePrice: o.average_price || undefined,
      message: o.status_message ?? undefined,
      updatedAt: o.order_timestamp ? Date.parse(o.order_timestamp) : Date.now(),
    };
  }

  async getOrders(): Promise<Order[]> {
    return (await this.get<UpstoxOrder[]>("/order/retrieve-all")).map((o) => this.toOrder(o));
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const token = req.instrument.brokerTokens?.upstox;
    if (!token) throw new BrokerError(`no Upstox instrument_token for ${req.instrument.id}`, "REJECTED");
    const tag = await shortTag(req.clientOrderId);
    const existing = (await this.get<UpstoxOrder[]>("/order/retrieve-all")).find((o) => o.tag === tag);
    if (existing) return { ...this.toOrder(existing), clientOrderId: req.clientOrderId };

    const r = await request<Envelope<{ order_id: string }>>(this.cfg, `${this.orderBase}/order/place`, {
      method: "POST",
      mutating: true,
      headers: this.headers(),
      body: JSON.stringify({
        quantity: req.quantity,
        product: PRODUCT[req.product],
        validity: "DAY",
        price: req.price,
        tag,
        instrument_token: token,
        order_type: req.orderType === "SL_LIMIT" ? "SL" : "LIMIT",
        transaction_type: req.side,
        disclosed_quantity: 0,
        trigger_price: req.triggerPrice ?? 0,
        is_amo: false,
      }),
    });
    const d = this.unwrap(r.status, r.body);
    return {
      clientOrderId: req.clientOrderId,
      brokerOrderId: d.order_id,
      status: "SUBMITTED",
      filledQuantity: 0,
    };
  }

  async modifyOrder(brokerOrderId: string, m: ModifyRequest): Promise<OrderResult> {
    const r = await request<Envelope<{ order_id: string }>>(this.cfg, `${this.orderBase}/order/modify`, {
      method: "PUT",
      mutating: true,
      headers: this.headers(),
      body: JSON.stringify({
        order_id: brokerOrderId,
        quantity: m.quantity,
        price: m.price,
        trigger_price: m.triggerPrice ?? 0,
        order_type: m.triggerPrice !== undefined ? "SL" : "LIMIT",
        validity: "DAY",
        disclosed_quantity: 0,
      }),
    });
    this.unwrap(r.status, r.body);
    return { clientOrderId: "", brokerOrderId, status: "SUBMITTED", filledQuantity: 0 };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const r = await request<Envelope<{ order_id: string }>>(
      this.cfg,
      `${this.orderBase}/order/cancel?order_id=${encodeURIComponent(brokerOrderId)}`,
      { method: "DELETE", mutating: true, headers: this.headers() },
    );
    this.unwrap(r.status, r.body);
  }
}
