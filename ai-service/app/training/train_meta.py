"""Train the meta-label model: "given a rule-ensemble candidate, does it reach its target
before its stop?". The model can only FILTER candidates (reduce trading); it never creates
trades or changes size beyond the risk engine's limits.

Usage:
  python -m app.training.train_meta --candidates data/candidates.csv --candles-dir data/candles \\
      --models-dir models --model-id meta-ensemble

candidates.csv (exported by `pnpm --filter @atb/backtesting export-dataset`):
  instrument_id,t,side,entry,stop,target,max_bars,strategies,regime,f_<feature>...
candles-dir: one CSV per instrument, named <instrument id with ':' -> '_'>.csv
  (timestamp,open,high,low,close,volume).
"""

from __future__ import annotations

import argparse
import csv
import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import brier_score_loss, roc_auc_score

from ..drift import bin_fractions, quantile_edges
from ..registry import save_model
from .cv import purged_walk_forward
from .labels import triple_barrier

os.environ.setdefault("LOKY_MAX_CPU_COUNT", "1")
FEATURES_VERSION = "f-1.0.0"


@dataclass
class Candles:
    t: np.ndarray
    o: np.ndarray
    h: np.ndarray
    l: np.ndarray  # noqa: E741
    c: np.ndarray


def parse_ts(s: str) -> int:
    return int(s) if s.isdigit() else int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)


def load_candles(path: Path) -> Candles:
    rows = []
    with path.open() as fh:
        for r in csv.reader(fh):
            if not r or not r[1].replace(".", "", 1).isdigit():
                continue
            rows.append((parse_ts(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4])))
    a = np.array(rows, dtype=float)
    return Candles(a[:, 0].astype(np.int64), a[:, 1], a[:, 2], a[:, 3], a[:, 4])


