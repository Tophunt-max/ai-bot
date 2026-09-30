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
  Timeframe,
} from "@atb/shared-types";
import { BrokerError, type BrokerAdapter } from "@atb/trading-core";
import * as ccxt from "ccxt";
import { shortTag } from "./http";

/** The subset of a CCXT exchange we use (lets tests inject a fake). */
export interface ExchangeLike {
  id: string;
  has: Record<string, boolean | string | undefined>;
  precisionMode?: number;
  markets?: Record<string, CcxtMarket>;
  loadMarkets(): Promise<Record<string, CcxtMarket>>;
  fetchBalance(params?: object): Promise<Record<string, unknown>>;
  fetchTickers?(
    symbols?: string[],
  ): Promise<
    Record<string, { last?: number; close?: number; bid?: number; ask?: number; timestamp?: number }>
  >;
  fetchTicker(
    symbol: string,
  ): Promise<{ last?: number; close?: number; bid?: number; ask?: number; timestamp?: number }>;
  fetchOHLCV(symbol: string, timeframe?: string, since?: number, limit?: number): Promise<number[][]>;
  fetchOpenOrders(symbol?: string, since?: number, limit?: number): Promise<CcxtOrder[]>;
  fetchClosedOrders?(symbol?: string, since?: number, limit?: number): Promise<CcxtOrder[]>;
  fetchOrders?(symbol?: string, since?: number, limit?: number): Promise<CcxtOrder[]>;
  fetchPositions?(
    symbols?: string[],
  ): Promise<
    Array<{
      symbol: string;
      contracts?: number;
      side?: string;
      entryPrice?: number;
      markPrice?: number;
      unrealizedPnl?: number;
      realizedPnl?: number;
    }>
  >;
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: object,
  ): Promise<CcxtOrder>;
  editOrder?(
    id: string,
    symbol: string,
    type: string,
    side: string,
    amount?: number,
    price?: number,
    params?: object,
  ): Promise<CcxtOrder>;
  cancelOrder(id: string, symbol?: string): Promise<unknown>;
  setSandboxMode?(on: boolean): void;
}

export interface CcxtMarket {
  symbol: string;
  base: string;
  quote: string;
  type?: string; // spot | swap | future
  spot?: boolean;
  swap?: boolean;
  contractSize?: number;
  precision: { amount?: number; price?: number };
  limits?: { amount?: { min?: number }; cost?: { min?: number } };
}

export interface CcxtOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  status?: string; // open | closed | canceled | expired | rejected
  side: "buy" | "sell";
  type?: string;
  amount: number;
  filled?: number;
  price?: number;
  average?: number;
  triggerPrice?: number;
  stopPrice?: number;
  timestamp?: number;
  lastUpdateTimestamp?: number;
}

export interface CcxtConfig {
  /** CCXT exchange id, e.g. "binance", "kucoin", "delta", "zebpay". */
  exchangeId: string;
  apiKey?: string;
  secret?: string;
  password?: string; // some exchanges (OKX, KuCoin, Bitget) call it passphrase
  uid?: string;
  sandbox?: boolean; // exchange testnet (Binance/Bybit/OKX… support it)
  /** Balance currency used as account equity (USDT, USD, INR…). */
  quoteCurrency: string;
  /** Instruments this adapter manages (needed for symbol lookups, spot positions). */
  instruments: readonly Instrument[];
  exchange?: ExchangeLike; // injected in tests
  timeoutMs?: number;
}

export function mapCcxtStatus(o: Pick<CcxtOrder, "status" | "filled" | "amount">): OrderStatus {
  const filled = o.filled ?? 0;
  switch (o.status) {
    case "closed":
      return "FILLED";
    case "open":
      return filled > 0 ? "PARTIALLY_FILLED" : "ACKNOWLEDGED";
    case "canceled":
    case "cancelled":
      return filled > 0 ? "PARTIALLY_FILLED" : "CANCELLED";
    case "expired":
      return "EXPIRED";
    case "rejected":
      return "REJECTED";
    default:
      return "UNKNOWN";
  }
}

