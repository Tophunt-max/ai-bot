import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_ACCOUNT_MODE,
  type AccountId,
  type KillSwitchTrigger,
  type TradingMode,
} from "@atb/shared-types";
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
  account: AccountId;
  mode: TradingMode;
  status: "ACTIVE" | "LOCKED" | "DISABLED";
  tradingEnabled: boolean;
  killSwitch: KillSwitchState;
  lease?: ExecutionLease;
  updatedAt: number;
}

const defaultState = (account: AccountId): AccountState => ({
  account,
  mode: DEFAULT_ACCOUNT_MODE[account], // demo → PAPER, real → SAFE_MODE until explicitly moved to SHADOW
  status: "ACTIVE",
  tradingEnabled: false,
  killSwitch: { active: false },
  updatedAt: 0,
});

/**
 * Single source of truth for trading mode, kill switch and the execution lease that
 * guarantees only ONE gateway node (Azure primary or DO secondary) can send orders.
 */
export class TradingAccountDO extends DurableObject<Env> {
  private async load(account: AccountId): Promise<AccountState> {
    const s = await this.ctx.storage.get<AccountState>("state");
    if (s && s.account !== account)
      throw new Error(`account mismatch: DO holds ${s.account}, asked ${account}`);
    return s ?? defaultState(account);
  }
  private async save(s: AccountState): Promise<AccountState> {
    s.updatedAt = Date.now();
    await this.ctx.storage.put("state", s);
    return s;
  }

  async getState(account: AccountId): Promise<AccountState> {
    return this.load(account);
  }

  /** Returns `{ rejected }` instead of throwing: custom error classes do not survive DO RPC. */
  async setMode(
    account: AccountId,
    to: TradingMode,
    confirmation?: string,
  ): Promise<AccountState | { rejected: string }> {
    const s = await this.load(account);
    try {
      checkModeChange(this.env.ENVIRONMENT, s, to, confirmation, account);
    } catch (e) {
      if (e instanceof ModeChangeError) return { rejected: e.message };
      throw e;
    }
    s.mode = to;
    if (to === "SAFE_MODE") s.tradingEnabled = false;
    return this.save(s);
  }

  async setTradingEnabled(
    account: AccountId,
    enabled: boolean,
  ): Promise<AccountState | { rejected: string }> {
    const s = await this.load(account);
    if (enabled && (s.killSwitch.active || s.mode === "SAFE_MODE")) {
      return { rejected: "cannot enable trading while kill switch / SAFE_MODE is active" };
    }
    s.tradingEnabled = enabled;
    return this.save(s);
  }

  /** Activation is immediate and forces SAFE_MODE. Deactivation does NOT leave SAFE_MODE by itself. */
  async setKillSwitch(
    account: AccountId,
    active: boolean,
    trigger: KillSwitchTrigger,
    reason: string,
  ): Promise<AccountState> {
    const s = await this.load(account);
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
  async acquireLease(
    account: AccountId,
    nodeId: string,
    ttlMs = 15_000,
  ): Promise<{ granted: boolean; lease?: ExecutionLease }> {
    const s = await this.load(account);
    const now = Date.now();
    if (!s.lease || s.lease.expiresAt < now || s.lease.nodeId === nodeId) {
      s.lease = { nodeId, expiresAt: now + Math.min(ttlMs, 60_000) };
      await this.save(s);
      return { granted: true, lease: s.lease };
    }
    return { granted: false, lease: s.lease };
  }

  async releaseLease(account: AccountId, nodeId: string): Promise<void> {
    const s = await this.load(account);
    if (s.lease?.nodeId === nodeId) {
      s.lease = undefined;
      await this.save(s);
    }
  }
}
