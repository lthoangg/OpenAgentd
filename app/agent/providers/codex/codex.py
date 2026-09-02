"""OpenAI Codex provider — ChatGPT subscription-based access via OAuth.

Hits the Codex-specific Responses API endpoint used by the Codex CLI and
opencode, authenticating with a ChatGPT OAuth access token.

Endpoint:  https://chatgpt.com/backend-api/codex/responses
Auth:      Bearer {access_token} + ChatGPT-Account-Id header

Token resolution order:
    1. ``{CACHE_DIR}/codex_oauth.json`` (written by ``openagentd auth codex``)

Usage::

    # After running: openagentd auth codex
    provider = CodexProvider(model="gpt-5.4")
    msg = await provider.chat([HumanMessage(content="Hi")])
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from app.agent.providers.base import LLMProviderBase
from app.agent.providers.codex.catalog import (
    cached_codex_catalog,
    supports_reasoning_summary,
)
from app.agent.providers.codex.oauth import CODEX_ORIGINATOR, CodexOAuth
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatMessage,
    EncryptedReasoningItem,
    FunctionCall,
    SystemMessage,
    ToolCall,
    ToolMessage,
)
from app.agent.usage import Usage, provider_cost_model_id, usage_to_dict
from app.core.version import VERSION

CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
CODEX_STREAM_IDLE_TIMEOUT_SECONDS = 300.0
_NO_SERVICE_TIER = {"", "auto", "default", "none", "off", "standard"}
_NO_REASONING_SUMMARY_MODELS = {"gpt-5.3-codex-spark"}
# Sticky-routing token: the backend issues it on the first response of a turn
# and expects it echoed on every later request of that same turn
# (codex-rs/core/src/client.rs: `X_CODEX_TURN_STATE_HEADER`).
_TURN_STATE_HEADER = "x-codex-turn-state"

# Identify requests honestly as OpenAgentd.
_DEFAULT_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": f"openagentd/{VERSION}",
    "originator": CODEX_ORIGINATOR,
}


class _CodexResponsesHandler(ResponsesHandler):
    """ResponsesHandler variant for the Codex endpoint.

    The Codex endpoint requires a non-empty ``instructions`` field and rejects
    system messages embedded inside ``input``.  This subclass extracts any
    leading SystemMessage into ``instructions`` before building the request.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        # Sticky-routing token for the turn currently in flight, or None
        # between turns.  Scoped to a turn, never across turns.
        self._turn_state: str | None = None
        self._request_session_id: str | None = None
        summary_capability = supports_reasoning_summary(
            cached_codex_catalog(), self.model
        )
        self._supports_reasoning_summary = (
            summary_capability
            if summary_capability is not None
            else self.model not in _NO_REASONING_SUMMARY_MODELS
        )

    def convert_messages(self, messages: list[ChatMessage]) -> list[dict[str, Any]]:
        """Convert messages to Codex's stricter Responses item shape.

        Upstream Codex models message content as ``Vec<ContentItem>``. The
        ChatGPT Codex endpoint can intermittently reject plain string content,
        so text-only user turns are sent as explicit ``input_text`` items.
        User and assistant message items are tagged with ``type: "message"``.
        """
        items = super().convert_messages(messages)
        for item in items:
            role = item.get("role")
            if role in ("user", "assistant") and "type" not in item:
                item["type"] = "message"
            content = item.get("content")
            if role == "user" and isinstance(content, str):
                item["content"] = [{"type": "input_text", "text": content}]
        return items

    def customize_thinking(self, merged: dict[str, Any], body: dict[str, Any]) -> None:
        """Send effort and request readable summaries on supported Codex models."""
        thinking_level = merged.get("thinking_level")
        if thinking_level in ("none", "off"):
            body["reasoning"] = {"effort": "none"}
            return
        if not thinking_level:
            thinking_level = "medium"
        reasoning: dict[str, Any] = {"effort": thinking_level}
        if self._supports_reasoning_summary:
            reasoning["summary"] = "auto"
        body["reasoning"] = reasoning

    def build_request(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None,
        stream: bool,
        merged: dict[str, Any],
    ) -> dict[str, Any]:
        system_parts: list[str] = []
        non_system: list[ChatMessage] = []
        for msg in messages:
            if isinstance(msg, SystemMessage):
                if msg.content:
                    system_parts.append(msg.content)
            else:
                non_system.append(msg)

        # A turn starts with a user message and continues through tool results.
        # Anything that is not a tool result opens a new turn, so the previous
        # turn's sticky-routing token must not be replayed.
        if not non_system or not isinstance(non_system[-1], ToolMessage):
            self._turn_state = None

        body = super().build_request(non_system, tools, stream, merged)

        # Upstream ``ResponsesApiRequest`` (codex-rs/codex-api/src/common.rs)
        # has no token-cap field; the endpoint stalls when sent one.
        body.pop("max_output_tokens", None)

        instructions = "\n\n".join(system_parts)
        if instructions:
            body["instructions"] = instructions
        else:
            body.pop("instructions", None)

        body["store"] = False
        # Codex's Responses client sends these controls explicitly rather than
        # relying on backend defaults.
        body["tool_choice"] = merged.get("tool_choice", "auto")
        body["parallel_tool_calls"] = True
        session_id = merged.get("session_id")
        self._request_session_id = session_id if isinstance(session_id, str) else None
        # Me: upstream Codex CLI sends this unconditionally on every request
        # (codex-rs/core/src/client.rs: `let include = vec!["reasoning.encrypted_content"...]`)
        # regardless of store/service tier — required so `store: false` turns
        # keep reasoning continuity across tool calls instead of silently
        # dropping the reasoning item each turn.
        body["include"] = ["reasoning.encrypted_content"]

        # Codex's backend uses this stable conversation key to keep repeated
        # requests on the same prompt-cache route.  The generic Responses
        # handler supports it, but keep the intent explicit here because this
        # endpoint is not api.openai.com.
        prompt_cache_key = merged.get("prompt_cache_key")
        if prompt_cache_key is not None:
            body["prompt_cache_key"] = prompt_cache_key
        elif self._request_session_id:
            body["prompt_cache_key"] = self._request_session_id

        service_tier = str(merged.get("service_tier") or "").lower()
        if service_tier not in _NO_SERVICE_TIER:
            # Codex Fast mode is exposed as the request service tier.  The
            # official Codex config stores ``service_tier = "fast"``; the
            # backend maps that subscription setting to priority processing.
            body["service_tier"] = (
                "priority" if service_tier == "fast" else service_tier
            )
        return body

    def _prepare_request_headers(self, body: dict[str, Any]) -> dict[str, str]:
        """Attach Codex's routing headers for this Responses request."""
        model = str(body.get("model") or self.model)
        service_tier = body.get("service_tier")
        routing_hint = f"model={model}"
        if isinstance(service_tier, str) and service_tier:
            routing_hint += f";tier={service_tier}"
        headers = {**self.headers, "x-codex-routing-hint": routing_hint}
        if self._request_session_id:
            headers["session-id"] = self._request_session_id
        if self._turn_state:
            headers = {**headers, _TURN_STATE_HEADER: self._turn_state}
        return headers

    def on_response_headers(self, headers: Any) -> None:
        """Capture the turn-state token issued at the start of a turn.

        Upstream fixes the token on the first response of the turn and keeps
        sending that same value for the rest of it, so later responses must not
        overwrite it.
        """
        if self._turn_state:
            return
        try:
            value = headers.get(_TURN_STATE_HEADER)
        except AttributeError:
            return
        if isinstance(value, str) and value:
            self._turn_state = value

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict[str, Any]] | None,
        merged: dict[str, Any],
    ) -> AssistantMessage:
        """Return a final message using Codex's required streaming endpoint."""
        content = ""
        reasoning = ""
        reasoning_items: list[EncryptedReasoningItem] = []
        usage: Usage | None = None
        # Tool calls arrive as deltas keyed by index — a turn that only calls a
        # tool streams no content at all, so dropping them here would surface
        # the turn as an empty assistant message.
        calls: dict[int, ToolCall] = {}
        async for chunk in self.stream(messages, tools, merged):
            # Usage arrives on its own terminal chunk with no choices, so read it
            # before the choices guard below skips that chunk entirely.
            if chunk.usage is not None:
                usage = chunk.usage
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                content += delta.content
            if delta.reasoning_content:
                reasoning += delta.reasoning_content
            if delta.reasoning_encrypted_content:
                reasoning_items.append(
                    EncryptedReasoningItem(
                        id=delta.reasoning_item_id,
                        summary=delta.reasoning_item_summary or [],
                        encrypted_content=delta.reasoning_encrypted_content,
                    )
                )
            for tc in delta.tool_calls or []:
                index = tc.index if tc.index is not None else len(calls)
                call = calls.get(index)
                if call is None:
                    call = ToolCall(
                        id=tc.id or "", function=FunctionCall(name="", arguments="")
                    )
                    calls[index] = call
                if tc.id:
                    call.id = tc.id
                if tc.function is None:
                    continue
                if tc.function.name:
                    call.function.name = tc.function.name
                if tc.function.arguments:
                    call.function.arguments += tc.function.arguments
        extra: dict[str, Any] = {}
        if usage is not None:
            extra["usage"] = usage_to_dict(usage, provider_cost_model_id(self))
        if reasoning_items:
            extra["reasoning_items"] = [
                item.model_dump(exclude_none=True) for item in reasoning_items
            ]

        return AssistantMessage(
            content=content or None,
            reasoning_content=reasoning or None,
            reasoning_items=reasoning_items or None,
            tool_calls=[calls[index] for index in sorted(calls)] or None,
            extra=extra or None,
        )


