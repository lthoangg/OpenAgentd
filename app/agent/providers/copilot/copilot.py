"""GitHub Copilot provider.

Subclass of :class:`OpenAIProvider` that delegates wire conversion,
streaming, and parsing to the canonical OpenAI handlers.

The Copilot gateway is OpenAI-compatible: messages, tools, and stream
events match the OpenAI Chat Completions and Responses formats. Only a
few facets differ:

* **Headers.** Copilot expects ``Openai-Intent``, ``x-initiator``, and a
  ``User-Agent`` alongside the OAuth bearer.
* **Per-model endpoint routing.** Endpoint preference is discovered from
  Copilot's live ``/models`` metadata when available, with a hardcoded
  fallback map for offline use.
* **Reasoning gating.** ``reasoning_effort`` (Chat Completions) is
  accepted only by a whitelisted subset of OpenAI models served via
  Copilot; Claude / Gemini / Grok reject it. Other reasoning fields
  flow through unchanged.

Token resolution order:

1. Explicit ``github_token`` constructor arg.
2. ``COPILOT_GITHUB_TOKEN``, ``GH_TOKEN``, or ``GITHUB_TOKEN`` env var
   (then legacy ``GITHUB_COPILOT_TOKEN``).
3. ``{CACHE_DIR}/copilot_oauth.json`` (written by ``openagentd auth copilot``).
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic.types import SecretStr

from app.agent.providers.copilot.oauth import CopilotOAuth, copilot_api_base
from app.agent.providers.openai.completions import CompletionsHandler
from app.agent.providers.openai.openai import OpenAIProvider
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import Usage
from app.core.version import VERSION

# This internal gateway is undocumented; public auth reference:
# https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate
COPILOT_API_BASE = "https://api.githubcopilot.com"
COPILOT_API_VERSION = "2026-06-01"

# Keep these headers aligned with opencode's GitHub Copilot plugin where possible.
# Source of truth to compare on upgrades:
# /tmp/opencode-src/packages/opencode/src/plugin/github-copilot/copilot.ts
_DEFAULT_HEADERS: dict[str, str] = {
    "Content-Type": "application/json",
    "User-Agent": f"opencode/{VERSION}",
    "Openai-Intent": "conversation-edits",
    "x-initiator": "user",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
}

_REASONING_EFFORT_MODELS: frozenset[str] = frozenset(
    {
        "gpt-5-mini",
        "gpt-5.1",
        "gpt-5.2",
        "gpt-5.4-mini",
    }
)

_MODEL_ENDPOINT_MAP: dict[str, str] = {
    "gpt-5-mini": "completions",
    "gpt-5.1": "completions",
    "gpt-5.2": "completions",
    "claude-sonnet-4": "completions",
    "claude-sonnet-4.5": "completions",
    "claude-opus-4.5": "completions",
    "claude-haiku-4.5": "completions",
    "gemini-3.1-pro-preview": "completions",
    "gemini-3-flash-preview": "completions",
    "gemini-2.5-pro": "completions",
    "grok-code-fast-1": "completions",
    "gpt-5.4-mini": "responses",
    "gpt-5.4": "responses",
    "gpt-5.2-codex": "responses",
    "gpt-5.3-codex": "responses",
}


def _oauth_context() -> tuple[str | None, dict[str, Any]]:
    oauth = CopilotOAuth.load()
    if oauth is None:
        return None, {}
    metadata = {
        "enterprise_url": oauth.enterprise_url,
        "api_base": copilot_api_base(oauth.enterprise_url),
    }
    return oauth.github_token.get_secret_value(), metadata


def _model_metadata(model: str) -> dict[str, Any] | None:
    return copilot_model_catalog().get(model)


def _endpoint_for_model(model: str) -> str:
    """Return ``"completions"`` or ``"responses"`` for ``model``."""
    metadata = _model_metadata(model)
    if metadata is not None:
        endpoints = metadata.get("supported_endpoints")
        if isinstance(endpoints, list):
            normalized = {
                str(item).lstrip("/") for item in endpoints if isinstance(item, str)
            }
            if "v1/responses" in normalized or "responses" in normalized:
                return "responses"
            if "v1/chat/completions" in normalized or "chat/completions" in normalized:
                return "completions"
    return _MODEL_ENDPOINT_MAP.get(model, "completions")


def _supports_reasoning_effort(model: str) -> bool:
    metadata = _model_metadata(model)
    if metadata is None:
        return model in _REASONING_EFFORT_MODELS
    supports = metadata.get("supports")
    if isinstance(supports, dict):
        efforts = supports.get("reasoning_effort")
        if isinstance(efforts, list):
            return len(efforts) > 0
    return model in _REASONING_EFFORT_MODELS


def _message_content_has_image(content: Any) -> bool:
    return isinstance(content, list) and any(
        isinstance(part, dict)
        and part.get("type") in {"image_url", "input_image", "image"}
        for part in content
    )


def _is_agent_initiated(
    messages: list[dict[str, Any]], *, responses_api: bool
) -> tuple[bool, bool]:
    """Mirror opencode's Copilot header heuristics.

    Source to compare when updating:
    /tmp/opencode-src/packages/opencode/src/plugin/github-copilot/copilot.ts
    """
    if not messages:
        return False, False

    if responses_api:
        is_vision = any(
            _message_content_has_image(item.get(key))
            for item in messages
            if isinstance(item, dict)
            for key in ("content", "output")
        )
        last = messages[-1]
        is_agent = last.get("role") != "user"
        return is_agent, is_vision

    is_vision = any(
        _message_content_has_image(item.get("content"))
        for item in messages
        if isinstance(item, dict)
    )
    last = messages[-1]
    is_agent = last.get("role") != "user"
    return is_agent, is_vision


def _resolve_github_token(
    explicit: str | SecretStr | None,
) -> tuple[str | None, dict[str, Any]]:
    """Resolve a GitHub token: explicit arg → oauth file → env var."""
    if explicit:
        return (
            explicit.get_secret_value()
            if isinstance(explicit, SecretStr)
            else explicit,
            {},
        )
    import os

    token = (
        os.getenv("COPILOT_GITHUB_TOKEN")
        or os.getenv("GH_TOKEN")
        or os.getenv("GITHUB_TOKEN")
        or os.getenv("GITHUB_COPILOT_TOKEN")
    )
    if token:
        enterprise_url = (
            os.getenv("COPILOT_ENTERPRISE_URL")
            or os.getenv("GH_ENTERPRISE_URL")
            or os.getenv("GITHUB_ENTERPRISE_URL")
        )
        metadata = {}
        if enterprise_url:
            metadata["enterprise_url"] = enterprise_url
            metadata["api_base"] = copilot_api_base(enterprise_url)
        return token, metadata
    return _oauth_context()


class _CopilotCompletionsHandler(CompletionsHandler):
    def _prepare_request_headers(self, body: dict[str, Any]) -> dict[str, str]:
        messages = body.get("messages") or []
        is_agent, is_vision = _is_agent_initiated(messages, responses_api=False)
        headers = dict(self.headers)
        headers["x-initiator"] = "agent" if is_agent else "user"
        if is_vision:
            headers["Copilot-Vision-Request"] = "true"
        return headers

    def customize_thinking(self, merged: dict[str, Any], body: dict[str, Any]) -> None:
        thinking_level = merged.get("thinking_level")
        if (
            thinking_level
            and thinking_level not in ("none", "off")
            and _supports_reasoning_effort(self.model)
        ):
            body["reasoning_effort"] = thinking_level

    def _usage_from_openai(self, u: Any) -> Usage:
        cached = None
        if u.prompt_tokens_details:
            cached = u.prompt_tokens_details.cached_tokens or None
        thoughts = getattr(u, "reasoning_tokens", None) or None
        if not thoughts and u.completion_tokens_details:
            thoughts = u.completion_tokens_details.reasoning_tokens or None
        return Usage(
            prompt_tokens=u.prompt_tokens,
            completion_tokens=u.completion_tokens,
            total_tokens=u.total_tokens,
            cached_tokens=cached,
            thoughts_tokens=thoughts,
        )


class _CopilotResponsesHandler(ResponsesHandler):
    def _prepare_request_headers(self, body: dict[str, Any]) -> dict[str, str]:
        items = body.get("input") or []
        is_agent, is_vision = _is_agent_initiated(items, responses_api=True)
        headers = dict(self.headers)
        headers["x-initiator"] = "agent" if is_agent else "user"
        if is_vision:
            headers["Copilot-Vision-Request"] = "true"
        return headers


class CopilotProvider(OpenAIProvider):
    """GitHub Copilot provider (OpenAI-compatible)."""

    def __init__(
        self,
        model: str,
        github_token: str | SecretStr | None = None,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ) -> None:
        token, metadata = _resolve_github_token(github_token)
        if not token:
            raise ValueError(
                "GitHub token not found.  Run:\n"
                "  openagentd auth copilot\n"
                "Or set COPILOT_GITHUB_TOKEN env var."
            )
        super().__init__(
            api_key=token,
            model=model,
            base_url=str(metadata.get("api_base") or COPILOT_API_BASE),
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

    @property
    def _github_token(self) -> str:
        return self.api_key

    @property
    def _endpoint_type(self) -> str:
        return "responses" if self._use_responses else "completions"

    @property
    def _request_url(self) -> str:
        return (
            f"{self.base_url}/"
            f"{'responses' if self._use_responses else 'chat/completions'}"
        )

    def _build_headers(self) -> dict[str, str]:
        # Keep base headers aligned with opencode's GitHub Copilot plugin.
        # Source of truth to compare on upgrades:
        # /tmp/opencode-src/packages/opencode/src/plugin/github-copilot/copilot.ts
        return {**_DEFAULT_HEADERS, "Authorization": f"Bearer {self.api_key}"}

    def _prepare_request_headers(self, body: dict[str, Any]) -> dict[str, str]:
        if "input" in body:
            items = body.get("input") or []
            is_agent, is_vision = _is_agent_initiated(items, responses_api=True)
        else:
            messages = body.get("messages") or []
            is_agent, is_vision = _is_agent_initiated(messages, responses_api=False)
        headers = dict(self._build_headers())
        headers["x-initiator"] = "agent" if is_agent else "user"
        if is_vision:
            headers["Copilot-Vision-Request"] = "true"
        return headers

    def _use_responses_for(self, model_kwargs: dict[str, Any]) -> bool:
        if "responses_api" in model_kwargs:
            return bool(model_kwargs["responses_api"])
        return _endpoint_for_model(self.model) == "responses"

    def _make_completions_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> CompletionsHandler:
        return _CopilotCompletionsHandler(model, base_url, headers)

    def _make_responses_handler(
        self, model: str, base_url: str, headers: dict[str, str]
    ) -> ResponsesHandler:
        return _CopilotResponsesHandler(model, base_url, headers)


def copilot_model_catalog() -> dict[str, dict[str, Any]]:
    """Return a normalized snapshot of Copilot `/models` metadata.

    This intentionally mirrors the shape opencode derives from the same
    endpoint, but keeps the contract Python-native for OpenAgentd.

    Source to compare when updating:
    /tmp/opencode-src/packages/opencode/src/plugin/github-copilot/models.ts
    """
    token, metadata = _resolve_github_token(None)
    if not token:
        return {}
    api_base = str(metadata.get("api_base") or COPILOT_API_BASE)
    try:
        response = httpx.get(
            f"{api_base}/models",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "User-Agent": _DEFAULT_HEADERS["User-Agent"],
                "X-GitHub-Api-Version": COPILOT_API_VERSION,
            },
            timeout=5.0,
        )
        response.raise_for_status()
    except Exception:
        return {}

    data = response.json()
    items = data.get("data", []) if isinstance(data, dict) else []
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str):
            continue

        caps_raw = item.get("capabilities")
        caps: dict[str, Any] = caps_raw if isinstance(caps_raw, dict) else {}
        limits_raw = caps.get("limits")
        limits: dict[str, Any] = limits_raw if isinstance(limits_raw, dict) else {}
        supports_raw = caps.get("supports")
        supports: dict[str, Any] = (
            supports_raw if isinstance(supports_raw, dict) else {}
        )
        vision_limits_raw = limits.get("vision")
        vision_limits: dict[str, Any] = (
            vision_limits_raw if isinstance(vision_limits_raw, dict) else {}
        )
        endpoints = (
            item.get("supported_endpoints")
            if isinstance(item.get("supported_endpoints"), list)
            else []
        )
        policy_raw = item.get("policy")
        policy: dict[str, Any] = policy_raw if isinstance(policy_raw, dict) else {}
        billing_raw = item.get("billing")
        billing: dict[str, Any] = billing_raw if isinstance(billing_raw, dict) else {}
        token_prices_raw = billing.get("token_prices")
        token_prices: dict[str, Any] = (
            token_prices_raw if isinstance(token_prices_raw, dict) else {}
        )
        default_prices_raw = token_prices.get("default")
        default_prices: dict[str, Any] = (
            default_prices_raw if isinstance(default_prices_raw, dict) else {}
        )

        image_media = [
            m
            for m in vision_limits.get("supported_media_types", [])
            if isinstance(m, str)
        ]
        supports_reasoning = bool(
            supports.get("adaptive_thinking")
            or supports.get("reasoning_effort")
            or supports.get("max_thinking_budget") is not None
            or supports.get("min_thinking_budget") is not None
        )
        uses_messages_api = "/v1/messages" in endpoints

        release_date = item.get("version")
        if isinstance(release_date, str) and release_date.startswith(f"{model_id}-"):
            release_date = release_date[len(model_id) + 1 :]

        result[model_id] = {
            "id": model_id,
            "name": item.get("name") if isinstance(item.get("name"), str) else model_id,
            "family": caps.get("family")
            if isinstance(caps.get("family"), str)
            else model_id,
            "release_date": release_date if isinstance(release_date, str) else None,
            "supported_endpoints": endpoints,
            "policy_state": policy.get("state")
            if isinstance(policy.get("state"), str)
            else None,
            "model_picker_enabled": bool(item.get("model_picker_enabled")),
            "uses_messages_api": uses_messages_api,
            "limits": {
                "context": limits.get("max_context_window_tokens")
                or limits.get("max_prompt_tokens"),
                "input": limits.get("max_prompt_tokens"),
                "output": limits.get("max_output_tokens"),
            },
            "supports": {
                "tool_calls": supports.get("tool_calls") is True,
                "streaming": supports.get("streaming") is True,
                "structured_outputs": supports.get("structured_outputs") is True,
                "vision": bool(
                    supports.get("vision")
                    or any(m.startswith("image/") for m in image_media)
                ),
                "reasoning": supports_reasoning,
                "reasoning_effort": [
                    v
                    for v in supports.get("reasoning_effort", [])
                    if isinstance(v, str)
                ],
                "adaptive_thinking": supports.get("adaptive_thinking") is True,
                "max_thinking_budget": supports.get("max_thinking_budget")
                if isinstance(supports.get("max_thinking_budget"), int)
                else None,
                "min_thinking_budget": supports.get("min_thinking_budget")
                if isinstance(supports.get("min_thinking_budget"), int)
                else None,
            },
            "pricing": {
                "batch_size": token_prices.get("batch_size")
                if isinstance(token_prices.get("batch_size"), (int, float))
                else None,
                "input_price": default_prices.get("input_price")
                if isinstance(default_prices.get("input_price"), (int, float))
                else None,
                "output_price": default_prices.get("output_price")
                if isinstance(default_prices.get("output_price"), (int, float))
                else None,
                "cache_price": default_prices.get("cache_price")
                if isinstance(default_prices.get("cache_price"), (int, float))
                else None,
            },
            "restricted_to": [
                v for v in billing.get("restricted_to", []) if isinstance(v, str)
            ],
        }
    return result
