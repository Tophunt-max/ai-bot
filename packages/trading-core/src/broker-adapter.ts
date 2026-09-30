import type {
  Balance,
  BrokerId,
  ModifyRequest,
  Order,
  OrderRequest,
  OrderResult,
  Position,
} from "@atb/shared-types";

/**
 * Every broker (paper or real) implements this. Only the Execution Gateway
 * (static-IP VM) may instantiate real adapters. AI code never touches this.
 */
export interface BrokerAdapter {
  readonly id: BrokerId;
  connect(): Promise<void>;
  isSessionValid(): Promise<boolean>;
  getBalance(): Promise<Balance>;
  getPositions(): Promise<Position[]>;
  getOrders(): Promise<Order[]>;
  placeOrder(order: OrderRequest): Promise<OrderResult>;
  modifyOrder(brokerOrderId: string, request: ModifyRequest): Promise<OrderResult>;
  cancelOrder(brokerOrderId: string): Promise<void>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly code:
      | "AUTH"
      | "IP_NOT_WHITELISTED"
      | "RATE_LIMIT"
      | "REJECTED"
      | "NETWORK"
      | "UNKNOWN_STATE"
      | "NOT_IMPLEMENTED"
      | "BAD_RESPONSE",
    readonly retriable = false,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
