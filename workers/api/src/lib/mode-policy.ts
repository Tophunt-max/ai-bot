import { ALLOWED_MODES, type Environment, type TradingMode } from "@atb/shared-types";

export class ModeChangeError extends Error {}

export interface ModeState {
  mode: TradingMode;
  killSwitch: { active: boolean };
}

/**
 * Mode-transition policy (pure, unit tested).
 * - Environment gating: dev = PAPER only, staging = +SHADOW, production = all.
 * - Kill switch active => only SAFE_MODE.
 * - CANARY/LIVE need an explicit typed confirmation.
 * - LIVE only from CANARY (Paper -> Shadow -> Canary -> Live).
 */
export function checkModeChange(
  env: Environment,
  current: ModeState,
  to: TradingMode,
  confirmation?: string,
): void {
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
