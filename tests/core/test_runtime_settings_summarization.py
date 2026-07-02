"""Tests for SummarizationSettings in app/core/runtime_settings.py."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.runtime_settings import (
    RuntimeSettings,
    SummarizationSettings,
    load_runtime_settings,
    save_runtime_settings,
)


@pytest.fixture
def settings_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from app.core import runtime_settings as rs_module

    monkeypatch.setattr(
        rs_module, "runtime_settings_path", lambda: tmp_path / "settings.yaml"
    )
    return tmp_path / "settings.yaml"


# ── SummarizationSettings model ───────────────────────────────────────────────


def test_summarization_settings_default_is_none():
    cfg = SummarizationSettings()
    assert cfg.prompt_token_threshold is None


def test_summarization_settings_accepts_positive_int():
    cfg = SummarizationSettings(prompt_token_threshold=50000)
    assert cfg.prompt_token_threshold == 50000


def test_runtime_settings_summarization_field_defaults():
    cfg = RuntimeSettings()
    assert cfg.summarization.prompt_token_threshold is None


# ── Persistence round-trip ────────────────────────────────────────────────────


def test_save_and_load_summarization_settings(settings_path: Path):
    cfg = RuntimeSettings()
    cfg.summarization.prompt_token_threshold = 80_000
    save_runtime_settings(cfg)

    loaded = load_runtime_settings(settings_path)
    assert loaded.summarization.prompt_token_threshold == 80_000


def test_save_and_load_null_summarization_threshold(settings_path: Path):
    cfg = RuntimeSettings()
    cfg.summarization.prompt_token_threshold = None
    save_runtime_settings(cfg)

    loaded = load_runtime_settings(settings_path)
    assert loaded.summarization.prompt_token_threshold is None


def test_missing_summarization_key_defaults_to_none(settings_path: Path):
    """A settings.yaml without a 'summarization' key should not crash."""
    settings_path.write_text("title_generation:\n  enabled: true\n", encoding="utf-8")
    loaded = load_runtime_settings(settings_path)
    assert loaded.summarization.prompt_token_threshold is None
