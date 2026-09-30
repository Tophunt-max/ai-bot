"""Causal feature functions. Every value at index i uses data <= i only (no look-ahead)."""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

Arr = NDArray[np.float64]


def ema(x: Arr, span: int) -> Arr:
    alpha = 2.0 / (span + 1)
    out = np.empty_like(x)
    out[0] = x[0]
    for i in range(1, len(x)):
        out[i] = alpha * x[i] + (1 - alpha) * out[i - 1]
    return out


def true_range(h: Arr, l: Arr, c: Arr) -> Arr:  # noqa: E741
    prev_c = np.concatenate([[c[0]], c[:-1]])
    return np.maximum.reduce([h - l, np.abs(h - prev_c), np.abs(l - prev_c)])


def atr(h: Arr, l: Arr, c: Arr, period: int = 14) -> Arr:  # noqa: E741
    tr = true_range(h, l, c)
    out = np.empty_like(tr)
    out[0] = tr[0]
    for i in range(1, len(tr)):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def log_returns(c: Arr) -> Arr:
    r = np.zeros_like(c)
    r[1:] = np.log(c[1:] / c[:-1])
    return r


def realized_vol(c: Arr, window: int = 20) -> float:
    r = log_returns(c)[-window:]
    return float(np.std(r, ddof=1)) if len(r) > 2 else float("nan")


def rsi(c: Arr, period: int = 14) -> Arr:
    d = np.diff(c, prepend=c[0])
    up, dn = np.clip(d, 0, None), np.clip(-d, 0, None)
    au, ad = ema(up, 2 * period - 1), ema(dn, 2 * period - 1)
    rs = np.divide(au, ad, out=np.full_like(au, np.inf), where=ad > 0)
    return 100 - 100 / (1 + rs)
