"""Ollama provider — OpenAI-compatible API.

Ollama exposes an OpenAI-compatible ``/v1/chat/completions`` endpoint on
the local daemon at ``http://localhost:11434/v1``. This single endpoint
serves both locally-pulled models *and* hosted Ollama Cloud models —
cloud models are routed transparently when the model name carries the
``-cloud`` suffix (e.g. ``kimi-k2.6-cloud``) and the user has signed in
via ``ollama signin``.

There is no separate cloud HTTPS endpoint. ``ollama.com`` exposes only
its native (non-OpenAI) API at ``/api/chat``; the OpenAI compatibility
layer lives only on the local daemon.

Endpoint:  http://localhost:11434/v1 (override via ``OLLAMA_BASE_URL``)
Auth:      None — the provider supplies a placeholder key only because the
           OpenAI SDK requires a non-empty ``Authorization`` header.
Docs:      https://docs.ollama.com/api/openai
Cloud:     https://docs.ollama.com/cloud (run ``ollama signin`` first)

Usage::

    model: ollama:llama3.2
    model: ollama:qwen2.5-coder:7b
    model: ollama:kimi-k2.6-cloud      # routed to Ollama Cloud
    model: ollama:gpt-oss:120b-cloud   # routed to Ollama Cloud
"""

from __future__ import annotations

from typing import Any

from pydantic.types import SecretStr

from app.agent.providers.openai import OpenAIProvider

OLLAMA_LOCAL_API_BASE = "http://localhost:11434/v1"


class OllamaProvider(OpenAIProvider):
    """Ollama provider (OpenAI-compatible).

    Defaults to the standard local daemon at ``http://localhost:11434/v1``.
    Pass ``base_url`` to point at a remote Ollama instance. Cloud models
    are accessed through the same daemon by appending ``-cloud`` to the
    model name (e.g. ``kimi-k2.6-cloud``); run ``ollama signin`` once to
    authenticate.

    Args:
        api_key: Ignored by the daemon, but the OpenAI SDK requires
            *some* value. Defaults to ``"ollama"`` if blank.
        model: Model name as listed by ``ollama list`` (e.g. ``"llama3.2"``,
            ``"qwen2.5-coder:7b"``, ``"kimi-k2.6-cloud"``).
        base_url: Override the default local URL.
        max_tokens: Hard cap on completion tokens.
        model_kwargs: Extra request body fields passed as-is.
    """

    def __init__(
        self,
        api_key: str | SecretStr | None = None,
        model: str = "",
        base_url: str = OLLAMA_LOCAL_API_BASE,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        # The daemon requires no auth, but the OpenAI client mandates a
        # non-empty Authorization header. Fall back to "ollama" when the
        # caller passed an empty string.
        resolved_key = (
            api_key.get_secret_value() if isinstance(api_key, SecretStr) else api_key
        )
        if not resolved_key:
            resolved_key = "ollama"
        super().__init__(
            api_key=resolved_key,
            model=model,
            base_url=base_url,
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        # Ollama exposes the OpenAI-compatible chat-completions endpoint only.
        return False
