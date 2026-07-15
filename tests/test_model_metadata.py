from __future__ import annotations

from app.agent.providers.model_metadata import (
    get_model_cost,
    get_model_features,
    get_model_limits,
    get_model_metadata,
    get_model_thinking_levels,
)


def test_get_model_limits_returns_known_limits() -> None:
    limits = get_model_limits("openai:gpt-5")

    assert limits.context_length == 400000
    assert limits.max_completion_tokens == 128000


def test_get_model_limits_returns_codex_registry_limits() -> None:
    limits = get_model_limits("codex:gpt-5.2-codex")

    assert limits.context_length == 400000
    assert limits.max_completion_tokens == 128000


def test_get_model_metadata_is_case_insensitive() -> None:
    metadata = get_model_metadata("OPENAI:GPT-5")

    assert metadata.limits.context_length == 400000


def test_get_model_limits_unknown_model_returns_none_limits() -> None:
    limits = get_model_limits("unknown:model")

    assert limits.context_length is None
    assert limits.max_completion_tokens is None


def test_get_model_cost_unknown_model_returns_none_cost() -> None:
    cost = get_model_cost("unknown:model")

    assert cost.input is None
    assert cost.output is None


def test_get_model_features_unknown_model_returns_none_features() -> None:
    features = get_model_features("unknown:model")

    assert features.tool_call is None
    assert features.status is None


def test_get_model_thinking_levels_returns_known_levels() -> None:
    assert get_model_thinking_levels("openai:gpt-5") == (
        "minimal",
        "low",
        "medium",
        "high",
    )


def test_get_model_thinking_levels_unknown_model_returns_empty_tuple() -> None:
    assert get_model_thinking_levels("unknown:model") == ()
