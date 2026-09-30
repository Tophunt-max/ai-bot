import csv
import hashlib
import hmac
import json
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.drift import bin_fractions, psi, quantile_edges
from app.registry import load_registry, set_status
from app.training.cv import purged_walk_forward
from app.training.labels import triple_barrier
from app.training.train_meta import train

SECRET = "s" * 40


def arr(*x):
    return np.array(x, dtype=float)


class TestTripleBarrier:
    def test_target_first(self):
        o, h, l, c = arr(100, 100, 101), arr(100, 101, 104), arr(100, 99.5, 100.5), arr(100, 100.8, 103)
        r = triple_barrier(o, h, l, c, 0, +1, stop=98, target=103, max_bars=5)
        assert (r.label, r.touched, r.exit_index) == (1, "TARGET", 2)
        assert r.r_multiple == pytest.approx(1.5)

    def test_stop_first_when_bar_touches_both(self):
        o, h, l, c = arr(100, 100), arr(100, 104), arr(100, 97), arr(100, 101)
        r = triple_barrier(o, h, l, c, 0, +1, stop=98, target=103, max_bars=5)
        assert (r.label, r.touched) == (0, "STOP")

    def test_gap_through_stop_fills_at_open(self):
        o, h, l, c = arr(100, 100, 95), arr(100, 100.5, 96), arr(100, 99.5, 94), arr(100, 100, 95)
        r = triple_barrier(o, h, l, c, 0, +1, stop=98, target=103, max_bars=5)
        assert r.touched == "STOP" and r.r_multiple == pytest.approx(-2.5)

    def test_short_and_timeout(self):
        o, h, l, c = arr(100, 100, 100), arr(100, 100.5, 100.5), arr(100, 99.5, 99.5), arr(100, 99.8, 99.6)
        r = triple_barrier(o, h, l, c, 0, -1, stop=102, target=96, max_bars=2)
        assert (r.label, r.touched) == (0, "TIMEOUT")
        assert r.r_multiple == pytest.approx(0.2)


def test_purged_walk_forward_has_no_label_overlap():
    rng = np.random.default_rng(0)
    start = np.sort(rng.integers(0, 10_000, 500)).astype(np.int64)
    end = start + rng.integers(1, 200, 500)
    splits = list(purged_walk_forward(start, end, n_splits=4, embargo=50))
    assert splits
    for tr, te in splits:
        assert end[tr].max() < start[te].min() - 50  # every training label resolved before test (+ embargo)
        assert set(tr).isdisjoint(set(te))


def test_psi_detects_shift():
    rng = np.random.default_rng(1)
    ref = rng.normal(0, 1, 5000)
    edges = quantile_edges(ref)
    base = bin_fractions(ref, edges)
    assert psi(base, bin_fractions(rng.normal(0, 1, 5000), edges)) < 0.1
    assert psi(base, bin_fractions(rng.normal(1.5, 1, 5000), edges)) > 0.25


def _write_dataset(root: Path, n_bars: int = 6000, informative: bool = True):
    """Synthetic candles + candidates where feature f_x genuinely predicts success."""
    rng = np.random.default_rng(7)
    t0 = 1_700_000_000_000
    px = 100.0
    candles, cands = [], []
    for i in range(n_bars):
        o = px
        px = o * (1 + rng.normal(0, 0.002))
        candles.append((t0 + i * 300_000, o, max(o, px) * 1.001, min(o, px) * 0.999, px, 1000))
    c = np.array([x[4] for x in candles])
    for i in range(50, n_bars - 40, 7):
        future = c[i + 1 : i + 20]
        up = future.max() > c[i] * 1.004
        x = (1.0 if up else -1.0) + rng.normal(0, 0.8) if informative else rng.normal(0, 1)
        cands.append(
            {
                "instrument_id": "NSE:T",
                "t": candles[i][0],
                "side": "BUY",
                "entry": c[i],
                "stop": c[i] * 0.996,
                "target": c[i] * 1.004,
                "max_bars": 20,
                "strategies": "X",
                "regime": "SIDEWAYS",
                "f_x": x,
                "f_noise": rng.normal(),
            }
        )
    (root / "candles").mkdir(parents=True)
    with (root / "candles" / "NSE_T.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
        w.writerows(candles)
    with (root / "candidates.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(cands[0].keys()))
        w.writeheader()
        w.writerows(cands)


def signed_post(client, path, payload):
    body = json.dumps(payload)
    ts = int(time.time() * 1000)
    sig = hmac.new(SECRET.encode(), f"{ts}.POST.{path}.{body}".encode(), hashlib.sha256).hexdigest()
    return client.post(
        path,
        content=body,
        headers={"X-ATB-Timestamp": str(ts), "X-ATB-Signature": sig, "Content-Type": "application/json"},
    )


def test_train_register_and_serve_by_mode(tmp_path, monkeypatch):
    _write_dataset(tmp_path / "ds")
    models = tmp_path / "models"
    entry = train(
        tmp_path / "ds" / "candidates.csv",
        tmp_path / "ds" / "candles",
        models,
        "meta-ensemble",
        n_splits=4,
        threshold=0.5,
    )
    oos = entry["out_of_sample_metrics"]
    assert entry["status"] == "DRAFT"  # training never deploys
    assert oos["auc"] > 0.6  # informative feature is learned out-of-sample
    assert load_registry(models)[0]["feature_names"] == ["x", "noise", "side"]

    monkeypatch.setenv("AI_SERVICE_SECRET", SECRET)
    import app.main as main

    main.meta_service.dir = models
    main.meta_service._cache.clear()
    client = TestClient(main.app)
    req = {"instrument_id": "NSE:T", "side": "BUY", "features": {"x": 1.5, "noise": 0.0}, "mode": "PAPER"}

    # DRAFT is not eligible for any mode -> null (gateway fails closed)
    assert signed_post(client, "/predict/meta", req).json()["probability"] is None

    set_status(models, "meta-ensemble", entry["version"], "PAPER")
    good = signed_post(client, "/predict/meta", req).json()
    bad = signed_post(client, "/predict/meta", {**req, "features": {"x": -1.5, "noise": 0.0}}).json()
    assert good["probability"] > bad["probability"]
    # A PAPER-stage model must not be used for LIVE trading
    assert signed_post(client, "/predict/meta", {**req, "mode": "LIVE"}).json()["probability"] is None

    rows = [{"x": float(v), "noise": 0.0} for v in np.random.default_rng(3).normal(3, 0.5, 300)]
    d = signed_post(client, "/drift", {"rows": rows, "mode": "PAPER"}).json()
    assert d["status"] == "SIGNIFICANT"
