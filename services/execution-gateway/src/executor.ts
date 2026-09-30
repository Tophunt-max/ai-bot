import type { ModifyRequest, OrderRequest, OrderResult, TradingMode } from "@atb/shared-types";
import { BrokerError, SlidingWindowLimiter, type BrokerAdapter } from "@atb/trading-core";
import { orderRequestSchema } from "@atb/validation";
import type { ControlPlane, HeartbeatResponse } from "./control-plane";
import type { EgressStatus } from "./egress";

export type BrokerTarget = "paper" | "live";

export interface GatewayStatus {
  nodeId: string;
  leaseGranted: boolean;
  leaseHolder?: string;
  mode: TradingMode | "UNKNOWN";
  tradingEnabled: boolean;
  killSwitchActive: boolean;
  egress: EgressStatus;
  brokerSessionValid: boolean;
  lastHeartbeatAt: number;
  unknownOrders: string[];
}

export interface ExecutorDeps {
  nodeId: string;
  paperBroker: BrokerAdapter;
  liveBroker: BrokerAdapter;
  controlPlane: ControlPlane;
  checkEgress: () => Promise<EgressStatus>;
  maxOrdersPerSecond: number;
  heartbeatMaxAgeMs?: number;
  now?: () => number;
  /** Clock for the order rate limiter (replay mode uses simulated market time). */
  limiterNow?: () => number;
}

export type SubmitOutcome =
  { accepted: true; shadow: boolean; result: OrderResult } | { accepted: false; reasons: string[] };

/**
 * The ONLY component allowed to call broker order APIs. Every call is gated by:
 * lease (single active node) + control-plane state + egress IP + broker session +
 * rate limit + no unresolved UNKNOWN orders. Anything uncertain => reject.
 */
export class OrderExecutor {
  private readonly now: () => number;
  private readonly limiter: SlidingWindowLimiter;
  private readonly heartbeatMaxAgeMs: number;
  private readonly seen = new Map<string, OrderResult>();
  status: GatewayStatus;

  constructor(private readonly d: ExecutorDeps) {
    this.now = d.now ?? Date.now;
    this.limiter = new SlidingWindowLimiter(d.maxOrdersPerSecond, 1000, d.limiterNow ?? this.now);
    this.heartbeatMaxAgeMs = d.heartbeatMaxAgeMs ?? 20_000;
    this.status = {
      nodeId: d.nodeId,
      leaseGranted: false,
      mode: "UNKNOWN",
      tradingEnabled: false,
      killSwitchActive: false,
      egress: { ip: null, ok: false, checkedAt: 0 },
      brokerSessionValid: false,
      lastHeartbeatAt: 0,
      unknownOrders: [],
    };
  }

  get usesLiveBroker(): boolean {
    return this.status.mode === "CANARY" || this.status.mode === "LIVE";
  }

  /** Broker for the current mode (paper broker for PAPER, real broker for CANARY/LIVE). */
  get broker(): BrokerAdapter {
    return this.usesLiveBroker ? this.d.liveBroker : this.d.paperBroker;
  }

  /**
   * Gates for RISK-REDUCING actions (exits, stop placement/tightening, cancelling entries).
   * These stay allowed under kill switch / SAFE_MODE / trading disabled / stale control plane,
   * because protecting open positions must never depend on the AI or the control plane.
   */
  brokerFor(target?: BrokerTarget): BrokerAdapter {
    if (target === "paper") return this.d.paperBroker;
    if (target === "live") return this.d.liveBroker;
    return this.broker;
  }

  private isLive(target?: BrokerTarget): boolean {
    return target ? target === "live" : this.usesLiveBroker;
  }

  protectiveBlockReasons(target?: BrokerTarget): string[] {
    const s = this.status;
    const r: string[] = [];
    if (!s.leaseGranted) r.push(`execution lease held by ${s.leaseHolder ?? "nobody"}`);
    if (this.isLive(target) && !s.egress.ok) r.push(`egress IP ${s.egress.ip ?? "unknown"} not whitelisted`);
    if (!s.brokerSessionValid) r.push("broker session invalid");
    return r;
  }

  async heartbeat(): Promise<HeartbeatResponse | null> {
    this.status.egress = await this.d.checkEgress();
    try {
      this.status.brokerSessionValid = await (
        this.usesLiveBroker ? this.d.liveBroker : this.d.paperBroker
      ).isSessionValid();
    } catch {
      this.status.brokerSessionValid = false;
    }
    try {
      const hb = await this.d.controlPlane.heartbeat({
        nodeId: this.d.nodeId,
        egressIp: this.status.egress.ip ?? "",
        egressIpOk: this.status.egress.ok,
        brokerSessionValid: this.status.brokerSessionValid,
      });
      Object.assign(this.status, {
        leaseGranted: hb.leaseGranted,
        leaseHolder: hb.leaseHolder,
        mode: hb.mode,
        tradingEnabled: hb.tradingEnabled,
        killSwitchActive: hb.killSwitch.active,
        lastHeartbeatAt: this.now(),
      });
      // Re-check live session if mode just switched to a live mode.
      if (this.usesLiveBroker)
        this.status.brokerSessionValid = await this.d.liveBroker.isSessionValid().catch(() => false);
      return hb;
    } catch {
      // Control plane unreachable: keep last state but it will go stale and block orders.
      return null;
    }
  }

