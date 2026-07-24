"""Tests for the ``__PROVIDER_MODEL__`` placeholder → UnconfiguredProvider path.

Covers:

- ``build_provider`` raises :class:`UnconfiguredProviderError` for the
  literal placeholder token rather than the generic ``ValueError``.
- The error is a ``ValueError`` subclass so old callers still match.
- :class:`UnconfiguredProvider` raises the typed error on both
  ``chat`` and ``stream``.
- The loader substitutes the stub when ``cfg.model`` is the placeholder,
  so the agent loads instead of crashing the team manager.
"""

from __future__ import annotations

import pytest

from app.agent.providers.factory import build_provider
from app.agent.providers.unconfigured import (
    UnconfiguredProvider,
    UnconfiguredProviderError,
)
from app.core.config import PROVIDER_MODEL_TOKEN


def test_unconfigured_error_is_value_error() -> None:
    """Existing callers that catch ValueError still match."""
    assert issubclass(UnconfiguredProviderError, ValueError)


def test_build_provider_raises_unconfigured_for_placeholder() -> None:
    with pytest.raises(UnconfiguredProviderError):
        build_provider(PROVIDER_MODEL_TOKEN)


def test_build_provider_still_raises_value_error_for_garbage() -> None:
    """Invalid format hits the generic branch — not the unconfigured one."""
    with pytest.raises(ValueError) as exc_info:
        build_provider("notavalidformat")
    assert not isinstance(exc_info.value, UnconfiguredProviderError)


async def test_unconfigured_provider_chat_raises() -> None:
    p = UnconfiguredProvider(agent_name="openagentd")
    with pytest.raises(UnconfiguredProviderError) as exc_info:
        await p.chat([])
    assert "openagentd" in str(exc_info.value)


async def test_unconfigured_provider_stream_raises_on_first_anext() -> None:
    """Stream's error must fire during iteration, not at call-time.

    The agent loop attaches hooks around the iterator; an immediate
    raise would skip them and produce a generic traceback rather than
    routing through the loop's error path.
    """
    p = UnconfiguredProvider(agent_name="executor")
    iterator = p.stream([])
    with pytest.raises(UnconfiguredProviderError):
        await iterator.__anext__()


def test_loader_substitutes_unconfigured_stub(tmp_path) -> None:
    """An agent .md with the placeholder model loads with the stub provider."""
    from app.agent.loader import rebuild_agent_from_disk

    agent_md = tmp_path / "openagentd.md"
    agent_md.write_text(
        f"""---
name: openagentd
role: lead
description: Test agent.
model: {PROVIDER_MODEL_TOKEN}
tools: []
---

You are a test agent.
""",
        encoding="utf-8",
    )

    agent = rebuild_agent_from_disk(agent_md)
    assert agent is not None
    assert isinstance(agent.llm_provider, UnconfiguredProvider)
    # model_id carries the placeholder so the UI can show what's wrong.
    assert agent.model_id == PROVIDER_MODEL_TOKEN
