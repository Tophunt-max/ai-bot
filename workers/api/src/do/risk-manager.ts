import { DurableObject } from "cloudflare:workers";
import type { KillSwitchTrigger, RiskLimits, RiskState } from "@atb/shared-types";
import { DEFAULT_LIMITS } from "@atb/trading-core";
import { riskLimitsSchema } from "@atb/validation";
import type { Env } from "../env";

interface Stored {
  limits: RiskLimits;
  state: RiskState;
  lastDailyReset?: string; // IST date
  lastWeeklyReset?: string;
}

const initial = (): Stored => ({
  limits: DEFAULT_LIMITS,
  state: {
    equity: 0,
    peakEquity: 0,
    dailyRealisedPnl: 0,
    weeklyRealisedPnl: 0,
    openRisk: 0,
    openPositions: 0,
    // Fail closed: locked until the gateway reports a verified equity snapshot.
    tradingLocked: true,
    lockReason: "AWAITING_FIRST_RECONCILIATION",
    updatedAt: 0,
  },
});

/** Daily/weekly risk counters, drawdown and the trading lock. AI can never write here. */
export class RiskManagerDO extends DurableObject<Env> {
  private async load(): Promise<Stored> {
    return (await this.ctx.storage.get<Stored>("risk")) ?? initial();
  }
  private async save(s: Stored): Promise<Stored> {
    s.state.updatedAt = Date.now();
    await this.ctx.storage.put("risk", s);
    return s;
  }

  async getSnapshot(): Promise<Stored> {
    return this.load();
  }

  async updateLimits(limits: RiskLimits): Promise<Stored> {
    const parsed = riskLimitsSchema.parse(limits);
    const s = await this.load();
    s.limits = parsed;
    return this.save(s);
  }

  /** Called by the gateway after reconciliation with the broker (the broker is the truth). */
  async applyReconciliation(snapshot: {
    equity: number;
    dailyRealisedPnl: number;
    weeklyRealisedPnl: number;
    openRisk: number;
    openPositions: number;
  }): Promise<Stored> {
    const s = await this.load();
    const st = s.state;
    Object.assign(st, snapshot);
    st.peakEquity = Math.max(st.peakEquity, snapshot.equity);
    if (st.lockReason === "AWAITING_FIRST_RECONCILIATION") {
      st.tradingLocked = false;
      st.lockReason = undefined;
    }
    const lossPct = st.equity > 0 ? (Math.max(0, -st.dailyRealisedPnl) / st.equity) * 100 : 100;
    const ddPct = st.peakEquity > 0 ? ((st.peakEquity - st.equity) / st.peakEquity) * 100 : 100;
    if (lossPct >= s.limits.maxDailyLossPct) this.lockState(st, "EXCESSIVE_LOSS");
    if (ddPct >= s.limits.maxDrawdownPct) this.lockState(st, "EXCESSIVE_LOSS");
    return this.save(s);
  }

  private lockState(st: RiskState, reason: KillSwitchTrigger | string) {
    st.tradingLocked = true;
    st.lockReason = reason;
  }

  async lock(reason: KillSwitchTrigger | string): Promise<Stored> {
    const s = await this.load();
    this.lockState(s.state, reason);
    return this.save(s);
  }

  async unlock(): Promise<Stored> {
    const s = await this.load();
    s.state.tradingLocked = false;
    s.state.lockReason = undefined;
    return this.save(s);
  }

  /** Idempotent: running twice for the same IST date is a no-op. Does NOT unlock trading. */
  async dailyReset(istDate: string, isMonday: boolean): Promise<{ reset: boolean }> {
    const s = await this.load();
    if (s.lastDailyReset === istDate) return { reset: false };
    s.state.dailyRealisedPnl = 0;
    s.lastDailyReset = istDate;
    if (isMonday && s.lastWeeklyReset !== istDate) {
      s.state.weeklyRealisedPnl = 0;
      s.lastWeeklyReset = istDate;
    }
    await this.save(s);
    return { reset: true };
  }
}