/** Map CCXT's error hierarchy onto our fail-closed BrokerError codes. */
export function mapCcxtError(e: unknown, mutating: boolean): BrokerError {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ccxt.AuthenticationError || e instanceof ccxt.PermissionDenied) {
    return /ip|whitelist/i.test(msg)
      ? new BrokerError(msg, "IP_NOT_WHITELISTED")
      : new BrokerError(msg, "AUTH");
  }
  if (e instanceof ccxt.RateLimitExceeded || e instanceof ccxt.DDoSProtection)
    return new BrokerError(msg, "RATE_LIMIT", true);
  if (e instanceof ccxt.InsufficientFunds || e instanceof ccxt.InvalidOrder || e instanceof ccxt.BadRequest) {
    return new BrokerError(msg, "REJECTED");
  }
  if (e instanceof ccxt.NetworkError || e instanceof ccxt.RequestTimeout) {
    // A timed-out order call may or may not have reached the exchange: NEVER assume.
    return mutating
      ? new BrokerError(`order outcome unknown: ${msg}`, "UNKNOWN_STATE")
      : new BrokerError(msg, "NETWORK", true);
  }
  return mutating
    ? new BrokerError(`order outcome unknown: ${msg}`, "UNKNOWN_STATE")
    : new BrokerError(msg, "BAD_RESPONSE");
}

/**
 * One adapter for 100+ crypto exchanges via CCXT (https://github.com/ccxt/ccxt).
 * Idempotency: our deterministic tag is sent as the exchange clientOrderId and looked up before
 * placing. Spot is long-only (enforced by the risk gateway); perps use fetchPositions.
 */
export class CcxtAdapter implements BrokerAdapter {
  readonly id = "crypto" as const;
  readonly ex: ExchangeLike;
  private readonly bySymbol = new Map<string, Instrument>();
  private readonly orderSymbol = new Map<string, string>();
  private marketsLoaded = false;

  constructor(private readonly cfg: CcxtConfig) {
    if (cfg.exchange) this.ex = cfg.exchange;
    else {
      const Ctor = (ccxt as unknown as Record<string, new (o: object) => ExchangeLike>)[cfg.exchangeId];
      if (!Ctor) throw new BrokerError(`unknown CCXT exchange "${cfg.exchangeId}"`, "REJECTED");
      this.ex = new Ctor({
        apiKey: cfg.apiKey,
        secret: cfg.secret,
        password: cfg.password,
        uid: cfg.uid,
        enableRateLimit: true,
        timeout: cfg.timeoutMs ?? 10_000,
      });
      if (cfg.sandbox) this.ex.setSandboxMode?.(true);
    }
    for (const i of cfg.instruments) if (i.venueSymbol) this.bySymbol.set(i.venueSymbol, i);
  }

  private get hasKeys(): boolean {
    return !!(this.cfg.apiKey && this.cfg.secret) || !!this.cfg.exchange;
  }

  private symbolOf(inst: Instrument): string {
    if (!inst.venueSymbol) throw new BrokerError(`instrument ${inst.id} has no venueSymbol`, "REJECTED");
    if (inst.venue && inst.venue !== this.cfg.exchangeId) {
      throw new BrokerError(
        `instrument ${inst.id} belongs to ${inst.venue}, adapter is ${this.cfg.exchangeId}`,
        "REJECTED",
      );
    }
    return inst.venueSymbol;
  }

  private async ensureMarkets(): Promise<void> {
    if (this.marketsLoaded) return;
    try {
      await this.ex.loadMarkets();
      this.marketsLoaded = true;
    } catch (e) {
      throw mapCcxtError(e, false);
    }
  }

  private async call<T>(fn: () => Promise<T>, mutating = false): Promise<T> {
    await this.ensureMarkets();
    try {
      return await fn();
    } catch (e) {
      throw mapCcxtError(e, mutating);
    }
  }

  async connect(): Promise<void> {
    await this.ensureMarkets();
    if (this.hasKeys) await this.getBalance();
  }

  async isSessionValid(): Promise<boolean> {
    if (!this.hasKeys) return false;
    try {
      await this.getBalance();
      return true;
    } catch (e) {
      if (e instanceof BrokerError && (e.code === "AUTH" || e.code === "IP_NOT_WHITELISTED")) return false;
      throw e;
    }
  }

