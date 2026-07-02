"""Tests for resolve_prompt_token_threshold in app/agent/hooks/summarization.py."""

from __future__ import annotations

import pytest

from app.agent.hooks.summarization import (
    DEFAULT_PROMPT_TOKEN_THRESHOLD,
    PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO,
    prompt_token_threshold_for_model,
    resolve_prompt_token_threshold,
)


# ── resolve_prompt_token_threshold ────────────────────────────────────────────


def test_resolve_returns_auto_when_custom_is_none():
    """No setting → auto-computed value."""
    auto = prompt_token_threshold_for_model("openai:gpt-realtime-2")
    assert resolve_prompt_token_threshold("openai:gpt-realtime-2", None) == auto


def test_resolve_returns_auto_when_custom_equals_auto():
    """Custom == auto → auto (not strictly lower, no early trigger needed)."""
    auto = prompt_token_threshold_for_model("openai:gpt-realtime-2")
    assert resolve_prompt_token_threshold("openai:gpt-realtime-2", auto) == auto


def test_resolve_returns_auto_when_custom_exceeds_auto():
    """Custom > auto → auto (cannot raise the ceiling)."""
    auto = prompt_token_threshold_for_model("openai:gpt-realtime-2")
    assert (
        resolve_prompt_token_threshold("openai:gpt-realtime-2", auto + 10_000) == auto
    )


def test_resolve_returns_custom_when_below_auto():
    """Custom < auto → custom (triggers earlier)."""
    auto = prompt_token_threshold_for_model("openai:gpt-realtime-2")
    custom = auto - 5000
    assert custom > 0, "sanity: custom must be positive"
    assert resolve_prompt_token_threshold("openai:gpt-realtime-2", custom) == custom


def test_resolve_returns_custom_for_unknown_model_when_below_default():
    """Unknown model → auto = DEFAULT; custom below that is used."""
    custom = DEFAULT_PROMPT_TOKEN_THRESHOLD - 10_000
    assert resolve_prompt_token_threshold("unknown:model", custom) == custom


def test_resolve_returns_auto_for_unknown_model_when_custom_is_none():
    """Unknown model + no setting → DEFAULT fallback."""
    assert (
        resolve_prompt_token_threshold("unknown:model", None)
        == DEFAULT_PROMPT_TOKEN_THRESHOLD
    )


def test_resolve_returns_auto_for_unknown_model_when_custom_equals_default():
    """Unknown model + custom == DEFAULT → auto (equal is not strictly lower)."""
    assert (
        resolve_prompt_token_threshold("unknown:model", DEFAULT_PROMPT_TOKEN_THRESHOLD)
        == DEFAULT_PROMPT_TOKEN_THRESHOLD
    )


def test_resolve_returns_auto_for_unknown_model_when_custom_exceeds_default():
    """Unknown model + custom > DEFAULT → auto (cannot raise the ceiling)."""
    assert (
        resolve_prompt_token_threshold(
            "unknown:model", DEFAULT_PROMPT_TOKEN_THRESHOLD + 50_000
        )
        == DEFAULT_PROMPT_TOKEN_THRESHOLD
    )


def test_resolve_large_context_model_no_cap(monkeypatch):
    """Large-context models get the full 80% — there is no artificial upper cap."""
    import app.agent.hooks.summarization as summ_mod
    from app.agent.providers.model_metadata import ModelLimits

    # 10M-context model: 80% = 8M, nothing should clamp this.
    monkeypatch.setattr(
        summ_mod,
        "get_model_limits",
        lambda mid: ModelLimits(context_length=10_000_000),
    )
    auto = prompt_token_threshold_for_model("any:model")
    assert auto == int(10_000_000 * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO)  # 8_000_000

    # Custom below the 8M auto value is honoured.
    assert resolve_prompt_token_threshold("any:model", 5_000_000) == 5_000_000
    # Custom above the 8M auto value is ignored.
    assert resolve_prompt_token_threshold("any:model", 9_000_000) == auto


# ── build_summarization_hook reads setting ────────────────────────────────────


def test_build_hook_uses_custom_threshold_when_set(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    """build_summarization_hook should apply a user-configured threshold."""
    from unittest.mock import MagicMock
    import app.core.runtime_settings as rs_module
    from app.core.runtime_settings import RuntimeSettings, save_runtime_settings
    from app.agent.hooks.summarization import build_summarization_hook

    settings_file = tmp_path / "settings.yaml"
    monkeypatch.setattr(rs_module, "runtime_settings_path", lambda: settings_file)

    cfg = RuntimeSettings()
    # gpt-realtime-2 auto threshold = 24000; set custom below that
    cfg.summarization.prompt_token_threshold = 10_000
    save_runtime_settings(cfg, settings_file)

    provider = MagicMock()
    hook = build_summarization_hook(provider, model_id="openai:gpt-realtime-2")
    assert hook is not None
    assert hook._prompt_token_threshold == 10_000


def test_build_hook_ignores_custom_threshold_when_above_auto(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    """When custom >= auto, build_summarization_hook uses the auto value."""
    from unittest.mock import MagicMock
    import app.core.runtime_settings as rs_module
    from app.core.runtime_settings import RuntimeSettings, save_runtime_settings
    from app.agent.hooks.summarization import build_summarization_hook

    settings_file = tmp_path / "settings.yaml"
    monkeypatch.setattr(rs_module, "runtime_settings_path", lambda: settings_file)

    auto = prompt_token_threshold_for_model("openai:gpt-realtime-2")  # 24000
    cfg = RuntimeSettings()
    cfg.summarization.prompt_token_threshold = auto + 99_999
    save_runtime_settings(cfg, settings_file)

    provider = MagicMock()
    hook = build_summarization_hook(provider, model_id="openai:gpt-realtime-2")
    assert hook is not None
    assert hook._prompt_token_threshold == auto


def test_build_hook_uses_auto_when_no_setting(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
):
    """No settings.yaml → auto threshold is used."""
    from unittest.mock import MagicMock
    import app.core.runtime_settings as rs_module
    from app.agent.hooks.summarization import build_summarization_hook

    settings_file = tmp_path / "settings.yaml"
    monkeypatch.setattr(rs_module, "runtime_settings_path", lambda: settings_file)
    # settings_file does not exist → load_runtime_settings returns defaults

    auto = prompt_token_threshold_for_model("openai:gpt-realtime-2")
    provider = MagicMock()
    hook = build_summarization_hook(provider, model_id="openai:gpt-realtime-2")
    assert hook is not None
    assert hook._prompt_token_threshold == auto