def _load_token() -> tuple[str, str | None]:
    """Return (access_token, account_id) from cached oauth credentials.

    Refreshes the token if it is expired.
    Raises ValueError if no credentials are found.
    """
    oauth = CodexOAuth.load()
    if not oauth:
        raise ValueError(
            "Codex OAuth credentials not found. Run:\n"
            "  openagentd auth codex\n"
            "to authenticate with your ChatGPT account."
        )
    if oauth.is_expired():
        logger.info("codex_token_expired refreshing")
        try:
            oauth = oauth.refresh()
        except Exception as exc:
            raise ValueError(
                f"Codex token refresh failed: {exc}\nRun: openagentd auth codex"
            ) from exc
    return oauth.access_token.get_secret_value(), oauth.account_id


class CodexProvider(LLMProviderBase):
    """OpenAI Codex provider (ChatGPT subscription).

    Uses the Responses API endpoint at chatgpt.com, authenticated with a
    ChatGPT OAuth token obtained via ``openagentd auth codex``.

    Args:
        model: Model name, e.g. ``"gpt-5.4"``, ``"gpt-5.1-codex"``.
        max_tokens: Hard cap on completion tokens.
        model_kwargs: Extra request body fields passed as-is. Notable keys:
            ``service_tier="fast"`` — enable ChatGPT-subscription Codex Fast
            mode for supported models (GPT-5.5/GPT-5.4 at time of writing).
    """

    provider_name: str | None = "codex"

    def __init__(
        self,
        model: str,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

        access_token, account_id = _load_token()
        self.model = model

        headers = {
            **_DEFAULT_HEADERS,
            "Authorization": f"Bearer {access_token}",
        }
        if account_id:
            headers["ChatGPT-Account-ID"] = account_id

        self._responses = _CodexResponsesHandler(
            model,
            CODEX_API_BASE,
            headers,
            request_timeout=CODEX_STREAM_IDLE_TIMEOUT_SECONDS,
        )

        logger.debug("codex_provider model={}", model)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ) -> AssistantMessage:
        merged = self._merged_kwargs(**kwargs)
        self._responses.client = self.http_client
        return await self._responses.chat(messages, tools, merged)

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ):
        merged = self._merged_kwargs(**kwargs)
        self._responses.client = self.http_client
        async for chunk in self._responses.stream(messages, tools, merged):
            yield chunk
