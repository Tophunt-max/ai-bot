import type { Instrument, OrderRequest, Side } from "@atb/shared-types";
import { protectedLimitPrice, roundToTick, type BrokerAdapter } from "@atb/trading-core";
import type { BrokerTarget, OrderExecutor } from "./executor";

export interface Fill {
  filledQty: number;
  avgPrice: number;
}
export type VenueResult = Fill | { error: string };
export const isFill = (r: VenueResult): r is Fill => "filledQty" in r;

export interface StopState {
  stopClientId?: string;
  stopBrokerOrderId?: string;
}

/** Where orders go. SHADOW → SimVenue (nothing sent). PAPER/CANARY/LIVE → BrokerVenue. */
export interface Venue {
  readonly kind: "SIM" | "BROKER";
  enter(o: OrderRequest, refPrice: number): Promise<VenueResult>;
  placeStop(
    key: string,
    inst: Instrument,
    entrySide: Side,
    qty: number,
    stop: number,
    s: StopState,
    product: OrderRequest["product"],
  ): Promise<VenueResult | { ok: true }>;
  updateStop(inst: Instrument, entrySide: Side, qty: number, stop: number, s: StopState): Promise<boolean>;
  cancelStop(s: StopState): Promise<boolean>;
  /** Broker-side stop fill (null if not filled). */
  stopFilled(s: StopState): Promise<Fill | null>;
  exit(
    clientOrderId: string,
    inst: Instrument,
    entrySide: Side,
    qty: number,
    refPrice: number,
    product: OrderRequest["product"],
  ): Promise<VenueResult>;
}

const opposite = (s: Side): Side => (s === "BUY" ? "SELL" : "BUY");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hypothetical fills for SHADOW mode. Adverse slippage applied; stops are checked by the engine on ticks. */
export class SimVenue implements Venue {
  readonly kind = "SIM" as const;
  constructor(private readonly slippageBps = 3) {}

  private slip(px: number, side: Side) {
    const s = (px * this.slippageBps) / 10_000;
    return side === "BUY" ? px + s : px - s;
  }
  async enter(o: OrderRequest, refPrice: number): Promise<VenueResult> {
    return { filledQty: o.quantity, avgPrice: this.slip(refPrice, o.side) };
  }
  async placeStop() {
    return { ok: true as const };
  }
  async updateStop() {
    return true;
  }
  async cancelStop() {
    return true;
  }
  async stopFilled() {
    return null;
  }
  async exit(
    _id: string,
    _i: Instrument,
    entrySide: Side,
    qty: number,
    refPrice: number,
  ): Promise<VenueResult> {
    return { filledQty: qty, avgPrice: this.slip(refPrice, opposite(entrySide)) };
  }
}

/**
 * Real order flow through the OrderExecutor gates. Used for PAPER (paper broker) and
 * CANARY/LIVE (real broker) so that paper and live share the same code path.
 */
export class BrokerVenue implements Venue {
  readonly kind = "BROKER" as const;
  constructor(
    private readonly executor: OrderExecutor,
    private readonly target: BrokerTarget,
    private readonly opts: { fillTimeoutMs: number; pollMs: number } = { fillTimeoutMs: 20_000, pollMs: 500 },
  ) {}

  private get broker(): BrokerAdapter {
    return this.executor.brokerFor(this.target);
  }

  /** Wait for a terminal state; cancel any unfilled remainder at timeout. Never assumes a fill. */
  private async awaitFill(clientOrderId: string, brokerOrderId?: string): Promise<VenueResult> {
    const deadline = Date.now() + this.opts.fillTimeoutMs;
    for (;;) {
      const o = await this.broker.findOrder(clientOrderId).catch(() => undefined);
      if (o?.status === "FILLED")
        return { filledQty: o.filledQuantity, avgPrice: o.averagePrice ?? Number.NaN };
      if (o && (o.status === "REJECTED" || o.status === "CANCELLED" || o.status === "EXPIRED")) {
        return o.filledQuantity > 0
          ? { filledQty: o.filledQuantity, avgPrice: o.averagePrice ?? Number.NaN }
          : { error: `order ${o.status}: ${o.message ?? ""}` };
      }
      if (Date.now() >= deadline) {
        const id = o?.brokerOrderId ?? brokerOrderId;
        if (id) await this.executor.cancel(id, this.target);
        const after = await this.broker.findOrder(clientOrderId).catch(() => undefined);
        if (after && after.filledQuantity > 0)
          return { filledQty: after.filledQuantity, avgPrice: after.averagePrice ?? Number.NaN };
        return { error: "not filled within timeout (cancelled)" };
      }
      await sleep(this.opts.pollMs);
    }
  }

