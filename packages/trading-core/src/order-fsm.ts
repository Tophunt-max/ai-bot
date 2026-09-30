import type { OrderStatus } from "@atb/shared-types";

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ["VALIDATED", "REJECTED"],
  VALIDATED: ["SUBMITTED", "REJECTED", "CANCELLED"],
  // SUBMITTED -> UNKNOWN when the broker call timed out: we must reconcile, never assume.
  SUBMITTED: ["ACKNOWLEDGED", "REJECTED", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "UNKNOWN"],
  ACKNOWLEDGED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "EXPIRED", "REJECTED", "UNKNOWN"],
  PARTIALLY_FILLED: ["PARTIALLY_FILLED", "FILLED", "CANCELLED", "EXPIRED", "UNKNOWN"],
  // UNKNOWN is resolved only by reconciliation against the broker order book.
  UNKNOWN: ["ACKNOWLEDGED", "PARTIALLY_FILLED", "FILLED", "REJECTED", "CANCELLED", "EXPIRED"],
  FILLED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const TERMINAL_STATUSES: readonly OrderStatus[] = ["FILLED", "REJECTED", "CANCELLED", "EXPIRED"];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order transition ${from} -> ${to}`);
  }
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Deterministic idempotency key: same signal + leg always yields the same id. */
export function clientOrderIdFor(
  signalId: string,
  leg: "ENTRY" | "SL" | "TP1" | "TP2" | "TP3" | "EXIT",
): string {
  const safe = signalId.replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  return `${safe}_${leg}`;
}
