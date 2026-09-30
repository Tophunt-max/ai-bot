import type { Balance, ModifyRequest, Order, OrderRequest, OrderResult, Position } from "@atb/shared-types";
import { BrokerError, type BrokerAdapter } from "./broker-adapter";
import { estimateCosts } from "./costs";

export interface PaperBrokerOptions {
  startingCash: number;
  /** Adverse slippage in basis points applied to every fill. */
  slippageBps: number;
  /** Returns current LTP for an instrument id; undefined => no fill (stale data). */
  priceFeed: (instrumentId: string) => number | undefined;
  now?: () => number;
}

/**
 * Deterministic paper broker: LIMIT orders fill when marketable against LTP
 * (with adverse slippage, capped at the limit price). Charges Indian costs.
 * Idempotent on clientOrderId, exactly like the real adapters must be.
 */
export class PaperBroker implements BrokerAdapter {
  readonly id = "paper" as const;
  private cash: number;
  private seq = 0;
  private readonly orders = new Map<string, Order>(); // brokerOrderId -> order
  private readonly byClientId = new Map<string, string>();
  private readonly positions = new Map<string, Position>();
  private readonly now: () => number;

  constructor(private readonly opts: PaperBrokerOptions) {
    this.cash = opts.startingCash;
    this.now = opts.now ?? Date.now;
  }

  async connect(): Promise<void> {}
  async isSessionValid(): Promise<boolean> {
    return true;
  }

  async getBalance(): Promise<Balance> {
    let mtm = 0;
    for (const p of this.positions.values()) {
      const ltp = this.opts.priceFeed(p.instrumentId) ?? p.averagePrice;
      mtm += p.quantity * ltp;
    }
    return { availableCash: this.cash, usedMargin: 0, totalEquity: this.cash + mtm };
  }

  async getPositions(): Promise<Position[]> {
    return [...this.positions.values()].filter((p) => p.quantity !== 0 || p.realisedPnl !== 0);
  }

  async getOrders(): Promise<Order[]> {
    return [...this.orders.values()];
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const existing = this.byClientId.get(req.clientOrderId);
    if (existing) return this.toResult(this.orders.get(existing)!);

    const brokerOrderId = `PAPER-${++this.seq}`;
    const order: Order = {
      clientOrderId: req.clientOrderId,
      brokerOrderId,
      instrumentId: req.instrument.id,
      side: req.side,
      quantity: req.quantity,
      orderType: req.orderType,
      product: req.product,
      price: req.price,
      triggerPrice: req.triggerPrice,
      status: "ACKNOWLEDGED",
      filledQuantity: 0,
      updatedAt: this.now(),
    };
    this.orders.set(brokerOrderId, order);
    this.byClientId.set(req.clientOrderId, brokerOrderId);
    this.tryFill(order, req);
    return this.toResult(order);
  }

  async modifyOrder(brokerOrderId: string, m: ModifyRequest): Promise<OrderResult> {
    const o = this.orders.get(brokerOrderId);
    if (!o) throw new BrokerError(`order ${brokerOrderId} not found`, "REJECTED");
    if (o.status !== "ACKNOWLEDGED") throw new BrokerError(`order is ${o.status}`, "REJECTED");
    if (m.price !== undefined) o.price = m.price;
    if (m.quantity !== undefined) o.quantity = m.quantity;
    if (m.triggerPrice !== undefined) o.triggerPrice = m.triggerPrice;
    o.updatedAt = this.now();
    return this.toResult(o);
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const o = this.orders.get(brokerOrderId);
    if (!o) throw new BrokerError(`order ${brokerOrderId} not found`, "REJECTED");
    if (o.status === "ACKNOWLEDGED" || o.status === "PARTIALLY_FILLED") {
      o.status = "CANCELLED";
      o.updatedAt = this.now();
    }
  }

  /** Re-evaluate resting orders against current prices (call on every tick/candle). */
  processPendingOrders(instrumentLookup: (id: string) => OrderRequest["instrument"] | undefined): void {
    for (const o of this.orders.values()) {
      if (o.status !== "ACKNOWLEDGED") continue;
      const inst = instrumentLookup(o.instrumentId);
      if (inst) this.tryFill(o, { ...o, instrument: inst } as OrderRequest);
    }
  }

  private tryFill(o: Order, req: OrderRequest): void {
    const ltp = this.opts.priceFeed(o.instrumentId);
    if (ltp === undefined) return;
    const isBuy = o.side === "BUY";
    if (o.orderType === "SL_LIMIT") {
      const trig = o.triggerPrice ?? o.price;
      const triggered = isBuy ? ltp >= trig : ltp <= trig;
      if (!triggered) return;
    }
    const marketable = isBuy ? ltp <= o.price : ltp >= o.price;
    if (!marketable) return;

    const slip = (ltp * this.opts.slippageBps) / 10_000;
    const fillPx = isBuy ? Math.min(o.price, ltp + slip) : Math.max(o.price, ltp - slip);
    const costs = estimateCosts({
      side: o.side,
      quantity: o.quantity,
      price: fillPx,
      instrumentType: req.instrument.instrumentType,
      product: o.product,
    });

    const signed = isBuy ? o.quantity : -o.quantity;
    this.cash -= signed * fillPx + costs.total;
    this.applyToPosition(o.instrumentId, signed, fillPx, costs.total, o.product);

    o.status = "FILLED";
    o.filledQuantity = o.quantity;
    o.averagePrice = fillPx;
    o.updatedAt = this.now();
  }

  private applyToPosition(id: string, qty: number, px: number, fees: number, product: Position["product"]) {
    const p = this.positions.get(id) ?? {
      instrumentId: id,
      quantity: 0,
      averagePrice: 0,
      realisedPnl: 0,
      unrealisedPnl: 0,
      product,
    };
    const sameDir = p.quantity === 0 || Math.sign(p.quantity) === Math.sign(qty);
    if (sameDir) {
      const newQty = p.quantity + qty;
      p.averagePrice = (p.averagePrice * Math.abs(p.quantity) + px * Math.abs(qty)) / Math.abs(newQty);
      p.quantity = newQty;
    } else {
      const closing = Math.min(Math.abs(qty), Math.abs(p.quantity));
      p.realisedPnl += closing * (px - p.averagePrice) * Math.sign(p.quantity);
      const newQty = p.quantity + qty;
      if (newQty !== 0 && Math.sign(newQty) !== Math.sign(p.quantity)) p.averagePrice = px;
      if (newQty === 0) p.averagePrice = 0;
      p.quantity = newQty;
    }
    p.realisedPnl -= fees;
    this.positions.set(id, p);
  }

  private toResult(o: Order): OrderResult {
    return {
      clientOrderId: o.clientOrderId,
      brokerOrderId: o.brokerOrderId,
      status: o.status,
      filledQuantity: o.filledQuantity,
      averagePrice: o.averagePrice,
    };
  }
}
