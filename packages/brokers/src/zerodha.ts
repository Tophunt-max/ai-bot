import type {
  Balance,
  Candle,
  Instrument,
  ModifyRequest,
  Order,
  OrderRequest,
  OrderResult,
  OrderStatus,
  Position,
  ProductType,
  Timeframe,
} from "@atb/shared-types";
import { BrokerError, type BrokerAdapter } from "@atb/trading-core";
import { form, request, sha256Hex, shortTag, type HttpOptions } from "./http";

export interface ZerodhaConfig extends HttpOptions {
  apiKey: string;
  accessToken?: string;
  baseUrl?: string;
}

type KiteEnvelope<T> = { status: "success" | "error"; data?: T; message?: string; error_type?: string };

interface KiteOrder {
  order_id: string;
  tag: string | null;
  status: string;
  exchange: string;
  tradingsymbol: string;
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

const PRODUCT: Record<ProductType, string> = { INTRADAY: "MIS", DELIVERY: "CNC", NORMAL: "NRML" };
const PRODUCT_BACK: Record<string, ProductType> = { MIS: "INTRADAY", CNC: "DELIVERY", NRML: "NORMAL" };

export function mapKiteStatus(s: string, filled: number): OrderStatus {
  switch (s.toUpperCase()) {
    case "COMPLETE":
      return "FILLED";
    case "REJECTED":
      return "REJECTED";
    case "CANCELLED":
      return filled > 0 ? "PARTIALLY_FILLED" : "CANCELLED";
    case "OPEN":
    case "TRIGGER PENDING":
      return filled > 0 ? "PARTIALLY_FILLED" : "ACKNOWLEDGED";
    case "PUT ORDER REQ RECEIVED":
    case "VALIDATION PENDING":
    case "OPEN PENDING":
    case "MODIFY PENDING":
    case "CANCEL PENDING":
      return "SUBMITTED";
    default:
      return "UNKNOWN";
  }
}

/** Zerodha Kite Connect v3 adapter. https://kite.trade/docs/connect/v3/ */
export class ZerodhaAdapter implements BrokerAdapter {
  readonly id = "zerodha" as const;
  private readonly base: string;
  private accessToken?: string;

  constructor(private readonly cfg: ZerodhaConfig) {
    this.base = cfg.baseUrl ?? "https://api.kite.trade";
    this.accessToken = cfg.accessToken;
  }

