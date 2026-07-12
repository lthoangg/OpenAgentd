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
from app.agent.providers.codex.oauth import CODEX_ORIGINATOR, CodexOAuth
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import AssistantMessage, ChatMessage, SystemMessage

CODEX_API_BASE = "https://chatgpt.com/backend-api/codex"
CODEX_STREAM_IDLE_TIMEOUT_SECONDS = 10.0
_NO_SERVICE_TIER = {"", "auto", "default", "none", "off", "standard"}

# Identify requests honestly as OpenAgentd.
_DEFAULT_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "openagentd/1.0.0",
    "originator": CODEX_ORIGINATOR,
}


class _CodexResponsesHandler(ResponsesHandler):
    """ResponsesHandler variant for the Codex endpoint.

    The Codex endpoint requires a non-empty ``instructions`` field and rejects
    system messages embedded inside ``input``.  This subclass extracts any
    leading SystemMessage into ``instructions`` before building the request.
    """

    def convert_messages(self, messages: list[ChatMessage]) -> list[dict[str, Any]]:
        """Convert messages to Codex's stricter Responses item shape.

        Upstream Codex models message content as ``Vec<ContentItem>``. The
        ChatGPT Codex endpoint can intermittently reject plain string content,
        so text-only user turns are sent as explicit ``input_text`` items.
        """
        items = super().convert_messages(messages)
        for item in items:
            content = item.get("content")
            if item.get("role") == "user" and isinstance(content, str):
                item["content"] = [{"type": "input_text", "text": content}]
        return items

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

        body = super().build_request(non_system, tools, stream, merged)

        # Upstream ``ResponsesApiRequest`` (codex-rs/codex-api/src/common.rs)
        # has no token-cap field; the endpoint stalls when sent one.
        body.pop("max_output_tokens", None)

        body["instructions"] = "\n\n".join(system_parts)
        body["store"] = False
        # Me: upstream Codex CLI sends this unconditionally on every request
        # (codex-rs/core/src/client.rs: `let include = vec!["reasoning.encrypted_content"...]`)
        # regardless of store/service tier — required so `store: false` turns
        # keep reasoning continuity across tool calls instead of silently
        # dropping the reasoning item each turn.
        body["include"] = ["reasoning.encrypted_content"]

        service_tier = str(merged.get("service_tier") or "").lower()
        if service_tier not in _NO_SERVICE_TIER:
            # Codex Fast mode is exposed as the request service tier.  The
            # official Codex config stores ``service_tier = "fast"``; the
            # backend maps that subscription setting to priority processing.
            body["service_tier"] = (
                "priority" if service_tier == "fast" else service_tier
            )
        return body

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict[str, Any]] | None,
        merged: dict[str, Any],
    ) -> AssistantMessage:
        """Return a final message using Codex's required streaming endpoint."""
        content = ""
        reasoning = ""
        reasoning_item_id: str | None = None
        reasoning_encrypted_content: str | None = None
        async for chunk in self.stream(messages, tools, merged):
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if delta.content:
                content += delta.content
            if delta.reasoning_content:
                reasoning += delta.reasoning_content
            if delta.reasoning_encrypted_content:
                reasoning_item_id = delta.reasoning_item_id
                reasoning_encrypted_content = delta.reasoning_encrypted_content
        return AssistantMessage(
            content=content or None,
            reasoning_content=reasoning or None,
            reasoning_item_id=reasoning_item_id,
            reasoning_encrypted_content=reasoning_encrypted_content,
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
        return await self._responses.chat(messages, tools, merged)

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs: Any,
    ):
        merged = self._merged_kwargs(**kwargs)
        async for chunk in self._responses.stream(messages, tools, merged):
            yield chunk
