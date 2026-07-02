"""Test that the summarization threshold correctly tracks model changes mid-session.

Scenario: session starts with model A (1M context) then next message uses model B (400K context).
The threshold must reflect the *active* model, not the original one.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.agent.hooks.summarization import (
    PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO,
    build_summarization_hook,
    prompt_token_threshold_for_model,
    resolve_prompt_token_threshold,
)


# ── Model threshold values ────────────────────────────────────────────────────


def test_model_a_threshold():
    """codex:gpt-5.5 has ~1M context → threshold = 80% of that."""
    from app.agent.providers.model_metadata import get_model_limits

    context = get_model_limits("codex:gpt-5.5").context_length
    assert context is not None, "codex:gpt-5.5 must have a known context length"
    expected = int(context * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO)
    assert prompt_token_threshold_for_model("codex:gpt-5.5") == expected
    # Sanity: should be substantially more than the fallback default
    assert expected > 500_000


def test_model_b_threshold():
    """openai:gpt-realtime-2 has 32K context → threshold = 80% of that."""
    from app.agent.providers.model_metadata import get_model_limits

    context = get_model_limits("openai:gpt-realtime-2").context_length
    assert context is not None, "openai:gpt-realtime-2 must have a known context length"
    expected = int(context * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO)
    assert prompt_token_threshold_for_model("openai:gpt-realtime-2") == expected
    assert expected < 50_000


# ── Session model switch ──────────────────────────────────────────────────────


def test_threshold_changes_when_session_switches_model():
    """Simulates: session starts on model A (large), then overrides to model B (smaller).

    The threshold returned by resolve_prompt_token_threshold must reflect
    the *currently active* model at each turn, not the original agent config model.
    """
    model_a = "codex:gpt-5.5"  # ~1M context → ~840k threshold
    model_b = "openai:gpt-realtime-2"  # 32K context → ~25.6k threshold

    threshold_a = prompt_token_threshold_for_model(model_a)
    threshold_b = prompt_token_threshold_for_model(model_b)

    assert threshold_a > threshold_b, (
        f"model A ({model_a}) should have a higher threshold than model B ({model_b})"
    )

    # Turn 1: session uses model A (no custom override in settings)
    assert resolve_prompt_token_threshold(model_a, None) == threshold_a

    # Turn 2: session switches to model B — threshold must update
    assert resolve_prompt_token_threshold(model_b, None) == threshold_b

    # The two thresholds are genuinely different
    assert threshold_a != threshold_b


def test_build_hook_uses_session_model_not_agent_config(
    monkeypatch: pytest.MonkeyPatch, tmp_path
):
    """build_summarization_hook is called with the *runtime* model each turn.

    When the session overrides the agent model, member.py passes
    ``model_id=runtime_model`` to build_summarization_hook.  Verify that
    two successive calls with different model_ids produce hooks with the
    correct per-model threshold — not a shared cached value.
    """
    import app.core.runtime_settings as rs_module

    # No custom setting — use auto
    settings_file = tmp_path / "settings.yaml"
    monkeypatch.setattr(rs_module, "runtime_settings_path", lambda: settings_file)

    provider = MagicMock()

    model_a = "codex:gpt-5.5"
    model_b = "openai:gpt-realtime-2"

    hook_a = build_summarization_hook(provider, model_id=model_a)
    hook_b = build_summarization_hook(provider, model_id=model_b)

    assert hook_a is not None
    assert hook_b is not None

    expected_a = prompt_token_threshold_for_model(model_a)
    expected_b = prompt_token_threshold_for_model(model_b)

    assert hook_a._prompt_token_threshold == expected_a
    assert hook_b._prompt_token_threshold == expected_b
    assert hook_a._prompt_token_threshold != hook_b._prompt_token_threshold


def test_custom_setting_respected_on_model_switch(
    monkeypatch: pytest.MonkeyPatch, tmp_path
):
    """A user-set custom threshold is applied relative to each model's auto value.

    If model A auto=840k and model B auto=160k, and the user sets custom=200k:
    - model A: custom(200k) < auto(840k) → use 200k
    - model B: custom(200k) >= auto(160k) → use auto (160k)
    """
    import app.core.runtime_settings as rs_module
    from app.core.runtime_settings import RuntimeSettings, save_runtime_settings

    settings_file = tmp_path / "settings.yaml"
    monkeypatch.setattr(rs_module, "runtime_settings_path", lambda: settings_file)

    cfg = RuntimeSettings()
    cfg.summarization.prompt_token_threshold = 200_000
    save_runtime_settings(cfg, settings_file)

    provider = MagicMock()
    model_a = "codex:gpt-5.5"  # auto ~840k → custom 200k wins (200k < 840k)
    model_b = "openai:gpt-realtime-2"  # auto ~25.6k → auto wins (200k >= 25.6k)

    hook_a = build_summarization_hook(provider, model_id=model_a)
    hook_b = build_summarization_hook(provider, model_id=model_b)

    assert hook_a is not None
    assert hook_b is not None

    assert hook_a._prompt_token_threshold == 200_000
    assert hook_b._prompt_token_threshold == prompt_token_threshold_for_model(model_b)
