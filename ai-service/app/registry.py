"""File-based model registry (artifacts on disk / synced to R2). Mirrors the D1 model_versions
lifecycle: DRAFT → VALIDATING → PAPER → SHADOW → CANARY → PRODUCTION → RETIRED.
Training NEVER sets PRODUCTION: promotion is an explicit, audited owner action in the Worker."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

import joblib

STATUSES = ["DRAFT", "VALIDATING", "PAPER", "SHADOW", "CANARY", "PRODUCTION", "RETIRED"]


def registry_path(root: Path) -> Path:
    return root / "registry.json"


def load_registry(root: Path) -> list[dict[str, Any]]:
    p = registry_path(root)
    return json.loads(p.read_text()) if p.exists() else []


def save_model(root: Path, model: Any, meta: dict[str, Any]) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    version = meta.get("version") or time.strftime("%Y%m%d%H%M%S")
    artifact = root / f"{meta['model_id']}-{version}.joblib"
    joblib.dump({"model": model, "meta": meta}, artifact)
    entry = {
        **meta,
        "version": version,
        "artifact": artifact.name,
        "status": "DRAFT",
        "created_at": int(time.time() * 1000),
    }
    reg = [
        r for r in load_registry(root) if not (r["model_id"] == meta["model_id"] and r["version"] == version)
    ]
    reg.append(entry)
    tmp = registry_path(root).with_suffix(".tmp")
    tmp.write_text(json.dumps(reg, indent=2))
    os.replace(tmp, registry_path(root))
    return entry


def set_status(root: Path, model_id: str, version: str, status: str) -> None:
    if status not in STATUSES:
        raise ValueError(status)
    reg = load_registry(root)
    for r in reg:
        if r["model_id"] == model_id and r["version"] == version:
            r["status"] = status
        elif status == "PRODUCTION" and r["model_id"] == model_id and r["status"] == "PRODUCTION":
            r["status"] = "RETIRED"
    registry_path(root).write_text(json.dumps(reg, indent=2))


def active_entry(root: Path, model_id: str, allowed: tuple[str, ...]) -> dict[str, Any] | None:
    """Most advanced entry whose status is in `allowed` (e.g. PRODUCTION/CANARY/SHADOW/PAPER)."""
    cands = [r for r in load_registry(root) if r["model_id"] == model_id and r["status"] in allowed]
    if not cands:
        return None
    return max(cands, key=lambda r: (STATUSES.index(r["status"]), r["created_at"]))


def load_artifact(root: Path, entry: dict[str, Any]) -> dict[str, Any]:
    return joblib.load(root / entry["artifact"])