  /** Exchange request_token (from the daily login redirect) for an access_token. */
  async createSession(requestToken: string, apiSecret: string): Promise<string> {
    const checksum = await sha256Hex(this.cfg.apiKey + requestToken + apiSecret);
    const { body } = await request<KiteEnvelope<{ access_token: string }>>(
      this.cfg,
      `${this.base}/session/token`,
      {
        method: "POST",
        headers: { "X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ api_key: this.cfg.apiKey, request_token: requestToken, checksum }),
      },
    );
    const token = this.unwrap(body).access_token;
    this.accessToken = token;
    return token;
  }

  private headers(contentType?: string): Record<string, string> {
    if (!this.accessToken) throw new BrokerError("no access token — daily login required", "AUTH");
    const h: Record<string, string> = {
      "X-Kite-Version": "3",
      Authorization: `token ${this.cfg.apiKey}:${this.accessToken}`,
    };
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }

  private unwrap<T>(b: KiteEnvelope<T>): T {
    if (b.status === "success" && b.data !== undefined) return b.data;
    const t = b.error_type ?? "";
    if (t === "TokenException") throw new BrokerError(b.message ?? "token expired", "AUTH");
    if (t === "PermissionException" && /ip/i.test(b.message ?? "")) {
      throw new BrokerError(b.message ?? "IP not whitelisted", "IP_NOT_WHITELISTED");
    }
    if (t === "NetworkException") throw new BrokerError(b.message ?? "network", "NETWORK", true);
    throw new BrokerError(b.message ?? `kite error ${t}`, "REJECTED");
  }

  private async get<T>(path: string): Promise<T> {
    const { body } = await request<KiteEnvelope<T>>(this.cfg, `${this.base}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    return this.unwrap(body);
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
    const d = await this.get<{ equity: { net: number; utilised: { debits: number } } }>("/user/margins");
    return {
      availableCash: d.equity.net,
      usedMargin: d.equity.utilised.debits,
      totalEquity: d.equity.net + d.equity.utilised.debits,
    };
  }

  async getPositions(): Promise<Position[]> {
    const d = await this.get<{
      net: Array<{
        exchange: string;
        tradingsymbol: string;
        quantity: number;
        average_price: number;
        last_price: number;
        realised: number;
        unrealised: number;
        product: string;
      }>;
    }>("/portfolio/positions");
    return d.net.map((p) => ({
      instrumentId: `${p.exchange}:${p.tradingsymbol}`,
      quantity: p.quantity,
      averagePrice: p.average_price,
      lastPrice: p.last_price,
      realisedPnl: p.realised,
      unrealisedPnl: p.unrealised,
      product: PRODUCT_BACK[p.product] ?? "NORMAL",
    }));
  }

  async getOrders(): Promise<Order[]> {
    const d = await this.get<KiteOrder[]>("/orders");
    return d.map((o) => this.toOrder(o));
  }

  private toOrder(o: KiteOrder): Order {
    return {
      clientOrderId: o.tag ?? "",
      brokerOrderId: o.order_id,
      instrumentId: `${o.exchange}:${o.tradingsymbol}`,
      side: o.transaction_type,
      quantity: o.quantity,
      orderType: o.order_type === "SL" ? "SL_LIMIT" : "LIMIT",
      product: PRODUCT_BACK[o.product] ?? "NORMAL",
      price: o.price,
      triggerPrice: o.trigger_price || undefined,
      status: mapKiteStatus(o.status, o.filled_quantity),
      filledQuantity: o.filled_quantity,
      averagePrice: o.average_price || undefined,
      message: o.status_message ?? undefined,
      updatedAt: o.order_timestamp ? Date.parse(o.order_timestamp) : Date.now(),
    };
  }

  async findOrder(clientOrderId: string): Promise<Order | undefined> {
    const tag = await shortTag(clientOrderId);
    const o = (await this.get<KiteOrder[]>("/orders")).find((x) => x.tag === tag);
    return o ? { ...this.toOrder(o), clientOrderId } : undefined;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const tag = await shortTag(req.clientOrderId);
    // Idempotency: Kite has no client order id, so we look up our deterministic tag first.
    const existing = (await this.get<KiteOrder[]>("/orders")).find((o) => o.tag === tag);
    if (existing) return { ...this.toOrder(existing), clientOrderId: req.clientOrderId };

    const { body } = await request<KiteEnvelope<{ order_id: string }>>(
      this.cfg,
      `${this.base}/orders/regular`,
      {
        method: "POST",
        mutating: true,
        headers: this.headers("application/x-www-form-urlencoded"),
        body: form({
          tradingsymbol: req.instrument.tradingSymbol,
          exchange: req.instrument.exchange,
          transaction_type: req.side,
          order_type: req.orderType === "SL_LIMIT" ? "SL" : "LIMIT",
          quantity: req.quantity,
          product: PRODUCT[req.product],
          price: req.price,
          trigger_price: req.triggerPrice,
          validity: "DAY",
          tag,
        }),
      },
    );
    const { order_id } = this.unwrap(body);
    return {
      clientOrderId: req.clientOrderId,
      brokerOrderId: order_id,
      status: "SUBMITTED",
      filledQuantity: 0,
    };
  }

  async modifyOrder(brokerOrderId: string, m: ModifyRequest): Promise<OrderResult> {
    const { body } = await request<KiteEnvelope<{ order_id: string }>>(
      this.cfg,
      `${this.base}/orders/regular/${encodeURIComponent(brokerOrderId)}`,
      {
        method: "PUT",
        mutating: true,
        headers: this.headers("application/x-www-form-urlencoded"),
        body: form({ quantity: m.quantity, price: m.price, trigger_price: m.triggerPrice }),
      },
    );
    this.unwrap(body);
    return { clientOrderId: "", brokerOrderId, status: "SUBMITTED", filledQuantity: 0 };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const { body } = await request<KiteEnvelope<{ order_id: string }>>(
      this.cfg,
      `${this.base}/orders/regular/${encodeURIComponent(brokerOrderId)}`,
      { method: "DELETE", mutating: true, headers: this.headers() },
    );
    this.unwrap(body);
  }

  /** LTP for up to ~1000 instruments per call. Keyed by our instrument id. */
  async getLtp(instruments: readonly Instrument[]): Promise<Record<string, number>> {
    if (instruments.length === 0) return {};
    const qs = instruments
      .map((i) => `i=${encodeURIComponent(`${i.exchange}:${i.tradingSymbol}`)}`)
      .join("&");
    const d = await this.get<Record<string, { last_price: number }>>(`/quote/ltp?${qs}`);
    const out: Record<string, number> = {};
    for (const i of instruments) {
      const q = d[`${i.exchange}:${i.tradingSymbol}`];
      if (q && q.last_price > 0) out[i.id] = q.last_price;
    }
    return out;
  }

  /**
   * Historical candles (requires Kite's historical-data add-on). Chunked to Kite's per-request
   * limits. `instrumentToken` is Kite's numeric token (instrument.brokerTokens.zerodha).
   */
  async getHistorical(
    instrumentToken: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<Candle[]> {
    const interval = KITE_INTERVAL[timeframe];
    if (!interval) throw new BrokerError(`timeframe ${timeframe} not supported by Kite`, "REJECTED");
    const maxDays = KITE_MAX_DAYS[interval] ?? 60;
    const out: Candle[] = [];
    const fmt = (d: Date) => {
      const ist = new Date(d.getTime() + 330 * 60_000).toISOString();
      return `${ist.slice(0, 10)}+${ist.slice(11, 19)}`;
    };
    for (let start = from.getTime(); start < to.getTime(); start += maxDays * 86_400_000) {
      const end = Math.min(to.getTime(), start + maxDays * 86_400_000 - 1000);
      const d = await this.get<{ candles: Array<[string, number, number, number, number, number]> }>(
        `/instruments/historical/${encodeURIComponent(instrumentToken)}/${interval}?from=${fmt(new Date(start))}&to=${fmt(new Date(end))}`,
      );
      for (const [ts, o, h, l, c, v] of d.candles) out.push({ t: Date.parse(ts), o, h, l, c, v });
    }
    return out;
  }
}

const KITE_INTERVAL: Partial<Record<Timeframe, string>> = {
  "1m": "minute",
  "5m": "5minute",
  "15m": "15minute",
  "1h": "60minute",
  "1d": "day",
};
// Kite per-request lookback limits (days) by interval.
const KITE_MAX_DAYS: Record<string, number> = {
  minute: 60,
  "5minute": 100,
  "15minute": 200,
  "60minute": 400,
  day: 2000,
};
