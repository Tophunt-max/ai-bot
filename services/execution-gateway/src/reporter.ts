import type { TradingMode } from "@atb/shared-types";
import type { ControlPlane, GatewayEvent, GatewayEventType } from "./control-plane";

/**
 * Buffered, retrying event shipper (gateway → Worker → D1 / realtime / notifications).
 * Events carry an id so the Worker can ingest idempotently. Bounded: when the control plane is
 * unreachable for a long time the OLDEST events are dropped (trading state never depends on them).
 */
export class EventReporter {
  private readonly buf: GatewayEvent[] = [];
  private seq = 0;
  private flushing = false;
  dropped = 0;

  constructor(
    private readonly nodeId: string,
    private readonly cp: ControlPlane,
    private readonly max = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  push(type: GatewayEventType, mode: TradingMode, payload: Record<string, unknown>, id?: string): void {
    this.buf.push({
      id: id ?? `${this.nodeId}-${this.now()}-${++this.seq}`,
      type,
      at: this.now(),
      mode,
      payload,
    });
    while (this.buf.length > this.max) {
      this.buf.shift();
      this.dropped++;
    }
  }

  get pending(): number {
    return this.buf.length;
  }

  async flush(batch = 50): Promise<number> {
    if (this.flushing || !this.cp.postEvents || this.buf.length === 0) return 0;
    this.flushing = true;
    let sent = 0;
    try {
      while (this.buf.length) {
        const chunk = this.buf.slice(0, batch);
        await this.cp.postEvents(this.nodeId, chunk);
        this.buf.splice(0, chunk.length);
        sent += chunk.length;
      }
    } catch {
      // keep for retry
    } finally {
      this.flushing = false;
    }
    return sent;
  }
}
