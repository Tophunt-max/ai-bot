"""FastAPI inference service. It receives features/candles and returns *advice*.
It never receives broker credentials and never places orders; the Worker/Gateway risk
engine is always the final authority."""

from __future__ import annotations

import hashlib
import hmac
import os
import time
from typing import Any, Literal

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .meta import MetaService
from .models import MODEL_VERSION, detect_regime, estimate_risk, generate_signal
from .schemas import CandleSeries, RegimeResponse, RiskEstimate, SignalResponse

app = FastAPI(title="ATB AI Service", version="0.1.0", docs_url=None, redoc_url=None)

REPLAY_WINDOW_MS = 30_000
meta_service = MetaService()

Mode = Literal["PAPER", "SHADOW", "CANARY", "LIVE"]


class MetaRequest(BaseModel):
    instrument_id: str = Field(max_length=64)
    side: Literal["BUY", "SELL"]
    strategies: list[str] = []
    regime: str = "UNKNOWN"
    features: dict[str, float]
    mode: Mode = "PAPER"


class DriftRequest(BaseModel):
    rows: list[dict[str, float]] = Field(max_length=10_000)
    mode: Mode = "PAPER"


class EvalRow(BaseModel):
    features: dict[str, float]
    side: Literal["BUY", "SELL"]
    label: int = Field(ge=0, le=1)


class EvaluateRequest(BaseModel):
    rows: list[EvalRow] = Field(min_length=1, max_length=10_000)
    mode: Mode = "PAPER"


async def verify_signature(
    request: Request,
    x_atb_timestamp: str | None = Header(default=None),
    x_atb_signature: str | None = Header(default=None),
) -> None:
    """Same HMAC scheme as Worker<->Gateway: HMAC(secret, f"{ts}.{METHOD}.{path}.{body}")."""
    secret = os.environ.get("AI_SERVICE_SECRET", "")
    if len(secret) < 32:
        raise HTTPException(status_code=503, detail="AI_SERVICE_SECRET not configured")
    if not x_atb_timestamp or not x_atb_signature:
        raise HTTPException(status_code=401, detail="missing signature")
    try:
        ts = int(x_atb_timestamp)
    except ValueError as e:
        raise HTTPException(status_code=401, detail="bad timestamp") from e
    if abs(int(time.time() * 1000) - ts) > REPLAY_WINDOW_MS:
        raise HTTPException(status_code=401, detail="stale signature")
    body = (await request.body()).decode()
    msg = f"{ts}.{request.method.upper()}.{request.url.path}.{body}".encode()
    expected = hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, x_atb_signature):
        raise HTTPException(status_code=401, detail="invalid signature")


signed = [Depends(verify_signature)]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "model_version": MODEL_VERSION}


@app.get("/model/version", dependencies=signed)
def model_version(mode: str = "LIVE") -> dict[str, Any]:
    return {"baseline_model_version": MODEL_VERSION, "meta_model": meta_service.version(mode)}


@app.post("/predict/meta", dependencies=signed)
def predict_meta(req: MetaRequest) -> dict[str, Any]:
    """Probability that a rule-ensemble candidate reaches its target before its stop.
    null => no eligible model for this mode (gateway fails closed)."""
    return meta_service.predict(req.features, req.side, req.mode)


@app.post("/drift", dependencies=signed)
def drift(req: DriftRequest) -> dict[str, Any]:
    return meta_service.drift(req.rows, req.mode)


@app.post("/predict/regime", dependencies=signed)
def predict_regime(series: CandleSeries) -> RegimeResponse:
    return detect_regime(series)


@app.post("/predict/signal", dependencies=signed)
def predict_signal(series: CandleSeries) -> SignalResponse:
    return generate_signal(series)


@app.post("/predict/risk", dependencies=signed)
def predict_risk(series: CandleSeries) -> RiskEstimate:
    return estimate_risk(series)


@app.post("/evaluate/model", dependencies=signed)
def evaluate_model(req: EvaluateRequest) -> dict[str, Any]:
    """Score the eligible model on freshly labelled live/shadow outcomes (performance monitoring)."""
    probs, labels = [], []
    for row in req.rows:
        r = meta_service.predict(row.features, row.side, req.mode)
        if r["probability"] is None:
            raise HTTPException(status_code=409, detail=r["status"])
        probs.append(r["probability"])
        labels.append(row.label)
    y = np.array(labels)
    p = np.array(probs)
    out: dict[str, Any] = {
        "samples": len(y),
        "base_rate": float(y.mean()),
        "brier": float(np.mean((p - y) ** 2)),
    }
    if len(np.unique(y)) == 2:
        from sklearn.metrics import roc_auc_score

        out["auc"] = float(roc_auc_score(y, p))
        out["degraded"] = out["auc"] < 0.52
    return out
