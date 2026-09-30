import { DurableObject } from "cloudflare:workers";
import type { Position } from "@atb/shared-types";
import type { Env } from "../env";

export interface ManagedPosition extends Position {
  stopPrice: number;
  stopOrderId?: string; // broker-resident protective stop
  targets: number[];
  trailing?: { enabled: boolean; atrMultiple: number };
  breakEvenMoved: boolean;
  openedAt: number;
}

/**
 * Open positions & SL/TP lifecycle. Invariant: an open position ALWAYS has a stop,
 * and a stop may only be tightened (moved in the protective direction), never removed/widened.
 */
export class PositionManagerDO extends DurableObject<Env> {
  async list(): Promise<ManagedPosition[]> {
    const all = await this.ctx.storage.list<ManagedPosition>({ prefix: "pos:" });
    return [...all.values()].filter((p) => p.quantity !== 0);
  }

  async upsert(p: ManagedPosition): Promise<ManagedPosition> {
    if (p.quantity !== 0 && !(p.stopPrice > 0)) throw new Error("open position requires a stop");
    await this.ctx.storage.put(`pos:${p.instrumentId}:${p.product}`, p);
    return p;
  }

  async moveStop(instrumentId: string, product: string, newStop: number): Promise<ManagedPosition> {
    const key = `pos:${instrumentId}:${product}`;
    const p = await this.ctx.storage.get<ManagedPosition>(key);
    if (!p) throw new Error("position not found");
    const tighter = p.quantity > 0 ? newStop > p.stopPrice : newStop < p.stopPrice;
    if (!tighter) throw new Error("stop can only be tightened");
    p.stopPrice = newStop;
    await this.ctx.storage.put(key, p);
    return p;
  }
}
