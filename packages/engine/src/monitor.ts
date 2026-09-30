/**
 * Live performance / drift monitor. It can only REDUCE risk or DISABLE trading — never increase
 * risk beyond the configured limits and never deploy anything.
 */
export interface MonitorConfig {
  window: number; // trades considered
  minTrades: number; // before any judgement
  reduceBelowR: number; // rolling expectancy (R) that halves risk
  disableBelowR: number; // rolling expectancy (R) that disables new entries
  maxConsecutiveLosses: number;
}

export const DEFAULT_MONITOR: MonitorConfig = {
  window: 30,
  minTrades: 10,
  reduceBelowR: -0.2,
  disableBelowR: -0.5,
  maxConsecutiveLosses: 8,
};

export type MonitorState = "NORMAL" | "REDUCED" | "DISABLED";

export class PerformanceMonitor {
  private readonly r: number[] = [];
  private consecutiveLosses = 0;
  constructor(private readonly cfg: MonitorConfig = DEFAULT_MONITOR) {}

  record(rMultiple: number): void {
    if (!Number.isFinite(rMultiple)) return;
    this.r.push(rMultiple);
    if (this.r.length > this.cfg.window) this.r.shift();
    this.consecutiveLosses = rMultiple <= 0 ? this.consecutiveLosses + 1 : 0;
  }

  get rollingExpectancy(): number {
    return this.r.length ? this.r.reduce((a, b) => a + b, 0) / this.r.length : 0;
  }

  get state(): MonitorState {
    if (this.consecutiveLosses >= this.cfg.maxConsecutiveLosses) return "DISABLED";
    if (this.r.length < this.cfg.minTrades) return "NORMAL";
    const e = this.rollingExpectancy;
    if (e < this.cfg.disableBelowR) return "DISABLED";
    if (e < this.cfg.reduceBelowR) return "REDUCED";
    return "NORMAL";
  }

  /** Multiplier applied to risk-per-trade (1, 0.5 or 0). */
  get riskMultiplier(): number {
    const s = this.state;
    return s === "NORMAL" ? 1 : s === "REDUCED" ? 0.5 : 0;
  }

  snapshot() {
    return {
      trades: this.r.length,
      rollingExpectancyR: this.rollingExpectancy,
      consecutiveLosses: this.consecutiveLosses,
      state: this.state,
      riskMultiplier: this.riskMultiplier,
    };
  }

  restore(rs: number[], consecutiveLosses: number): void {
    this.r.splice(0, this.r.length, ...rs.slice(-this.cfg.window));
    this.consecutiveLosses = consecutiveLosses;
  }

  history(): { r: number[]; consecutiveLosses: number } {
    return { r: [...this.r], consecutiveLosses: this.consecutiveLosses };
  }
}
