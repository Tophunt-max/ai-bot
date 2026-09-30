"""Feature drift via Population Stability Index (PSI).

PSI < 0.1 stable, 0.1–0.25 moderate shift, > 0.25 significant shift (reduce risk / review model).
"""

from __future__ import annotations

import numpy as np


def quantile_edges(x: np.ndarray, bins: int = 10) -> list[float]:
    x = x[np.isfinite(x)]
    if len(x) == 0:
        return [0.0]
    edges = np.unique(np.quantile(x, np.linspace(0, 1, bins + 1)[1:-1]))
    return [float(e) for e in edges]


def bin_fractions(x: np.ndarray, edges: list[float]) -> list[float]:
    x = x[np.isfinite(x)]
    counts = np.bincount(np.searchsorted(edges, x, side="right"), minlength=len(edges) + 1)
    total = max(1, counts.sum())
    return [float(c) / total for c in counts]


def psi(expected: list[float], actual: list[float], eps: float = 1e-4) -> float:
    e = np.clip(np.asarray(expected, dtype=float), eps, None)
    a = np.clip(np.asarray(actual, dtype=float), eps, None)
    return float(np.sum((a - e) * np.log(a / e)))


def drift_status(value: float) -> str:
    return "STABLE" if value < 0.1 else "MODERATE" if value < 0.25 else "SIGNIFICANT"
