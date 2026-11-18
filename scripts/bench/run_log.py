"""Totals from an ``agentd run --json`` log.

The log holds one ``{"event": ..., "data": ...}`` object per line. Each
``usage`` event reports one model call (the lead's or a subagent's), so the
run's totals are their sums.
"""

from __future__ import annotations

import json
from pathlib import Path


def summarize(path: Path) -> dict:
    """Token and cost totals, the model-call count, and the last error title.

    ``input_tokens`` includes ``cached_tokens``. ``cost_usd`` is ``None`` when
    no call carried an estimate.
    """
    totals: dict = {"input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "cost_usd": None, "model_calls": 0, "error": None}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        data = record.get("data") if isinstance(record, dict) else None
        if not isinstance(data, dict):
            continue
        if record.get("event") == "usage":
            totals["model_calls"] += 1
            totals["input_tokens"] += data.get("prompt_tokens") or 0
            totals["cached_tokens"] += data.get("cached_tokens") or 0
            totals["output_tokens"] += data.get("completion_tokens") or 0
            cost = data.get("estimated_cost_usd")
            if isinstance(cost, (int, float)):
                totals["cost_usd"] = (totals["cost_usd"] or 0.0) + cost
        elif record.get("event") == "error":
            totals["error"] = data.get("title") or data.get("code") or "error"
    return totals
