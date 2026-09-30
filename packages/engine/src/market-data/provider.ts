import type { Candle, Quote, Tick, Timeframe } from "@atb/shared-types";

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "75m": 4_500_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

export interface MarketDataProvider {
  readonly id: string;
  getQuote(instrumentId: string): Promise<Quote>;
  getOHLCV(instrumentId: string, timeframe: Timeframe, from?: number, to?: number): Promise<Candle[]>;
  subscribe(instrumentIds: readonly string[], signal?: AbortSignal): AsyncIterable<Tick>;
}

/** Source of LTPs for polling (implemented by broker adapters that expose a quote API). */
export interface LtpSource {
  getLtp(instrumentIds: readonly string[]): Promise<Record<string, number>>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Polling market-data provider over a broker LTP endpoint. Simple and robust; adequate for
 * 5m/15m strategies. (A broker WebSocket provider can replace it without touching the engine.)
 */
export class PollingProvider implements MarketDataProvider {
  readonly id: string;
  private readonly last = new Map<string, Quote>();

  constructor(
    private readonly source: LtpSource,
    private readonly intervalMs = 1000,
    private readonly history?: (id: string, tf: Timeframe, from?: number, to?: number) => Promise<Candle[]>,
    private readonly now: () => number = Date.now,
  ) {
    this.id = "polling";
  }

  async getQuote(instrumentId: string): Promise<Quote> {
    const q = this.last.get(instrumentId);
    if (q) return q;
    const r = await this.source.getLtp([instrumentId]);
    const ltp = r[instrumentId];
    if (!(ltp && ltp > 0)) throw new Error(`no quote for ${instrumentId}`);
    const quote = { instrumentId, ltp, timestamp: this.now() };
    this.last.set(instrumentId, quote);
    return quote;
  }

  async getOHLCV(instrumentId: string, timeframe: Timeframe, from?: number, to?: number): Promise<Candle[]> {
    if (!this.history) throw new Error("history source not configured");
    return this.history(instrumentId, timeframe, from, to);
  }

  async *subscribe(instrumentIds: readonly string[], signal?: AbortSignal): AsyncIterable<Tick> {
    while (!signal?.aborted) {
      try {
        const r = await this.source.getLtp(instrumentIds);
        const ts = this.now();
        for (const id of instrumentIds) {
          const ltp = r[id];
          if (!(ltp && ltp > 0)) continue;
          this.last.set(id, { instrumentId: id, ltp, timestamp: ts });
          yield { instrumentId: id, ltp, timestamp: ts };
        }
      } catch {
        // Feed error: emit nothing; quotes go stale and the risk gate blocks new trades.
      }
      await sleep(this.intervalMs, signal);
    }
  }
}

/** Replays stored candles as a provider (backtests, paper-on-history, tests). */
export class ReplayProvider implements MarketDataProvider {
  readonly id = "replay";
  constructor(private readonly data: Record<string, Candle[]>) {}

  async getQuote(instrumentId: string): Promise<Quote> {
    const c = this.data[instrumentId]?.at(-1);
    if (!c) throw new Error(`no data for ${instrumentId}`);
    return { instrumentId, ltp: c.c, timestamp: c.t };
  }

  async getOHLCV(instrumentId: string, _tf: Timeframe, from = -Infinity, to = Infinity): Promise<Candle[]> {
    return (this.data[instrumentId] ?? []).filter((c) => c.t >= from && c.t <= to);
  }

  async *subscribe(instrumentIds: readonly string[]): AsyncIterable<Tick> {
    for (const id of instrumentIds) {
      for (const c of this.data[id] ?? []) yield { instrumentId: id, ltp: c.c, timestamp: c.t, qty: c.v };
    }
  }
}

/** CSV: `timestamp,open,high,low,close,volume` (ISO or epoch ms). Header row optional. */
export function parseCandlesCsv(csv: string): Candle[] {
  const out: Candle[] = [];
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 5) continue;
    const [ts, o, h, l, c, v] = parts;
    const t = /^\d+$/.test(ts!) ? Number(ts) : Date.parse(ts!);
    const nums = [o, h, l, c].map(Number);
    if (!Number.isFinite(t) || nums.some((x) => !Number.isFinite(x))) continue; // header / junk
    out.push({ t, o: nums[0]!, h: nums[1]!, l: nums[2]!, c: nums[3]!, v: Number(v ?? 0) || 0 });
  }
  return out;
}

export function candlesToCsv(candles: readonly Candle[]): string {
  return [
    "timestamp,open,high,low,close,volume",
    ...candles.map((c) => `${new Date(c.t).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`),
  ].join("\n");
}
