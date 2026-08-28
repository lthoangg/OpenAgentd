from __future__ import annotations

import json

import pytest

from app.agent.providers.codex import catalog
from app.agent.providers.codex.catalog import (
    model_ids,
    model_registry_overlay,
    supports_reasoning_summary,
)


def test_model_registry_overlay_uses_default_effective_window_and_ignores_bad_limits() -> (
    None
):
    registry = model_registry_overlay(
        {
            "models": [
                {"slug": "gpt-default", "context_window": 272_000},
                {
                    "slug": "gpt-prefers-max",
                    "context_window": 272_000,
                    "max_context_window": 872_000,
                },
                {"slug": "gpt-bad-bool", "context_window": True},
                {
                    "slug": "gpt-bad-percent",
                    "context_window": 1000,
                    "effective_context_window_percent": 101,
                },
                {"slug": "gpt-missing"},
            ]
        }
    )

    assert registry == {
        "codex:gpt-default": {
            "limits": {
                "context_length": 272_000,
                "max_input_tokens": 258_400,
            }
        },
        "codex:gpt-prefers-max": {
            "limits": {
                "context_length": 872_000,
                "max_input_tokens": 828_400,
            }
        },
    }


def test_model_ids_returns_only_valid_slugs() -> None:
    assert model_ids(
        {
            "models": [
                {"slug": "gpt-5.6-sol"},
                {"slug": "gpt-5.6-terra"},
                {"slug": 123},
                {},
            ]
        }
    ) == ["gpt-5.6-sol", "gpt-5.6-terra"]


def test_supports_reasoning_summary_uses_live_model_capability() -> None:
    data = {
        "models": [
            {"slug": "gpt-supported", "supports_reasoning_summary_parameter": True},
            {"slug": "gpt-unsupported", "supports_reasoning_summary_parameter": False},
        ]
    }

    assert supports_reasoning_summary(data, "gpt-supported") is True
    assert supports_reasoning_summary(data, "gpt-unsupported") is False
    assert supports_reasoning_summary(data, "gpt-unknown") is None


def test_load_catalog_reuses_fresh_cache_without_fetch(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(catalog.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(catalog.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True)
    cached = {"models": [{"slug": "gpt-cached", "context_window": 272_000}]}
    (tmp_path / "codex-models.json").write_text(json.dumps(cached), encoding="utf-8")
    monkeypatch.setattr(
        catalog,
        "_fetch_catalog",
        lambda: pytest.fail("fresh cache must avoid a network request"),
    )

    assert catalog.load_codex_catalog() == cached


def test_load_catalog_caches_only_operational_model_metadata(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(catalog.settings, "OPENAGENTD_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(catalog.settings, "OPENAGENTD_MODEL_REGISTRY_REFRESH", True)
    monkeypatch.setattr(
        catalog,
        "_fetch_catalog",
        lambda: {
            "models": [
                {
                    "slug": "gpt-live",
                    "context_window": 272_000,
                    "max_context_window": 272_000,
                    "effective_context_window_percent": 95,
                    "auto_compact_token_limit": 244_800,
                    "supports_reasoning_summary_parameter": False,
                    "base_instructions": "large provider prompt that is not needed",
                }
            ],
            "unrelated": "discard me",
        },
    )

    catalog.load_codex_catalog(force=True)

    persisted = json.loads((tmp_path / "codex-models.json").read_text(encoding="utf-8"))
    assert persisted == {
        "models": [
            {
                "slug": "gpt-live",
                "context_window": 272_000,
                "max_context_window": 272_000,
                "effective_context_window_percent": 95,
                "auto_compact_token_limit": 244_800,
                "supports_reasoning_summary_parameter": False,
            }
        ]
    }
