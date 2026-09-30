import {
  ACCOUNT_ALLOWED_MODES,
  ALLOWED_MODES,
  type AccountId,
  type Environment,
  type TradingMode,
} from "@atb/shared-types";

export class ModeChangeError extends Error {}

export interface ModeState {
  mode: TradingMode;
  killSwitch: { active: boolean };
}

/**
 * Mode-transition policy (pure, unit tested).
 * - Account gating: DEMO = PAPER only (virtual money, can never reach a real broker);
 *   REAL = SHADOW → CANARY → LIVE.
 * - Environment gating: dev = PAPER only, staging = +SHADOW, production = all.
 * - Kill switch active => only SAFE_MODE.
 * - CANARY/LIVE need an explicit typed confirmation; LIVE only from CANARY.
 */
export function checkModeChange(
  env: Environment,
  current: ModeState,
  to: TradingMode,
  confirmation?: string,
  account: AccountId = "real",
): void {
  if (!ACCOUNT_ALLOWED_MODES[account].includes(to)) {
    throw new ModeChangeError(`${to} is not allowed for the ${account.toUpperCase()} account`);
  }
  if (!ALLOWED_MODES[env].includes(to)) throw new ModeChangeError(`${to} not allowed in ${env}`);
  if (current.killSwitch.active && to !== "SAFE_MODE") {
    throw new ModeChangeError("kill switch active — only SAFE_MODE allowed");
  }
  if ((to === "LIVE" || to === "CANARY") && confirmation !== `ENABLE ${to}`) {
    throw new ModeChangeError(`type "ENABLE ${to}" to confirm`);
  }
  if (to === "LIVE" && current.mode !== "CANARY") {
    throw new ModeChangeError("LIVE can only be activated from CANARY");
  }
}
