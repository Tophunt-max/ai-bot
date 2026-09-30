from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

Regime = Literal[
    "STRONG_BULL",
    "WEAK_BULL",
    "STRONG_BEAR",
    "WEAK_BEAR",
    "SIDEWAYS",
    "HIGH_VOLATILITY",
    "LOW_VOLATILITY",
    "ABNORMAL",
    "UNKNOWN",
]
Decision = Literal["BUY", "SELL", "WAIT", "NO_TRADE", "EXIT", "REDUCE"]


class Candle(BaseModel):
    t: int = Field(description="candle open time, epoch ms")
    o: float = Field(gt=0)
    h: float = Field(gt=0)
    l: float = Field(gt=0)  # noqa: E741
    c: float = Field(gt=0)
    v: float = Field(ge=0)

    @model_validator(mode="after")
    def valid_ohlc(self) -> Candle:
        if not (self.l <= min(self.o, self.c) and self.h >= max(self.o, self.c) and self.l <= self.h):
            raise ValueError(f"invalid OHLC at t={self.t}")
        return self


class CandleSeries(BaseModel):
    instrument_id: str = Field(min_length=3, max_length=64)
    timeframe: Literal["1m", "5m", "15m", "75m", "1h", "1d"]
    candles: list[Candle] = Field(min_length=1, max_length=5000)
    as_of: int = Field(description="decision time, epoch ms; candles after this are rejected (no look-ahead)")

    @model_validator(mode="after")
    def ordered_no_lookahead(self) -> CandleSeries:
        ts = [c.t for c in self.candles]
        if any(b <= a for a, b in zip(ts, ts[1:], strict=False)):
            raise ValueError("candles must be strictly increasing (no duplicates)")
        if ts[-1] > self.as_of:
            raise ValueError("look-ahead: candle newer than as_of")
        return self


class RegimeResponse(BaseModel):
    regime: Regime
    trend_strength: float
    realized_vol: float
    model_version: str
    reasons: dict[str, str]


class SignalResponse(BaseModel):
    decision: Decision
    quality: float = Field(ge=0, le=1, description="relative setup quality; NOT a probability of profit")
    regime: Regime
    entry: float | None = None
    stop: float | None = None
    targets: list[float] = []
    model_version: str
    reasons: dict[str, str]


class RiskEstimate(BaseModel):
    atr: float
    atr_pct: float
    suggested_stop_distance: float
    model_version: str