  async getBalance(): Promise<Balance> {
    const b = await this.call(() => this.ex.fetchBalance());
    const q = this.cfg.quoteCurrency;
    const free = Number((b.free as Record<string, number> | undefined)?.[q] ?? 0);
    const used = Number((b.used as Record<string, number> | undefined)?.[q] ?? 0);
    const total = Number((b.total as Record<string, number> | undefined)?.[q] ?? free + used);
    // Value managed spot holdings at last price so equity reflects open spot positions.
    let holdings = 0;
    const totals = (b.total as Record<string, number> | undefined) ?? {};
    const spot = this.cfg.instruments.filter((i) => i.instrumentType === "SPOT");
    if (spot.length) {
      const px = await this.getLtp(spot).catch(() => ({}) as Record<string, number>);
      for (const i of spot) {
        const base = i.venueSymbol!.split("/")[0]!;
        holdings += Number(totals[base] ?? 0) * (px[i.id] ?? 0);
      }
    }
    return { availableCash: free, usedMargin: used, totalEquity: total + holdings };
  }

  async getPositions(): Promise<Position[]> {
    const out: Position[] = [];
    const spot = this.cfg.instruments.filter((i) => i.instrumentType === "SPOT");
    if (spot.length) {
      const b = await this.call(() => this.ex.fetchBalance());
      const totals = (b.total as Record<string, number> | undefined) ?? {};
      for (const i of spot) {
        const base = i.venueSymbol!.split("/")[0]!;
        const qty = Number(totals[base] ?? 0);
        // Ignore dust below one lot step.
        if (qty >= i.lotSize)
          out.push({
            instrumentId: i.id,
            quantity: floorTo(qty, i.lotSize),
            averagePrice: 0,
            realisedPnl: 0,
            unrealisedPnl: 0,
            product: "DELIVERY",
          });
      }
    }
    const perps = this.cfg.instruments.filter((i) => i.instrumentType === "PERP");
    if (perps.length && this.ex.fetchPositions) {
      const ps = await this.call(() => this.ex.fetchPositions!(perps.map((p) => p.venueSymbol!)));
      for (const p of ps) {
        const inst = this.bySymbol.get(p.symbol);
        if (!inst || !p.contracts) continue;
        const sign = p.side === "short" ? -1 : 1;
        out.push({
          instrumentId: inst.id,
          quantity: sign * p.contracts,
          averagePrice: p.entryPrice ?? 0,
          lastPrice: p.markPrice,
          realisedPnl: p.realizedPnl ?? 0,
          unrealisedPnl: p.unrealizedPnl ?? 0,
          product: "NORMAL",
        });
      }
    }
    return out;
  }

  private toOrder(o: CcxtOrder, clientOrderId?: string): Order {
    const inst = this.bySymbol.get(o.symbol);
    return {
      clientOrderId: clientOrderId ?? o.clientOrderId ?? "",
      brokerOrderId: o.id,
      instrumentId: inst?.id ?? `CRYPTO:${this.cfg.exchangeId}:${o.symbol}`,
      side: o.side === "buy" ? "BUY" : "SELL",
      quantity: o.amount,
      orderType: o.triggerPrice || o.stopPrice ? "SL_LIMIT" : "LIMIT",
      product: inst?.instrumentType === "PERP" ? "NORMAL" : "DELIVERY",
      price: o.price ?? 0,
      triggerPrice: o.triggerPrice ?? o.stopPrice ?? undefined,
      status: mapCcxtStatus(o),
      filledQuantity: o.filled ?? 0,
      averagePrice: o.average ?? undefined,
      updatedAt: o.lastUpdateTimestamp ?? o.timestamp ?? Date.now(),
    };
  }

  private async recentOrders(symbol?: string): Promise<CcxtOrder[]> {
    const symbols = symbol ? [symbol] : [...this.bySymbol.keys()];
    const all: CcxtOrder[] = [];
    for (const s of symbols) {
      if (this.ex.fetchOrders && this.ex.has.fetchOrders) {
        all.push(...(await this.call(() => this.ex.fetchOrders!(s, undefined, 100))));
      } else {
        all.push(...(await this.call(() => this.ex.fetchOpenOrders(s))));
        if (this.ex.fetchClosedOrders && this.ex.has.fetchClosedOrders) {
          all.push(...(await this.call(() => this.ex.fetchClosedOrders!(s, undefined, 100))));
        }
      }
    }
    return all;
  }

