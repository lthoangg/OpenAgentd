"""Tests for provider disconnect helpers in app/core/runtime_settings.py."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.runtime_settings import (
    ProviderUiSettings,
    RuntimeSettings,
    load_runtime_settings,
    provider_is_disconnected,
    save_runtime_settings,
    set_provider_disconnected,
)


@pytest.fixture
def settings_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate runtime_settings_path() to a temp dir; return that dir."""
    from app.core import runtime_settings as rs_module

    monkeypatch.setattr(
        rs_module, "runtime_settings_path", lambda: tmp_path / "settings.yaml"
    )
    return tmp_path


# ── provider_is_disconnected ─────────────────────────────────────────────────


class TestProviderIsDisconnected:
    def test_returns_false_when_no_file(self, settings_dir: Path) -> None:
        assert not (settings_dir / "settings.yaml").exists()
        assert provider_is_disconnected("openai") is False

    def test_returns_false_when_provider_absent(self, settings_dir: Path) -> None:
        save_runtime_settings(RuntimeSettings())
        assert provider_is_disconnected("openai") is False

    def test_returns_false_when_flag_not_set(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={"openai": ProviderUiSettings(cached_models=["gpt-5"])}
            )
        )
        assert provider_is_disconnected("openai") is False

    def test_returns_true_when_flag_set(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={"openai": ProviderUiSettings(is_disconnected=True)}
            )
        )
        assert provider_is_disconnected("openai") is True

    def test_isolated_per_provider(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(is_disconnected=True),
                    "anthropic": ProviderUiSettings(is_disconnected=False),
                }
            )
        )
        assert provider_is_disconnected("openai") is True
        assert provider_is_disconnected("anthropic") is False


# ── set_provider_disconnected ────────────────────────────────────────────────


class TestSetProviderDisconnected:
    def test_creates_entry_and_sets_flag(self, settings_dir: Path) -> None:
        set_provider_disconnected("openai", disconnected=True)
        assert provider_is_disconnected("openai") is True

    def test_persists_flag_in_yaml(self, settings_dir: Path) -> None:
        set_provider_disconnected("openai", disconnected=True)
        text = (settings_dir / "settings.yaml").read_text(encoding="utf-8")
        assert "is_disconnected: true" in text

    def test_clear_flag(self, settings_dir: Path) -> None:
        set_provider_disconnected("openai", disconnected=True)
        set_provider_disconnected("openai", disconnected=False)
        assert provider_is_disconnected("openai") is False

    def test_clears_empty_entry_when_nothing_else_persisted(
        self, settings_dir: Path
    ) -> None:
        set_provider_disconnected("openai", disconnected=True)
        set_provider_disconnected("openai", disconnected=False)
        cfg = load_runtime_settings(settings_dir / "settings.yaml")
        assert "openai" not in cfg.providers

    def test_preserves_cached_models_when_clearing(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5"], is_disconnected=True
                    )
                }
            )
        )
        set_provider_disconnected("openai", disconnected=False)
        cfg = load_runtime_settings(settings_dir / "settings.yaml")
        assert "openai" in cfg.providers
        assert cfg.providers["openai"].cached_models == ["gpt-5"]
        assert cfg.providers["openai"].is_disconnected is False

    def test_does_not_touch_other_providers(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={"anthropic": ProviderUiSettings(cached_models=["claude-3"])}
            )
        )
        set_provider_disconnected("openai", disconnected=True)
        cfg = load_runtime_settings(settings_dir / "settings.yaml")
        assert cfg.providers["anthropic"].cached_models == ["claude-3"]
        assert cfg.providers["openai"].is_disconnected is True

    def test_idempotent_set(self, settings_dir: Path) -> None:
        set_provider_disconnected("openai", disconnected=True)
        set_provider_disconnected("openai", disconnected=True)
        assert provider_is_disconnected("openai") is True

    def test_idempotent_clear(self, settings_dir: Path) -> None:
        set_provider_disconnected("openai", disconnected=True)
        set_provider_disconnected("openai", disconnected=False)
        set_provider_disconnected("openai", disconnected=False)
        assert provider_is_disconnected("openai") is False
