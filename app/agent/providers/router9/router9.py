"""9Router provider — OpenAI-compatible Chat Completions endpoint."""

from __future__ import annotations

from app.agent.providers.openai import ChatCompletionsOnlyProvider

# API reference: https://github.com/decolua/9router#-api-reference


class Router9Provider(ChatCompletionsOnlyProvider):
    """9Router provider.

    9Router exposes an OpenAI-compatible ``/chat/completions`` endpoint, but
    not OpenAI's ``/responses`` endpoint. Always route to chat completions,
    even when ``thinking_level`` or ``responses_api`` is set by session or
    agent config.
    """
