import type { ModelStatus } from "@atb/shared-types";

const LADDER: ModelStatus[] = ["DRAFT", "VALIDATING", "PAPER", "SHADOW", "CANARY", "PRODUCTION"];

/**
 * Model promotion policy: one step at a time up the ladder, never skipping (so a new model can
 * NEVER jump straight to PRODUCTION), demotion to an earlier stage allowed, RETIRED from anywhere.
 * Returns an error message, or null if allowed.
 */
export function checkModelTransition(from: ModelStatus, to: ModelStatus): string | null {
  if (from === to) return `already ${to}`;
  if (from === "RETIRED") return "retired models cannot be reactivated; register a new version";
  if (to === "RETIRED") return null;
  const a = LADDER.indexOf(from);
  const b = LADDER.indexOf(to);
  if (b < a) return null; // demotion (e.g. drift detected)
  if (b !== a + 1) return `must promote one stage at a time: ${from} → ${LADDER[a + 1]}`;
  return null;
}