  async enter(o: OrderRequest): Promise<VenueResult> {
    const r = await this.executor.submit(o, { target: this.target });
    if (!r.accepted) return { error: r.reasons.join("; ") };
    if (r.result.status === "FILLED")
      return { filledQty: r.result.filledQuantity, avgPrice: r.result.averagePrice ?? o.price };
    return this.awaitFill(o.clientOrderId, r.result.brokerOrderId);
  }

  async placeStop(
    key: string,
    inst: Instrument,
    entrySide: Side,
    qty: number,
    stop: number,
    s: StopState,
    product: OrderRequest["product"],
  ) {
    const side = opposite(entrySide);
    const trigger = roundToTick(stop, inst.tickSize);
    // SL-LIMIT with a protection band beyond the trigger so it fills in fast markets.
    const limit = protectedLimitPrice(trigger, side, inst.instrumentType, inst.tickSize);
    const clientOrderId = `${key}_SL`;
    const r = await this.executor.submit(
      {
        clientOrderId,
        instrument: inst,
        side,
        quantity: qty,
        orderType: "SL_LIMIT",
        product,
        price: limit,
        triggerPrice: trigger,
      },
      { protective: true, target: this.target },
    );
    if (!r.accepted) return { error: r.reasons.join("; ") };
    s.stopClientId = clientOrderId;
    s.stopBrokerOrderId = r.result.brokerOrderId;
    return { ok: true as const };
  }

  async updateStop(
    inst: Instrument,
    entrySide: Side,
    qty: number,
    stop: number,
    s: StopState,
  ): Promise<boolean> {
    if (!s.stopBrokerOrderId) return false;
    const side = opposite(entrySide);
    const trigger = roundToTick(stop, inst.tickSize);
    const r = await this.executor.modify(
      s.stopBrokerOrderId,
      {
        quantity: qty,
        triggerPrice: trigger,
        price: protectedLimitPrice(trigger, side, inst.instrumentType, inst.tickSize),
      },
      this.target,
    );
    return r.ok;
  }

  async cancelStop(s: StopState): Promise<boolean> {
    if (!s.stopBrokerOrderId) return true;
    return (await this.executor.cancel(s.stopBrokerOrderId, this.target)).ok;
  }

  async stopFilled(s: StopState): Promise<Fill | null> {
    if (!s.stopClientId) return null;
    const o = await this.broker.findOrder(s.stopClientId).catch(() => undefined);
    if (o && o.filledQuantity > 0 && (o.status === "FILLED" || o.status === "CANCELLED")) {
      return { filledQty: o.filledQuantity, avgPrice: o.averagePrice ?? Number.NaN };
    }
    return null;
  }

  async exit(
    clientOrderId: string,
    inst: Instrument,
    entrySide: Side,
    qty: number,
    refPrice: number,
    product: OrderRequest["product"],
  ): Promise<VenueResult> {
    const side = opposite(entrySide);
    const price = protectedLimitPrice(refPrice, side, inst.instrumentType, inst.tickSize);
    const r = await this.executor.submit(
      { clientOrderId, instrument: inst, side, quantity: qty, orderType: "LIMIT", product, price },
      { protective: true, target: this.target },
    );
    if (!r.accepted) return { error: r.reasons.join("; ") };
    if (r.result.status === "FILLED")
      return { filledQty: r.result.filledQuantity, avgPrice: r.result.averagePrice ?? price };
    return this.awaitFill(clientOrderId, r.result.brokerOrderId);
  }
}
