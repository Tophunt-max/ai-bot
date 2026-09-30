"""Meta-label model serving. Model eligibility depends on the trading mode:
LIVE uses only PRODUCTION models; CANARY uses CANARY/PRODUCTION; SHADOW uses SHADOW+; PAPER uses PAPER+.
If no eligible model exists the probability is null — the gateway then fails closed."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np

from .drift import bin_fractions, drift_status, psi
from .registry import STATUSES, active_entry, load_artifact, registry_path

MODE_ALLOWED: dict[str, tuple[str, ...]] = {
    "LIVE": ("PRODUCTION",),
    "CANARY": ("CANARY", "PRODUCTION"),
    "SHADOW": ("SHADOW", "CANARY", "PRODUCTION"),
    "PAPER": ("PAPER", "SHADOW", "CANARY", "PRODUCTION"),
}


class MetaService:
    def __init__(self, models_dir: Path | None = None, model_id: str | None = None) -> None:
        self.dir = models_dir or Path(os.environ.get("MODELS_DIR", "/app/models"))
        self.model_id = model_id or os.environ.get("META_MODEL_ID", "meta-ensemble")
        self._cache: dict[str, tuple[float, dict[str, Any], dict[str, Any]]] = {}

    def _load(self, mode: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        reg = registry_path(self.dir)
        if not reg.exists():
            return None
        mtime = reg.stat().st_mtime
        hit = self._cache.get(mode)
        if hit and hit[0] == mtime:
            return hit[1], hit[2]
        entry = active_entry(self.dir, self.model_id, MODE_ALLOWED.get(mode, ("PRODUCTION",)))
        if not entry:
            return None
        art = load_artifact(self.dir, entry)
        self._cache[mode] = (mtime, entry, art)
        return entry, art

    def predict(self, features: dict[str, float], side: str, mode: str) -> dict[str, Any]:
        loaded = self._load(mode)
        if not loaded:
            return {"probability": None, "model_version": "none", "status": "NO_ELIGIBLE_MODEL"}
        entry, art = loaded
        names: list[str] = art["meta"]["feature_names"]
        row = []
        for n in names:
            if n == "side":
                row.append(1.0 if side == "BUY" else -1.0)
            else:
                v = features.get(n)
                row.append(float(v) if v is not None and np.isfinite(v) else np.nan)
        missing = [n for n in names if n != "side" and n not in features]
        if len(missing) > len(names) // 3:
            return {
                "probability": None,
                "model_version": entry["version"],
                "status": f"FEATURE_MISMATCH:{missing[:5]}",
            }
        p = float(art["model"].predict_proba(np.array([row]))[0, 1])
        return {
            "probability": p,
            "model_version": f"{entry['model_id']}:{entry['version']}",
            "status": entry["status"],
        }

    def drift(self, rows: list[dict[str, float]], mode: str = "PAPER") -> dict[str, Any]:
        loaded = self._load(mode)
        if not loaded:
            return {"status": "NO_ELIGIBLE_MODEL", "features": {}}
        _, art = loaded
        ref = art["meta"].get("drift_reference", {})
        out: dict[str, Any] = {}
        worst = 0.0
        for name, r in ref.items():
            if name == "side":
                continue
            x = np.array([float(row.get(name, np.nan)) for row in rows], dtype=float)
            if np.isfinite(x).sum() < 20:
                continue
            v = psi(r["fractions"], bin_fractions(x, r["edges"]))
            out[name] = {"psi": v, "status": drift_status(v)}
            worst = max(worst, v)
        return {"status": drift_status(worst), "max_psi": worst, "features": out}

    def version(self, mode: str = "LIVE") -> dict[str, Any]:
        loaded = self._load(mode)
        if not loaded:
            return {"model_id": self.model_id, "status": "NO_ELIGIBLE_MODEL", "statuses": STATUSES}
        entry, _ = loaded
        return {
            k: entry[k]
            for k in (
                "model_id",
                "version",
                "status",
                "features_version",
                "dataset_version",
                "out_of_sample_metrics",
            )
            if k in entry
        }
