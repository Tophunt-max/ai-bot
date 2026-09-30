import { DurableObject } from "cloudflare:workers";
import type { KillSwitchTrigger, TradingMode } from "@atb/shared-types";
import type { Env } from "../env";
import { ModeChangeError, checkModeChange } from "../lib/mode-policy";

export interface KillSwitchState {
  active: boolean;
  trigger?: KillSwitchTrigger;
  reason?: string;
  at?: number;
}

export interface ExecutionLease {
  nodeId: string;
  expiresAt: number;
}

export interface AccountState {
  mode: TradingMode;
  status: "ACTIVE" | "LOCKED" | "DISABLED";
  tradingEnabled: boolean;
  killSwitch: KillSwitchState;
  lease?: ExecutionLease;
  updatedAt: number;
}

const DEFAULT_STATE: AccountState = {
  mode: "PAPER",
  status: "ACTIVE",
  tradingEnabled: false,
  killSwitch: { active: false },
  updatedAt: 0,
};

/**
 * Single source of truth for trading mode, kill switch and the execution lease that
 * guarantees only ONE gateway node (Azure primary or DO secondary) can send orders.
 */
export class TradingAccountDO extends DurableObject<Env> {
  private async load(): Promise<AccountState> {
    return (await this.ctx.storage.get<AccountState>("state")) ?? { ...DEFAULT_STATE };
  }
  private async save(s: AccountState): Promise<AccountState> {
    s.updatedAt = Date.now();
    await this.ctx.storage.put("state", s);
    return s;
  }

  async getState(): Promise<AccountState> {
    return this.load();
  }

  async setMode(to: TradingMode, confirmation?: string): Promise<AccountState> {
    const s = await this.load();
    checkModeChange(this.env.ENVIRONMENT, s, to, confirmation);
    s.mode = to;
    if (to === "SAFE_MODE") s.tradingEnabled = false;
    return this.save(s);
  }

  async setTradingEnabled(enabled: boolean): Promise<AccountState> {
    const s = await this.load();
    if (enabled && (s.killSwitch.active || s.mode === "SAFE_MODE")) {
      throw new ModeChangeError("cannot enable trading while kill switch / SAFE_MODE is active");
    }
    s.tradingEnabled = enabled;
    return this.save(s);
  }

  /** Activation is immediate and forces SAFE_MODE. Deactivation does NOT leave SAFE_MODE by itself. */
  async setKillSwitch(active: boolean, trigger: KillSwitchTrigger, reason: string): Promise<AccountState> {
    const s = await this.load();
    s.killSwitch = active
      ? { active, trigger, reason, at: Date.now() }
      : { active: false, reason, at: Date.now() };
    if (active) {
      s.mode = "SAFE_MODE";
      s.tradingEnabled = false;
    }
    return this.save(s);
  }

  /** Gateway heartbeat: acquire/renew the single-writer execution lease. */
  async acquireLease(nodeId: string, ttlMs = 15_000): Promise<{ granted: boolean; lease?: ExecutionLease }> {
    const s = await this.load();
    const now = Date.now();
    if (!s.lease || s.lease.expiresAt < now || s.lease.nodeId === nodeId) {
      s.lease = { nodeId, expiresAt: now + Math.min(ttlMs, 60_000) };
      await this.save(s);
      return { granted: true, lease: s.lease };
    }
    return { granted: false, lease: s.lease };
  }

  async releaseLease(nodeId: string): Promise<void> {
    const s = await this.load();
    if (s.lease?.nodeId === nodeId) {
      s.lease = undefined;
      await this.save(s);
    }
  }
}
