"""Placeholder provider used when an agent has no real model configured.

Legacy/generated agents and custom templates may carry the literal token
``__PROVIDER_MODEL__`` in their ``model:`` frontmatter until the user picks a
provider and model in the UI. New installations use a concrete default model;
the token is retained only for backwards compatibility and custom agent
templates. Before that selection, ``build_provider`` cannot resolve the token
to a real backend — historically this raised ``ValueError`` at load time and
crashed the whole agent manager.

With this stub the loader still constructs an :class:`Agent` instance,
but routes any LLM call to :class:`UnconfiguredProvider` which raises
:class:`UnconfiguredProviderError`. The agent session's turn runner
catches that specific error type and emits a typed SSE
:class:`AgentNotConfiguredEvent` so the UI can render a "configure a
provider" banner instead of a generic stack trace.

See ``app.core.config.PROVIDER_MODEL_TOKEN`` for the canonical sentinel.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ChatMessage


class UnconfiguredProviderError(ValueError):
    """Raised when an agent tries to call an LLM but has no usable provider.

    Subclass of ``ValueError`` for backwards compatibility — older
    callers that catch ``ValueError`` from :func:`build_provider` keep
    working. New callers should catch this type to distinguish
    "user hasn't picked a provider yet" from "user typed garbage".
    """

    def __init__(
        self, agent_name: str | None = None, message: str | None = None
    ) -> None:
        self.agent_name = agent_name
        super().__init__(
            message
            or (
                f"Agent '{agent_name or '?'}' has no model configured. "
                f"Open Settings → Providers in the UI to add a provider and select a model."
            )
        )


class UnconfiguredProvider(LLMProviderBase):
    """Stub provider that raises :class:`UnconfiguredProviderError` on use.

    Constructed by the loader when an agent's ``model:`` is still the
    ``__PROVIDER_MODEL__`` placeholder. Lets the rest of the agent
    machinery (loading, registration, listing) continue to work — the
    failure is deferred to the first actual LLM call.
    """

    # ``model`` is required by the base class for telemetry / logging.
    # Use the literal sentinel so logs make it obvious why a call failed.
    model: str = "__unconfigured__"

    def __init__(self, agent_name: str | None = None) -> None:
        super().__init__()
        self._agent_name = agent_name

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        raise UnconfiguredProviderError(self._agent_name)

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatCompletionChunk]:
        # ``stream`` is synchronous and returns an async iterator. To
        # surface the error to ``async for`` consumers we need to return
        # an iterator whose first ``__anext__`` raises — bare ``raise``
        # here would fire at call-time and skip the agent loop's hooks.
        async def _raise() -> AsyncIterator[ChatCompletionChunk]:
            raise UnconfiguredProviderError(self._agent_name)
            yield  # pragma: no cover — unreachable, here to make this a generator

        return _raise()