  async getOrders(): Promise<Order[]> {
    return (await this.recentOrders()).map((o) => this.toOrder(o));
  }

  async findOrder(clientOrderId: string): Promise<Order | undefined> {
    const tag = await shortTag(clientOrderId);
    const o = (await this.recentOrders()).find((x) => x.clientOrderId === tag);
    if (o) this.orderSymbol.set(o.id, o.symbol);
    return o ? this.toOrder(o, clientOrderId) : undefined;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const symbol = this.symbolOf(req.instrument);
    const tag = await shortTag(req.clientOrderId);
    const existing = (await this.recentOrders(symbol)).find((o) => o.clientOrderId === tag);
    if (existing) return { ...this.toOrder(existing, req.clientOrderId) };

    const params: Record<string, unknown> = { clientOrderId: tag };
    if (req.orderType === "SL_LIMIT") params.triggerPrice = req.triggerPrice;
    if (req.instrument.instrumentType === "PERP" && req.tag === "reduce") params.reduceOnly = true;
    const o = await this.call(
      () =>
        this.ex.createOrder(
          symbol,
          "limit",
          req.side === "BUY" ? "buy" : "sell",
          req.quantity,
          req.price,
          params,
        ),
      true,
    );
    this.orderSymbol.set(o.id, symbol);
    return {
      clientOrderId: req.clientOrderId,
      brokerOrderId: o.id,
      status: o.status ? mapCcxtStatus(o) : "SUBMITTED",
      filledQuantity: o.filled ?? 0,
      averagePrice: o.average ?? undefined,
    };
  }

  private async symbolForOrder(brokerOrderId: string): Promise<string> {
    const cached = this.orderSymbol.get(brokerOrderId);
    if (cached) return cached;
    const o = (await this.recentOrders()).find((x) => x.id === brokerOrderId);
    if (!o) throw new BrokerError(`order ${brokerOrderId} not found on ${this.cfg.exchangeId}`, "REJECTED");
    this.orderSymbol.set(o.id, o.symbol);
    return o.symbol;
  }

  /**
   * Stops are tightened via editOrder where the exchange supports it; otherwise cancel + re-place
   * (the returned brokerOrderId/clientOrderId then change and the caller must track the new ones).
   */
  async modifyOrder(brokerOrderId: string, m: ModifyRequest): Promise<OrderResult> {
    const symbol = await this.symbolForOrder(brokerOrderId);
    const current = (await this.recentOrders(symbol)).find((o) => o.id === brokerOrderId);
    if (!current) throw new BrokerError(`order ${brokerOrderId} not found`, "REJECTED");
    const amount = m.quantity ?? current.amount;
    const price = m.price ?? current.price;
    const params: Record<string, unknown> = {};
    if (m.triggerPrice !== undefined) params.triggerPrice = m.triggerPrice;
    if (this.ex.editOrder && this.ex.has.editOrder === true) {
      const o = await this.call(
        () => this.ex.editOrder!(brokerOrderId, symbol, "limit", current.side, amount, price, params),
        true,
      );
      this.orderSymbol.set(o.id, symbol);
      return {
        clientOrderId: current.clientOrderId ?? "",
        brokerOrderId: o.id,
        status: mapCcxtStatus(o),
        filledQuantity: o.filled ?? 0,
      };
    }
    await this.call(() => this.ex.cancelOrder(brokerOrderId, symbol), true);
    const newTag = `${(current.clientOrderId ?? "atb").slice(0, 14)}r${Date.now().toString(36).slice(-5)}`;
    const o = await this.call(
      () =>
        this.ex.createOrder(symbol, "limit", current.side, amount, price, {
          ...params,
          clientOrderId: newTag,
        }),
      true,
    );
    this.orderSymbol.set(o.id, symbol);
    return {
      clientOrderId: newTag,
      brokerOrderId: o.id,
      status: mapCcxtStatus(o),
      filledQuantity: o.filled ?? 0,
    };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const symbol = await this.symbolForOrder(brokerOrderId);
    await this.call(() => this.ex.cancelOrder(brokerOrderId, symbol), true);
  }

