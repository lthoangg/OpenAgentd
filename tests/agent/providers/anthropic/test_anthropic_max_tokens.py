"""Regression tests for the Anthropic output-token cap fallback.

Background
----------
Anthropic model IDs reach the provider from *live* discovery (the Claude OAuth
plugin calls ``/v1/models``), so a brand-new model can be selectable before the
curated models.dev registry knows about it. When that happened for
``claude-opus-5`` the provider silently fell back to a hardcoded ``4096``
``max_tokens`` — a limit from the Claude 2 era and 16-31x smaller than any
current model's real cap.

The user-visible symptom was that ``write``/``patch`` tool calls for large
files were cut off mid-JSON (``finish_reason=max_tokens``), the partial call was
dropped as ``bad_json``, and the retry truncated at exactly the same boundary.

Contract under test
-------------------
An unknown Anthropic model must fall back to a cap that is usable for real
file-writing work, not 4096. Known models must keep using their published
registry limit verbatim.
"""

from __future__ import annotations

import pytest

from app.agent.providers.anthropic.anthropic import (
    _DEFAULT_MAX_OUTPUT_TOKENS,
    _max_output_tokens_for_model,
)
from app.agent.providers.anthropic import AnthropicProvider
from app.agent.providers.model_metadata import ModelLimits
from app.agent.schemas.chat import HumanMessage

#: Stands in for any model the curated registry does not know yet. Using a
#: synthetic ID keeps these tests deterministic — a real ID would start passing
#: for the wrong reason as soon as models.dev catches up.
UNKNOWN_MODEL = "claude-opus-99-unreleased"


@pytest.fixture(autouse=True)
def _clear_limits_cache():
    """The lookup is cached per model; reset it around every test."""
    _max_output_tokens_for_model.cache_clear()
    yield
    _max_output_tokens_for_model.cache_clear()


@pytest.fixture
def known_model_limits(monkeypatch: pytest.MonkeyPatch):
    """Pin a registry hit so 'known model' tests don't depend on models.dev."""

    def _fake_get_model_limits(model_id: str) -> ModelLimits:
        if UNKNOWN_MODEL in model_id:
            return ModelLimits()
        return ModelLimits(context_length=1000000, max_completion_tokens=128000)

    monkeypatch.setattr(
        "app.agent.providers.model_metadata.get_model_limits",
        _fake_get_model_limits,
    )


def test_unknown_model_cache_is_bounded():
    assert _max_output_tokens_for_model.cache_info().maxsize is not None


def test_unknown_anthropic_model_does_not_fall_back_to_4096(
    known_model_limits,
) -> None:
    """The historical 4096 fallback truncates large write/patch tool calls."""
    assert _max_output_tokens_for_model(UNKNOWN_MODEL) != 4096


def test_unknown_anthropic_model_uses_generous_default_cap(
    known_model_limits,
) -> None:
    assert _max_output_tokens_for_model(UNKNOWN_MODEL) == _DEFAULT_MAX_OUTPUT_TOKENS
    assert _DEFAULT_MAX_OUTPUT_TOKENS >= 32000


def test_known_anthropic_model_keeps_registry_limit(known_model_limits) -> None:
    """A registered model must use its published cap, not the fallback."""
    assert _max_output_tokens_for_model("claude-sonnet-4-6") == 128000


def test_unknown_model_payload_gets_generous_cap(known_model_limits) -> None:
    """End-to-end: an unregistered model must not build a 4096-capped payload."""
    provider = AnthropicProvider(api_key="test-key", model=UNKNOWN_MODEL)

    payload = provider._payload([HumanMessage(content="hi")], None, {})

    assert payload["max_tokens"] == _DEFAULT_MAX_OUTPUT_TOKENS


def test_unknown_model_fallback_is_logged_as_warning(known_model_limits) -> None:
    """Silent fallback is what let this bug sit in production — make it loud."""
    from loguru import logger

    records: list[str] = []
    sink_id = logger.add(records.append, level="WARNING")
    try:
        _max_output_tokens_for_model(UNKNOWN_MODEL)
    finally:
        logger.remove(sink_id)

    assert any(UNKNOWN_MODEL in record for record in records), records


def test_known_model_fallback_does_not_warn(known_model_limits) -> None:
    from loguru import logger

    records: list[str] = []
    sink_id = logger.add(records.append, level="WARNING")
    try:
        _max_output_tokens_for_model("claude-sonnet-4-6")
    finally:
        logger.remove(sink_id)

    assert records == []


def test_unknown_model_warning_is_not_repeated_per_call(known_model_limits) -> None:
    """This runs on every request — it must not flood the log sinks."""
    from loguru import logger

    records: list[str] = []
    sink_id = logger.add(records.append, level="WARNING")
    try:
        for _ in range(5):
            _max_output_tokens_for_model(UNKNOWN_MODEL)
    finally:
        logger.remove(sink_id)

    assert len(records) == 1, records


def test_opus_5_uses_adaptive_thinking_not_extended_thinking() -> None:
    """Opus 5 does not support ``thinking.type: "enabled"``.

    Per Anthropic's model overview, Claude Opus 5 supports adaptive thinking and
    explicitly does *not* support extended thinking. It shipped after
    ``_uses_adaptive_thinking`` was last updated, so it fell through to the
    legacy budget-based branch and would be sent an unsupported payload.
    """
    provider = AnthropicProvider(api_key="test-key", model="claude-opus-5")

    payload = provider._payload(
        [HumanMessage(content="hi")], None, {"thinking_level": "high"}
    )

    assert payload["thinking"] == {"type": "adaptive", "display": "summarized"}
    assert payload["output_config"] == {"effort": "high"}
    assert "budget_tokens" not in payload["thinking"]


def test_mythos_5_uses_adaptive_thinking() -> None:
    """``claude-mythos-5`` is the Project Glasswing sibling of Fable 5."""
    provider = AnthropicProvider(api_key="test-key", model="claude-mythos-5")

    payload = provider._payload(
        [HumanMessage(content="hi")], None, {"thinking_level": "high"}
    )

    assert payload["thinking"] == {"type": "adaptive", "display": "summarized"}


def test_bedrock_prefixed_model_resolves_registry_limit(known_model_limits) -> None:
    """Bedrock IDs carry an 'anthropic.' prefix — they must not hit the fallback."""
    assert (
        _max_output_tokens_for_model("anthropic.claude-sonnet-4-6")
        == _max_output_tokens_for_model("claude-sonnet-4-6")
        == 128000
    )
