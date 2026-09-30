"""FastAPI inference service. It receives features/candles and returns *advice*.
It never receives broker credentials and never places orders; the Worker/Gateway risk
engine is always the final authority."""

from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Request

from .models import MODEL_VERSION, detect_regime, estimate_risk, generate_signal
from .schemas import CandleSeries, RegimeResponse, RiskEstimate, SignalResponse

app = FastAPI(title="ATB AI Service", version="0.1.0", docs_url=None, redoc_url=None)

REPLAY_WINDOW_MS = 30_000


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
def model_version() -> dict[str, str]:
    return {"model_version": MODEL_VERSION, "status": "PAPER", "features_version": "f-0.1.0"}


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
def evaluate_model() -> dict[str, str]:
    raise HTTPException(status_code=501, detail="model evaluation lands in Phase 17 (walk-forward pipeline)")