def load_candidates(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    with path.open() as fh:
        rows = list(csv.DictReader(fh))
    features = [k for k in (rows[0].keys() if rows else []) if k.startswith("f_")]
    return rows, features


def build_dataset(rows: list[dict[str, Any]], features: list[str], candles_dir: Path):
    cache: dict[str, Candles] = {}
    X, y, r_mult, start, end = [], [], [], [], []
    for row in rows:
        inst = row["instrument_id"]
        if inst not in cache:
            cache[inst] = load_candles(candles_dir / f"{inst.replace(':', '_')}.csv")
        cd = cache[inst]
        t = int(row["t"])
        i = int(np.searchsorted(cd.t, t))
        if i >= len(cd.t) or cd.t[i] != t:
            continue
        side = 1 if row["side"] == "BUY" else -1
        res = triple_barrier(
            cd.o, cd.h, cd.l, cd.c, i, side, float(row["stop"]), float(row["target"]), int(row["max_bars"])
        )
        if res.touched == "NO_DATA":
            continue
        feats = [float(row[f]) if row[f] not in ("", "NaN", "nan") else np.nan for f in features]
        X.append(feats + [float(side)])
        y.append(res.label)
        r_mult.append(res.r_multiple)
        start.append(int(cd.t[i]))
        end.append(int(cd.t[res.exit_index]))
    return (
        np.array(X, dtype=float),
        np.array(y, dtype=int),
        np.array(r_mult, dtype=float),
        np.array(start, dtype=np.int64),
        np.array(end, dtype=np.int64),
    )


def make_model() -> CalibratedClassifierCV:
    base = HistGradientBoostingClassifier(
        max_depth=3, learning_rate=0.05, max_iter=200, l2_regularization=1.0, min_samples_leaf=40
    )
    return CalibratedClassifierCV(base, method="sigmoid", cv=3)


def evaluate_oos(X, y, r, start, end, n_splits: int, threshold: float, embargo_ms: int) -> dict[str, Any]:
    probs = np.full(len(y), np.nan)
    folds = 0
    for tr, te in purged_walk_forward(start, end, n_splits=n_splits, embargo=embargo_ms, min_train=60):
        if len(np.unique(y[tr])) < 2:
            continue
        m = make_model().fit(X[tr], y[tr])
        probs[te] = m.predict_proba(X[te])[:, 1]
        folds += 1
    mask = np.isfinite(probs)
    if mask.sum() < 20 or len(np.unique(y[mask])) < 2:
        return {
            "folds": folds,
            "oos_samples": int(mask.sum()),
            "verdict": "FAIL",
            "reasons": ["not enough OOS samples"],
        }
    p, yy, rr = probs[mask], y[mask], r[mask]
    kept = p >= threshold
    base_r = float(rr.mean())
    kept_r = float(rr[kept].mean()) if kept.any() else float("nan")
    auc = float(roc_auc_score(yy, p))
    out = {
        "folds": folds,
        "oos_samples": int(mask.sum()),
        "auc": auc,
        "brier": float(brier_score_loss(yy, p)),
        "base_rate": float(yy.mean()),
        "threshold": threshold,
        "kept_fraction": float(kept.mean()),
        "base_expectancy_r": base_r,
        "filtered_expectancy_r": kept_r,
        "uplift_r": kept_r - base_r if kept.any() else float("nan"),
    }
    reasons = []
    if auc < 0.55:
        reasons.append(f"OOS AUC {auc:.3f} < 0.55")
    if not kept.any() or not (kept_r - base_r > 0.05):
        reasons.append("filter does not improve OOS expectancy by > 0.05R")
    if kept.mean() < 0.1:
        reasons.append("filter keeps < 10% of candidates (too few trades)")
    out["verdict"] = "PASS" if not reasons else "FAIL"
    out["reasons"] = reasons
    return out


def train(
    candidates: Path,
    candles_dir: Path,
    models_dir: Path,
    model_id: str,
    n_splits: int = 5,
    threshold: float = 0.55,
):
    rows, features = load_candidates(candidates)
    X, y, r, start, end = build_dataset(rows, features, candles_dir)
    if len(y) < 100:
        raise SystemExit(f"need >= 100 labelled candidates, got {len(y)}")
    embargo = int(np.median(end - start)) if len(end) else 0
    oos = evaluate_oos(X, y, r, start, end, n_splits, threshold, embargo)
    final = make_model().fit(X, y)  # fit on everything only AFTER the OOS evaluation
    names = [f[2:] for f in features] + ["side"]
    reference = {n: {"edges": quantile_edges(X[:, j])} for j, n in enumerate(names)}
    for j, n in enumerate(names):
        reference[n]["fractions"] = bin_fractions(X[:, j], reference[n]["edges"])
    meta = {
        "model_id": model_id,
        "features_version": FEATURES_VERSION,
        "feature_names": names,
        "dataset_version": f"{candidates.name}:{len(y)}",
        "training_date": int(datetime.now().timestamp() * 1000),
        "validation_metrics": {"samples": int(len(y)), "base_rate": float(y.mean())},
        "out_of_sample_metrics": oos,
        "threshold": threshold,
        "drift_reference": reference,
    }
    return save_model(models_dir, final, meta)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", type=Path, required=True)
    ap.add_argument("--candles-dir", type=Path, required=True)
    ap.add_argument("--models-dir", type=Path, default=Path("models"))
    ap.add_argument("--model-id", default="meta-ensemble")
    ap.add_argument("--splits", type=int, default=5)
    ap.add_argument("--threshold", type=float, default=0.55)
    a = ap.parse_args()
    entry = train(a.candidates, a.candles_dir, a.models_dir, a.model_id, a.splits, a.threshold)
    oos = entry["out_of_sample_metrics"]
    print(f"registered {entry['model_id']} {entry['version']} as DRAFT")  # noqa: T201
    print(f"OOS verdict: {oos['verdict']} {oos.get('reasons', [])}")  # noqa: T201
    print({k: v for k, v in oos.items() if k not in ("reasons",)})  # noqa: T201


if __name__ == "__main__":
    main()