  // ------------------------------------------------------------------ market data (public, no keys needed)

  async getLtp(instruments: readonly Instrument[]): Promise<Record<string, number>> {
    const mine = instruments.filter(
      (i) => i.exchange === "CRYPTO" && i.venueSymbol && (!i.venue || i.venue === this.cfg.exchangeId),
    );
    if (mine.length === 0) return {};
    const symbols = mine.map((i) => i.venueSymbol!);
    const out: Record<string, number> = {};
    if (this.ex.fetchTickers && this.ex.has.fetchTickers) {
      const t = await this.call(() => this.ex.fetchTickers!(symbols));
      for (const i of mine) {
        const px = t[i.venueSymbol!]?.last ?? t[i.venueSymbol!]?.close;
        if (px && px > 0) out[i.id] = px;
      }
    } else {
      for (const i of mine) {
        const t = await this.call(() => this.ex.fetchTicker(i.venueSymbol!));
        const px = t.last ?? t.close;
        if (px && px > 0) out[i.id] = px;
      }
    }
    return out;
  }

  async getHistorical(symbol: string, timeframe: Timeframe, from: Date, to: Date): Promise<Candle[]> {
    if (!this.ex.has.fetchOHLCV)
      throw new BrokerError(`${this.cfg.exchangeId} has no historical candles API`, "REJECTED");
    const tf = CCXT_TIMEFRAME[timeframe];
    if (!tf) throw new BrokerError(`timeframe ${timeframe} not supported for crypto`, "REJECTED");
    const out: Candle[] = [];
    let since = from.getTime();
    for (let guard = 0; guard < 10_000 && since < to.getTime(); guard++) {
      const rows = await this.call(() => this.ex.fetchOHLCV(symbol, tf, since, 500));
      if (!rows.length) break;
      for (const [t, o, h, l, c, v] of rows) {
        if (t! > to.getTime()) break;
        if (!out.length || t! > out.at(-1)!.t) out.push({ t: t!, o: o!, h: h!, l: l!, c: c!, v: v ?? 0 });
      }
      const last = rows.at(-1)![0]!;
      if (last <= since) break;
      since = last + 1;
    }
    return out;
  }

  /** Build our Instrument from exchange market metadata (lot/tick sizes, minimums). */
  async instrumentFor(symbol: string): Promise<Instrument> {
    await this.ensureMarkets();
    const m = this.ex.markets?.[symbol];
    if (!m) throw new BrokerError(`${symbol} not listed on ${this.cfg.exchangeId}`, "REJECTED");
    const perp = !!m.swap;
    return {
      id: `CRYPTO:${this.cfg.exchangeId}:${m.symbol}`,
      exchange: "CRYPTO",
      tradingSymbol: `${m.base}${m.quote}${perp ? "-PERP" : ""}`,
      instrumentType: perp ? "PERP" : "SPOT",
      lotSize: stepFrom(m.precision.amount, this.ex.precisionMode, 1e-8),
      tickSize: stepFrom(m.precision.price, this.ex.precisionMode, 0.01),
      venue: this.cfg.exchangeId,
      venueSymbol: m.symbol,
      quoteCurrency: m.quote,
      minQty: m.limits?.amount?.min,
      minNotional: m.limits?.cost?.min,
    };
  }
}

/** CCXT precision-mode constant (TICK_SIZE = 4). */
const TICK_SIZE = 4;

const CCXT_TIMEFRAME: Partial<Record<Timeframe, string>> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "1d": "1d",
};

/** CCXT precision is a step in TICK_SIZE mode (most exchanges) or a number of decimals otherwise. */
export function stepFrom(p: number | undefined, precisionMode: number | undefined, fallback: number): number {
  if (p === undefined || !Number.isFinite(p) || p < 0) return fallback;
  if (precisionMode === TICK_SIZE) return p > 0 ? p : fallback;
  return Number((10 ** -p).toFixed(12)); // DECIMAL_PLACES / SIGNIFICANT_DIGITS
}

function floorTo(q: number, step: number): number {
  return Number((Math.floor(q / step + 1e-9) * step).toFixed(10));
}
