"""OpenAI Chat Completions API request/response schemas.

These are provider-specific wire types used internally by OpenAIProvider.
They are NOT part of the public API — canonical types live in app.schemas.chat.

Reference: https://platform.openai.com/docs/api-reference/chat
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class OpenAIFunctionCall(BaseModel):
    name: str
    arguments: str  # JSON-encoded string


class OpenAIToolCall(BaseModel):
    id: str
    type: Literal["function"] = "function"
    function: OpenAIFunctionCall


class OpenAIMessage(BaseModel):
    """A single message in the conversation history (request)."""

    role: Literal["system", "user", "assistant", "tool"]
    # Me string for text-only; list[dict] for multimodal content parts
    content: str | list[dict[str, Any]] | None = None
    # assistant role only
    tool_calls: list[OpenAIToolCall] | None = None
    # tool role only
    tool_call_id: str | None = None
    name: str | None = None


class OpenAIFunction(BaseModel):
    name: str
    description: str = ""
    parameters: dict[str, Any] | None = None


class OpenAITool(BaseModel):
    type: Literal["function"] = "function"
    function: OpenAIFunction


class OpenAIStreamOptions(BaseModel):
    """Options for streaming responses."""

    include_usage: bool = False


class OpenAIChatRequest(BaseModel):
    model: str
    messages: list[OpenAIMessage]
    tools: list[OpenAITool] | None = None
    # OpenAI's reasoning-capable models (o-series, gpt-5*, gpt-5.4*) reject
    # the legacy ``max_tokens`` field with a 400 ``unsupported_parameter`` —
    # they require ``max_completion_tokens`` instead.  Both fields are
    # declared optional and mutually exclusive at the request-build layer
    # (``CompletionsHandler.build_request`` picks one based on the
    # ``uses_max_completion_tokens`` class flag, which OpenAI subclasses
    # may flip to retain legacy ``max_tokens`` semantics — see
    # ``providers/xai`` and ``providers/deepseek``).
    #
    # We do NOT collapse to a single canonical field because the OpenAI
    # docs explicitly state ``max_tokens`` is deprecated for new models
    # but kept for backwards compatibility, and several OpenAI-compatible
    # endpoints (xAI Grok, Deepseek) only accept the legacy name.
    max_tokens: int | None = None
    max_completion_tokens: int | None = None
    prompt_cache_key: str | None = None
    stream: bool = False
    stream_options: OpenAIStreamOptions | None = None
    service_tier: str | None = None


# ---------------------------------------------------------------------------
# Usage schemas (shared between streaming and non-streaming)
# ---------------------------------------------------------------------------


class OpenAIPromptTokensDetails(BaseModel):
    """Breakdown of prompt tokens. OpenAI returns this sub-object for cached-token reporting."""

    model_config = ConfigDict(extra="ignore")

    cached_tokens: int = 0
    audio_tokens: int = 0


class OpenAICompletionTokensDetails(BaseModel):
    """Breakdown of completion tokens (reasoning tokens for o-series)."""

    model_config = ConfigDict(extra="ignore")

    reasoning_tokens: int = 0
    audio_tokens: int = 0
    accepted_prediction_tokens: int = 0
    rejected_prediction_tokens: int = 0


class OpenAIUsage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    prompt_tokens_details: OpenAIPromptTokensDetails | None = None
    completion_tokens_details: OpenAICompletionTokensDetails | None = None
    # Copilot puts reasoning_tokens at top level (not inside completion_tokens_details)
    reasoning_tokens: int | None = None


# ---------------------------------------------------------------------------
# Non-streaming response schemas
# ---------------------------------------------------------------------------


class OpenAIResponseMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: str
    content: str | None = None
    # Non-standard field: only present on some OpenAI-compatible providers (e.g. DeepSeek).
    reasoning_content: str | None = None
    # Copilot Chat Completions returns reasoning_text
    reasoning_text: str | None = None
    tool_calls: list[OpenAIToolCall] | None = None
    refusal: str | None = None


class OpenAIChoice(BaseModel):
    model_config = ConfigDict(extra="ignore")

    index: int
    message: OpenAIResponseMessage
    finish_reason: str | None = None


class OpenAIChatResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    created: int | None = None  # some OpenAI-compatible providers omit this
    model: str
    choices: list[OpenAIChoice] = Field(default_factory=list)
    usage: OpenAIUsage | None = None


# ---------------------------------------------------------------------------
# Streaming response schemas
# ---------------------------------------------------------------------------


class OpenAIFunctionCallDelta(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str | None = None
    arguments: str | None = None


class OpenAIToolCallDelta(BaseModel):
    model_config = ConfigDict(extra="ignore")

    index: int
    id: str | None = None
    type: Literal["function"] | None = None
    function: OpenAIFunctionCallDelta | None = None


class OpenAIStreamDelta(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: str | None = None
    content: str | None = None
    # Non-standard: present on some compatible providers for reasoning traces.
    reasoning_content: str | None = None
    # Copilot Chat Completions returns reasoning_text
    reasoning_text: str | None = None
    tool_calls: list[OpenAIToolCallDelta] | None = None
    refusal: str | None = None


class OpenAIStreamChoice(BaseModel):
    model_config = ConfigDict(extra="ignore")

    index: int
    delta: OpenAIStreamDelta
    finish_reason: str | None = None


class OpenAIStreamChunk(BaseModel):
    """A single SSE chunk from a streaming chat completion response."""

    model_config = ConfigDict(extra="ignore")

    id: str
    created: int
    model: str
    choices: list[OpenAIStreamChoice] = Field(default_factory=list)
    # Populated in the final chunk when stream_options.include_usage = True
    usage: OpenAIUsage | None = None
