"""Baseline models (Phase 1). Deterministic, transparent rules used as the benchmark
every ML model must beat out-of-sample before promotion. The signal model defaults to
NO_TRADE — real signals are introduced in Phase 6/10 behind the model registry."""

from __future__ import annotations

import math

import numpy as np

from .features import atr, ema, realized_vol, rsi
from .schemas import CandleSeries, RegimeResponse, RiskEstimate, SignalResponse

MODEL_VERSION = "baseline-0.1.0"
MIN_CANDLES = 60


def _arrays(s: CandleSeries):
    c = np.array([x.c for x in s.candles], dtype=np.float64)
    h = np.array([x.h for x in s.candles], dtype=np.float64)
    l = np.array([x.l for x in s.candles], dtype=np.float64)  # noqa: E741
    return h, l, c


def detect_regime(s: CandleSeries) -> RegimeResponse:
    if len(s.candles) < MIN_CANDLES:
        return RegimeResponse(
            regime="UNKNOWN",
            trend_strength=0.0,
            realized_vol=0.0,
            model_version=MODEL_VERSION,
            reasons={"data": f"need >= {MIN_CANDLES} candles, got {len(s.candles)}"},
        )
    h, l, c = _arrays(s)  # noqa: E741
    fast, slow = ema(c, 20), ema(c, 50)
    a = atr(h, l, c)[-1]
    trend_strength = float((fast[-1] - slow[-1]) / a) if a > 0 else 0.0
    vol = realized_vol(c)
    last_ret = abs(math.log(c[-1] / c[-2]))

    reasons = {
        "trend": f"(EMA20-EMA50)/ATR = {trend_strength:.2f}",
        "volatility": f"20-bar realized vol {vol:.4%}",
    }
    if not math.isfinite(vol) or last_ret > 8 * max(vol, 1e-9):
        regime = "ABNORMAL"
        reasons["abnormal"] = "last bar move > 8x realized vol"
    elif vol > 0.02:
        regime = "HIGH_VOLATILITY"
    elif trend_strength > 2:
        regime = "STRONG_BULL"
    elif trend_strength > 0.5:
        regime = "WEAK_BULL"
    elif trend_strength < -2:
        regime = "STRONG_BEAR"
    elif trend_strength < -0.5:
        regime = "WEAK_BEAR"
    elif vol < 0.002:
        regime = "LOW_VOLATILITY"
    else:
        regime = "SIDEWAYS"
    return RegimeResponse(
        regime=regime,
        trend_strength=trend_strength,
        realized_vol=vol,
        model_version=MODEL_VERSION,
        reasons=reasons,
    )


def generate_signal(s: CandleSeries) -> SignalResponse:
    reg = detect_regime(s)
    reasons = dict(reg.reasons)
    if reg.regime in ("UNKNOWN", "ABNORMAL", "HIGH_VOLATILITY"):
        reasons["decision"] = f"regime {reg.regime}: stand aside"
        return SignalResponse(
            decision="NO_TRADE", quality=0.0, regime=reg.regime, model_version=MODEL_VERSION, reasons=reasons
        )
    _, _, c = _arrays(s)
    r = float(rsi(c)[-1])
    reasons["momentum"] = f"RSI14 {r:.1f}"
    reasons["decision"] = "baseline model is observation-only in Phase 1"
    return SignalResponse(
        decision="NO_TRADE", quality=0.0, regime=reg.regime, model_version=MODEL_VERSION, reasons=reasons
    )


def estimate_risk(s: CandleSeries, atr_multiple: float = 1.5) -> RiskEstimate:
    h, l, c = _arrays(s)  # noqa: E741
    a = float(atr(h, l, c)[-1])
    return RiskEstimate(
        atr=a, atr_pct=a / float(c[-1]), suggested_stop_distance=a * atr_multiple, model_version=MODEL_VERSION
    )
