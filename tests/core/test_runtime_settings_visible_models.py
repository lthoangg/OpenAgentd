"""Tests for visible-model pruning in app/core/runtime_settings.py.

A ``visible_models`` selection that names a model the provider no longer
lists must be dropped: the visible set acts as a whitelist when non-empty,
so a stale entry would hide every remaining model of that provider in
pickers while leaving no UI row behind to un-select it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.runtime_settings import (
    ProviderUiSettings,
    RuntimeSettings,
    effective_visible_models,
    load_runtime_settings,
    provider_visible_models,
    save_runtime_settings,
    set_provider_cached_models,
)


@pytest.fixture
def settings_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Isolate runtime_settings_path() to a temp dir; return that dir."""
    from app.core import runtime_settings as rs_module

    monkeypatch.setattr(
        rs_module, "runtime_settings_path", lambda: tmp_path / "settings.yaml"
    )
    return tmp_path


# ── set_provider_cached_models ───────────────────────────────────────────────


class TestSetProviderCachedModelsPrunesVisible:
    def test_drops_visible_models_no_longer_listed(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5", "gpt-4o"],
                        visible_models=["gpt-4o", "gpt-4-turbo"],
                        last_listed_at=1,
                    )
                }
            )
        )

        set_provider_cached_models("openai", ["gpt-5", "gpt-5-mini"])

        cfg = load_runtime_settings(settings_dir / "settings.yaml")
        ui = cfg.providers["openai"]
        assert ui.cached_models == ["gpt-5", "gpt-5-mini"]
        assert ui.visible_models == []

    def test_keeps_visible_models_still_listed(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5", "gpt-4o"],
                        visible_models=["gpt-5", "gpt-4o"],
                        last_listed_at=1,
                    )
                }
            )
        )

        set_provider_cached_models("openai", ["gpt-5", "gpt-5-mini"])

        cfg = load_runtime_settings(settings_dir / "settings.yaml")
        assert cfg.providers["openai"].visible_models == ["gpt-5"]

    def test_does_not_touch_other_providers(self, settings_dir: Path) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5"],
                        visible_models=["gpt-5"],
                        last_listed_at=1,
                    ),
                    "anthropic": ProviderUiSettings(
                        cached_models=["claude-3"],
                        visible_models=["claude-3", "claude-retired"],
                        last_listed_at=1,
                    ),
                }
            )
        )

        set_provider_cached_models("openai", ["gpt-5", "gpt-5-mini"])

        cfg = load_runtime_settings(settings_dir / "settings.yaml")
        assert cfg.providers["openai"].visible_models == ["gpt-5"]
        assert cfg.providers["anthropic"].visible_models == [
            "claude-3",
            "claude-retired",
        ]


# ── effective_visible_models ─────────────────────────────────────────────────


class TestEffectiveVisibleModels:
    def test_limits_visible_models_to_cached_list(self) -> None:
        ui = ProviderUiSettings(
            cached_models=["gpt-5", "gpt-4o"],
            visible_models=["gpt-4o", "gpt-4-turbo"],
        )
        assert effective_visible_models(ui) == ["gpt-4o"]

    def test_keeps_visible_models_when_nothing_cached_yet(self) -> None:
        ui = ProviderUiSettings(cached_models=[], visible_models=["gpt-4o"])
        assert effective_visible_models(ui) == ["gpt-4o"]

    def test_provider_visible_models_returns_effective_list(
        self, settings_dir: Path
    ) -> None:
        save_runtime_settings(
            RuntimeSettings(
                providers={
                    "openai": ProviderUiSettings(
                        cached_models=["gpt-5"],
                        visible_models=["gpt-5", "gpt-4-turbo"],
                    )
                }
            )
        )
        assert provider_visible_models("openai") == ["gpt-5"]
