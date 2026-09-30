import { DurableObject } from "cloudflare:workers";
import type { Order, OrderStatus } from "@atb/shared-types";
import { assertTransition, isTerminal } from "@atb/trading-core";
import type { Env } from "../env";

export interface ManagedOrder extends Order {
  signalId?: string;
  leg: string;
  history: Array<{ status: OrderStatus; at: number; note?: string }>;
}

/**
 * Order state + idempotency. The same clientOrderId can only ever be registered once;
 * status changes must follow the order FSM. UNKNOWN orders are surfaced for reconciliation.
 */
export class OrderManagerDO extends DurableObject<Env> {
  async register(order: Omit<ManagedOrder, "history" | "status" | "updatedAt">): Promise<{
    created: boolean;
    order: ManagedOrder;
  }> {
    const key = `order:${order.clientOrderId}`;
    const existing = await this.ctx.storage.get<ManagedOrder>(key);
    if (existing) return { created: false, order: existing };
    const now = Date.now();
    const o: ManagedOrder = {
      ...order,
      status: "CREATED",
      updatedAt: now,
      history: [{ status: "CREATED", at: now }],
    };
    await this.ctx.storage.put(key, o);
    return { created: true, order: o };
  }

  async transition(
    clientOrderId: string,
    to: OrderStatus,
    patch: Partial<Pick<Order, "brokerOrderId" | "filledQuantity" | "averagePrice" | "message">> = {},
  ): Promise<ManagedOrder> {
    const key = `order:${clientOrderId}`;
    const o = await this.ctx.storage.get<ManagedOrder>(key);
    if (!o) throw new Error(`unknown order ${clientOrderId}`);
    if (o.status !== to) assertTransition(o.status, to);
    Object.assign(o, patch, { status: to, updatedAt: Date.now() });
    o.history.push({ status: to, at: o.updatedAt, note: patch.message });
    await this.ctx.storage.put(key, o);
    return o;
  }

  async get(clientOrderId: string): Promise<ManagedOrder | undefined> {
    return this.ctx.storage.get<ManagedOrder>(`order:${clientOrderId}`);
  }

  async listOpen(): Promise<ManagedOrder[]> {
    const all = await this.ctx.storage.list<ManagedOrder>({ prefix: "order:" });
    return [...all.values()].filter((o) => !isTerminal(o.status));
  }

  async listUnknown(): Promise<ManagedOrder[]> {
    return (await this.listOpen()).filter((o) => o.status === "UNKNOWN");
  }
}
