"""Purged, embargoed walk-forward splits.

Each sample i has an information interval [start_i, end_i] (signal time → barrier resolution).
For every test fold we train ONLY on samples that (a) end before the test fold starts and
(b) are not within the embargo after the previous boundary — so no training label can "see"
the test period (no leakage through overlapping labels).
"""

from __future__ import annotations

from collections.abc import Iterator

import numpy as np
from numpy.typing import NDArray


def purged_walk_forward(
    start: NDArray[np.int64],
    end: NDArray[np.int64],
    n_splits: int = 5,
    embargo: int = 0,
    min_train: int = 50,
) -> Iterator[tuple[NDArray[np.int64], NDArray[np.int64]]]:
    order = np.argsort(start, kind="stable")
    n = len(order)
    fold = n // (n_splits + 1)
    if fold == 0:
        return
    for k in range(1, n_splits + 1):
        test_idx = order[k * fold : (k + 1) * fold if k < n_splits else n]
        if len(test_idx) == 0:
            continue
        test_start = start[test_idx].min()
        train_mask = end[order] < test_start - embargo  # purge: label resolved before test begins
        train_idx = order[train_mask]
        train_idx = train_idx[start[train_idx] < test_start]
        if len(train_idx) < min_train:
            continue
        yield train_idx, test_idx
