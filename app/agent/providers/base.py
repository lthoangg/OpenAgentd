from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any

from app.agent.schemas.chat import AssistantMessage, ChatCompletionChunk, ChatMessage


class LLMProviderBase(ABC):
    """Abstract base class for LLM providers.

    Each provider translates between the canonical chat schemas
    (ChatMessage, AssistantMessage, ChatCompletionChunk) and its own
    API format internally. Callers only ever deal with canonical types.

    ``max_tokens`` is an explicit, typed constructor argument.
    ``model_kwargs`` accepts provider-specific extras (e.g.
    ``thinking_level``).  Per-call ``**kwargs`` passed to
    ``chat()``/``stream()`` have the highest priority and override
    everything.

    Priority (lowest → highest): named params → model_kwargs → call kwargs.

    ``support_interrupt`` controls whether the agent loop may abort an
    in-flight stream when the interrupt event fires.  Set to ``False``
    for providers whose streaming connections are stateful or quota-tracked
    (e.g. proxy-based providers) so the current LLM call always completes
    before the loop checks for interruption.
    """

    model: str
    provider_name: str | None = None
    support_interrupt: bool = True

    def __init__(
        self,
        *,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ):
        self.max_tokens = max_tokens
        self.model_kwargs = model_kwargs or {}

    def _merged_kwargs(self, **call_kwargs: Any) -> dict[str, Any]:
        """Merge provider-level defaults with per-call overrides.

        Priority (lowest → highest): named params → model_kwargs → call_kwargs.
        """
        base: dict[str, Any] = {}
        if self.max_tokens is not None:
            base["max_tokens"] = self.max_tokens
        return {**base, **self.model_kwargs, **call_kwargs}

    @abstractmethod
    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        """Call the LLM and return the final AssistantMessage."""
        ...

    @abstractmethod
    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AsyncIterator[ChatCompletionChunk]:
        """Call the LLM and yield ChatCompletionChunk objects as they arrive."""
        ...
