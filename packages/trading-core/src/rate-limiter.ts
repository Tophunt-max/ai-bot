/** Sliding-window limiter used before every broker order call (place/modify/cancel). */
export class SlidingWindowLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryAcquire(): boolean {
    const t = this.now();
    while (this.hits.length > 0 && t - this.hits[0]! >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(t);
    return true;
  }
}
