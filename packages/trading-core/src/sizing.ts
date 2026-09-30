export interface SizingInput {
  equity: number;
  riskPct: number; // % of equity risked if stop is hit
  entry: number;
  stop: number;
  lotSize: number;
  maxPositionValue: number; // account/config cap, INR
  availableMargin: number;
  marginPerUnit: number; // INR of margin required per unit (1 share / 1 qty of contract)
  maxExposureValue: number; // remaining symbol/correlated exposure headroom, INR
  brokerMaxQuantity?: number; // e.g. freeze quantity or broker cap
}

export interface SizingResult {
  quantity: number;
  lots: number;
  riskAmount: number;
  stopDistance: number;
  limitedBy: "RISK" | "POSITION_VALUE" | "MARGIN" | "EXPOSURE" | "BROKER" | "INVALID";
}

/**
 * quantity = MIN(risk-based, position-value cap, margin cap, exposure cap, broker cap),
 * rounded DOWN to whole lots. Returns 0 when inputs are invalid — never guesses.
 */
export function calculatePositionSize(i: SizingInput): SizingResult {
  const stopDistance = Math.abs(i.entry - i.stop);
  const riskAmount = (i.equity * i.riskPct) / 100;
  const invalid =
    !(i.equity > 0) ||
    !(i.riskPct > 0) ||
    !(i.entry > 0) ||
    !(stopDistance > 0) ||
    !(i.lotSize > 0) ||
    !(i.marginPerUnit > 0);
  if (invalid) return { quantity: 0, lots: 0, riskAmount: 0, stopDistance, limitedBy: "INVALID" };

  const caps: Array<[SizingResult["limitedBy"], number]> = [
    ["RISK", riskAmount / stopDistance],
    ["POSITION_VALUE", i.maxPositionValue / i.entry],
    ["MARGIN", i.availableMargin / i.marginPerUnit],
    ["EXPOSURE", i.maxExposureValue / i.entry],
  ];
  if (i.brokerMaxQuantity !== undefined) caps.push(["BROKER", i.brokerMaxQuantity]);

  let [limitedBy, units] = caps[0]!;
  for (const [name, value] of caps) {
    if (value < units) {
      units = value;
      limitedBy = name;
    }
  }

  const lots = Math.max(0, Math.floor(units / i.lotSize));
  return { quantity: lots * i.lotSize, lots, riskAmount, stopDistance, limitedBy };
}
