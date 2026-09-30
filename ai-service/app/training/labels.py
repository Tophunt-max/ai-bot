"""Triple-barrier labelling (López de Prado) for META-LABELS.

A candidate trade from the rule ensemble is labelled 1 if its profit target is touched before
its stop within `max_bars`, else 0. Conventions match the TypeScript trade manager:
entry at the NEXT bar's open, gap through stop fills at the open, and if one bar touches both
barriers the STOP is assumed first (pessimistic).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class BarrierResult:
    label: int  # 1 = target first, 0 = stop first / timeout
    r_multiple: float  # realised R (before costs) at the exit
    exit_index: int  # bar index where the outcome was decided
    touched: str  # "TARGET" | "STOP" | "TIMEOUT" | "NO_DATA"


def triple_barrier(
    o: NDArray[np.float64],
    h: NDArray[np.float64],
    l: NDArray[np.float64],  # noqa: E741
    c: NDArray[np.float64],
    signal_index: int,
    side: int,  # +1 long, -1 short
    stop: float,
    target: float,
    max_bars: int,
) -> BarrierResult:
    n = len(c)
    entry_i = signal_index + 1
    if entry_i >= n:
        return BarrierResult(0, 0.0, signal_index, "NO_DATA")
    entry = float(o[entry_i])
    risk = side * (entry - stop)
    if risk <= 0:  # gap already beyond stop: the trade would be stopped immediately
        return BarrierResult(0, -1.0, entry_i, "STOP")
    last = min(n - 1, entry_i + max_bars - 1)
    for j in range(entry_i, last + 1):
        if j > entry_i and side * (o[j] - stop) <= 0:
            return BarrierResult(0, side * (o[j] - entry) / risk, j, "STOP")
        stop_hit = l[j] <= stop if side > 0 else h[j] >= stop
        target_hit = h[j] >= target if side > 0 else l[j] <= target
        if stop_hit:
            return BarrierResult(0, -1.0, j, "STOP")
        if target_hit:
            return BarrierResult(1, side * (target - entry) / risk, j, "TARGET")
    return BarrierResult(0, side * (c[last] - entry) / risk, last, "TIMEOUT")
