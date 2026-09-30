import type { BrokerId, ModifyRequest, OrderRequest } from "@atb/shared-types";
import { BrokerError, PaperBroker, type BrokerAdapter, type PaperBrokerOptions } from "@atb/trading-core";
import { DhanAdapter } from "./dhan";
import type { FetchLike } from "./http";
import { BROKERS } from "./registry";
import { UpstoxAdapter } from "./upstox";
import { ZerodhaAdapter } from "./zerodha";

/**
 * Placeholder for brokers whose adapter is not implemented yet.
 * Fails CLOSED on every call so a misconfiguration can never place orders.
 */
export class NotImplementedAdapter implements BrokerAdapter {
  constructor(readonly id: BrokerId) {}
  private fail(): never {
    throw new BrokerError(`${BROKERS[this.id].name} adapter not implemented yet`, "NOT_IMPLEMENTED");
  }
  async connect(): Promise<void> {
    this.fail();
  }
  async isSessionValid(): Promise<boolean> {
    return false;
  }
  async getBalance(): Promise<never> {
    this.fail();
  }
  async getPositions(): Promise<never> {
    this.fail();
  }
  async getOrders(): Promise<never> {
    this.fail();
  }
  async placeOrder(_o: OrderRequest): Promise<never> {
    this.fail();
  }
  async modifyOrder(_id: string, _m: ModifyRequest): Promise<never> {
    this.fail();
  }
  async cancelOrder(_id: string): Promise<void> {
    this.fail();
  }
}

export type BrokerEnv = Record<string, string | undefined>;

function required(env: BrokerEnv, key: string): string {
  const v = env[key];
  if (!v) throw new BrokerError(`missing env ${key}`, "AUTH");
  return v;
}

export function createBroker(
  id: BrokerId,
  env: BrokerEnv,
  opts: { fetch?: FetchLike; paper?: PaperBrokerOptions } = {},
): BrokerAdapter {
  switch (id) {
    case "paper":
      if (!opts.paper) throw new Error("paper broker requires options");
      return new PaperBroker(opts.paper);
    case "zerodha":
      return new ZerodhaAdapter({
        apiKey: required(env, "ZERODHA_API_KEY"),
        accessToken: env.ZERODHA_ACCESS_TOKEN,
        fetch: opts.fetch,
      });
    case "dhan":
      return new DhanAdapter({
        clientId: required(env, "DHAN_CLIENT_ID"),
        accessToken: required(env, "DHAN_ACCESS_TOKEN"),
        fetch: opts.fetch,
      });
    case "upstox":
      return new UpstoxAdapter({ accessToken: required(env, "UPSTOX_ACCESS_TOKEN"), fetch: opts.fetch });
    default:
      return new NotImplementedAdapter(id);
  }
}