  blockReasons(): string[] {
    const s = this.status;
    const r: string[] = [];
    if (this.now() - s.lastHeartbeatAt > this.heartbeatMaxAgeMs) r.push("control-plane heartbeat stale");
    if (!s.leaseGranted) r.push(`execution lease held by ${s.leaseHolder ?? "nobody"}`);
    if (s.killSwitchActive) r.push("kill switch active");
    if (!s.tradingEnabled) r.push("trading disabled / risk locked");
    if (s.mode === "SAFE_MODE" || s.mode === "BACKTEST" || s.mode === "UNKNOWN") r.push(`mode ${s.mode}`);
    if (this.usesLiveBroker && !s.egress.ok) r.push(`egress IP ${s.egress.ip ?? "unknown"} not whitelisted`);
    if (!s.brokerSessionValid) r.push("broker session invalid");
    if (s.unknownOrders.length > 0)
      r.push(`${s.unknownOrders.length} order(s) in UNKNOWN state — reconcile first`);
    return r;
  }

  async submit(
    input: unknown,
    opts: { protective?: boolean; target?: BrokerTarget } = {},
  ): Promise<SubmitOutcome> {
    const parsed = orderRequestSchema.safeParse(input);
    if (!parsed.success) return { accepted: false, reasons: parsed.error.issues.map((i) => i.message) };
    const order = parsed.data as OrderRequest;

    const cached = this.seen.get(order.clientOrderId);
    if (cached) return { accepted: true, shadow: this.status.mode === "SHADOW", result: cached };

    const reasons = opts.protective ? this.protectiveBlockReasons(opts.target) : this.blockReasons();
    if (reasons.length) return { accepted: false, reasons };

    if (this.status.mode === "SHADOW" && !opts.protective) {
      const result: OrderResult = {
        clientOrderId: order.clientOrderId,
        status: "VALIDATED",
        filledQuantity: 0,
        message: "shadow: not sent",
      };
      this.seen.set(order.clientOrderId, result);
      return { accepted: true, shadow: true, result };
    }

    if (!(await this.acquire(!!opts.protective)))
      return { accepted: false, reasons: ["gateway order rate limit"] };

    const broker = this.brokerFor(opts.target);
    try {
      const result = await broker.placeOrder(order);
      this.seen.set(order.clientOrderId, result);
      return { accepted: true, shadow: false, result };
    } catch (e) {
      if (e instanceof BrokerError && e.code === "UNKNOWN_STATE") {
        // Never retry: block all new orders until reconciliation resolves this one.
        this.status.unknownOrders.push(order.clientOrderId);
        return { accepted: false, reasons: [`order outcome UNKNOWN: ${e.message}`] };
      }
      if (e instanceof BrokerError && (e.code === "AUTH" || e.code === "IP_NOT_WHITELISTED")) {
        this.status.brokerSessionValid = false;
      }
      return { accepted: false, reasons: [e instanceof Error ? e.message : String(e)] };
    }
  }

  /**
   * Rate limit: new entries fail fast; PROTECTIVE actions (stops, exits, cancels) wait up to 3s
   * for capacity — protecting a position must not fail just because of a burst.
   */
  private async acquire(protective: boolean): Promise<boolean> {
    if (this.limiter.tryAcquire()) return true;
    if (!protective) return false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (this.limiter.tryAcquire()) return true;
    }
    return false;
  }

  /** Modify a resting order (used to tighten stops). Protective gates only. */
  async modify(
    brokerOrderId: string,
    m: ModifyRequest,
    target?: BrokerTarget,
  ): Promise<{ ok: boolean; reason?: string }> {
    const reasons = this.protectiveBlockReasons(target);
    if (reasons.length) return { ok: false, reason: reasons.join("; ") };
    if (!(await this.acquire(true))) return { ok: false, reason: "gateway order rate limit" };
    try {
      await this.brokerFor(target).modifyOrder(brokerOrderId, m);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  async cancel(brokerOrderId: string, target?: BrokerTarget): Promise<{ ok: boolean; reason?: string }> {
    const reasons = this.protectiveBlockReasons(target);
    if (reasons.length) return { ok: false, reason: reasons.join("; ") };
    if (!(await this.acquire(true))) return { ok: false, reason: "gateway order rate limit" };
    try {
      await this.brokerFor(target).cancelOrder(brokerOrderId);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Resolve UNKNOWN orders against the broker order book (broker is the source of truth). */
  async reconcileUnknown(): Promise<{ resolved: string[]; stillUnknown: string[] }> {
    if (this.status.unknownOrders.length === 0) return { resolved: [], stillUnknown: [] };
    const broker = this.broker;
    const resolved: string[] = [];
    for (const id of [...this.status.unknownOrders]) {
      const match = await broker.findOrder(id).catch(() => undefined);
      if (match) {
        this.seen.set(id, match);
        resolved.push(id);
      }
    }
    this.status.unknownOrders = this.status.unknownOrders.filter((id) => !resolved.includes(id));
    return { resolved, stillUnknown: this.status.unknownOrders };
  }
}
