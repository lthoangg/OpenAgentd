"""Tests for build_summarization_hook() in app/agent/hooks/summarization.py.

The factory has no per-agent or file overrides — it just instantiates a
SummarizationHook from the module-level ``DEFAULT_*`` constants. The only
runtime input is ``mode``, which selects the summariser prompt.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.agent.hooks.summarization import (
    CHAT_SUMMARY_PROMPT,
    CODING_KEEP_LAST_ASSISTANTS,
    CODING_SUMMARY_PROMPT,
    DEFAULT_KEEP_LAST_ASSISTANTS,
    DEFAULT_MAX_TOKEN_LENGTH,
    DEFAULT_PROMPT_TOKEN_THRESHOLD,
    PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO,
    SummarizationHook,
    build_summarization_hook,
    prompt_token_threshold_for_model,
)


@pytest.fixture
def mock_provider():
    provider = MagicMock()
    provider.stream = MagicMock()
    return provider


def test_builds_hook_with_module_defaults(mock_provider):
    """No mode → CHAT prompt + module-level numeric defaults."""
    result = build_summarization_hook(mock_provider)
    assert isinstance(result, SummarizationHook)
    assert result._prompt_token_threshold == DEFAULT_PROMPT_TOKEN_THRESHOLD
    assert result._keep_last_assistants == DEFAULT_KEEP_LAST_ASSISTANTS
    assert result._max_token_length == DEFAULT_MAX_TOKEN_LENGTH
    assert result._summary_prompt == CHAT_SUMMARY_PROMPT
    assert result._model_id is None
    # default_provider is reused — no separate summariser model resolution.
    assert result._llm_provider is mock_provider


def test_mode_coding_picks_coding_prompt_and_zero_keep(mock_provider):
    """mode="coding" uses the structured Markdown template AND summarises
    everything (no recent assistant turns preserved)."""
    result = build_summarization_hook(mock_provider, mode="coding")
    assert result is not None
    assert result._summary_prompt == CODING_SUMMARY_PROMPT
    assert result._keep_last_assistants == CODING_KEEP_LAST_ASSISTANTS == 0


def test_mode_normal_picks_chat_prompt_and_default_keep(mock_provider):
    """Any non-coding mode picks the prose chat prompt + the chat keep window."""
    result = build_summarization_hook(mock_provider, mode="normal")
    assert result is not None
    assert result._summary_prompt == CHAT_SUMMARY_PROMPT
    assert result._keep_last_assistants == DEFAULT_KEEP_LAST_ASSISTANTS


def test_mode_none_picks_chat_prompt_and_default_keep(mock_provider):
    """mode=None (omitted) defaults to the prose chat prompt + chat keep window."""
    result = build_summarization_hook(mock_provider)
    assert result is not None
    assert result._summary_prompt == CHAT_SUMMARY_PROMPT
    assert result._keep_last_assistants == DEFAULT_KEEP_LAST_ASSISTANTS


def test_prompt_token_threshold_for_model_large_context_no_cap():
    # gpt-4.1 has 1,047,576 context; 80% = 838,060 — no artificial cap applied.
    from app.agent.providers.model_metadata import get_model_limits

    context = get_model_limits("openai:gpt-4.1").context_length
    assert context is not None
    expected = int(context * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO)
    assert prompt_token_threshold_for_model("openai:gpt-4.1") == expected


def test_prompt_token_threshold_for_model_uses_80_percent_context():
    assert prompt_token_threshold_for_model("openai:gpt-realtime-2") == int(
        32000 * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO
    )


def test_prompt_token_threshold_for_model_unknown_uses_default():
    assert (
        prompt_token_threshold_for_model("unknown:model")
        == DEFAULT_PROMPT_TOKEN_THRESHOLD
    )


def test_builds_hook_with_model_threshold(mock_provider):
    result = build_summarization_hook(mock_provider, model_id="openai:gpt-realtime-2")

    assert result is not None
    assert result._model_id == "openai:gpt-realtime-2"
    # gpt-realtime-2 has 32k context; 80% = 25600
    assert result._prompt_token_threshold == int(
        32000 * PROMPT_TOKEN_THRESHOLD_CONTEXT_RATIO
    )


def test_zero_threshold_returns_none(mock_provider, monkeypatch):
    """The module-level threshold acts as the only kill switch."""
    import app.agent.hooks.summarization as mod

    monkeypatch.setattr(mod, "DEFAULT_PROMPT_TOKEN_THRESHOLD", 0)
    assert build_summarization_hook(mock_provider) is None


def test_builds_hook_caps_max_token_length_for_known_model(mock_provider):
    """Passing a model with a known max completion token limit caps max_token_length."""
    result = build_summarization_hook(mock_provider, model_id="openai:gpt-realtime-2")
    assert result is not None
    # openai:gpt-realtime-2 has a limit of 4096 in the registry, which is less than 30000.
    assert result._max_token_length == 4096


def test_builds_hook_keeps_default_max_token_length_for_unknown_model(mock_provider):
    """Passing an unknown model keeps the default max_token_length."""
    result = build_summarization_hook(mock_provider, model_id="unknown:model")
    assert result is not None
    assert result._max_token_length == DEFAULT_MAX_TOKEN_LENGTH
