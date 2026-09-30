import hashlib
import hmac
import json
import math
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app

SECRET = "s" * 40


@pytest.fixture(autouse=True)
def _secret(monkeypatch):
    monkeypatch.setenv("AI_SERVICE_SECRET", SECRET)


client = TestClient(app)


def signed_post(path: str, payload: dict, ts: int | None = None):
    body = json.dumps(payload)
    ts = ts or int(time.time() * 1000)
    sig = hmac.new(SECRET.encode(), f"{ts}.POST.{path}.{body}".encode(), hashlib.sha256).hexdigest()
    return client.post(
        path,
        content=body,
        headers={"X-ATB-Timestamp": str(ts), "X-ATB-Signature": sig, "Content-Type": "application/json"},
    )


def candles(n: int, drift: float = 0.001, start: float = 100.0):
    out, px = [], start
    for i in range(n):
        o = px
        px = px * math.exp(drift + 0.002 * math.sin(i))
        out.append(
            {
                "t": 1_700_000_000_000 + i * 300_000,
                "o": o,
                "h": max(o, px) * 1.001,
                "l": min(o, px) * 0.999,
                "c": px,
                "v": 1000,
            }
        )
    return out


def series(cs, as_of=None):
    return {"instrument_id": "NSE:INFY", "timeframe": "5m", "candles": cs, "as_of": as_of or cs[-1]["t"]}


def test_health_is_public():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_rejects_unsigned_and_stale_requests():
    assert client.post("/predict/regime", json=series(candles(80))).status_code == 401
    old = int(time.time() * 1000) - 120_000
    assert signed_post("/predict/regime", series(candles(80)), ts=old).status_code == 401


def test_regime_uptrend():
    r = signed_post("/predict/regime", series(candles(120, drift=0.002)))
    assert r.status_code == 200
    assert r.json()["regime"] in ("STRONG_BULL", "WEAK_BULL")


def test_insufficient_data_is_unknown_and_no_trade():
    r = signed_post("/predict/signal", series(candles(10)))
    assert r.status_code == 200
    b = r.json()
    assert b["regime"] == "UNKNOWN"
    assert b["decision"] == "NO_TRADE"


def test_rejects_look_ahead_and_duplicates():
    cs = candles(80)
    assert signed_post("/predict/regime", series(cs, as_of=cs[-2]["t"])).status_code == 422
    cs[5]["t"] = cs[4]["t"]
    assert signed_post("/predict/regime", series(cs)).status_code == 422


def test_rejects_invalid_ohlc():
    cs = candles(80)
    cs[10]["h"] = cs[10]["l"] * 0.5
    assert signed_post("/predict/regime", series(cs)).status_code == 422


def test_risk_estimate():
    r = signed_post("/predict/risk", series(candles(80)))
    assert r.status_code == 200
    assert r.json()["atr"] > 0
