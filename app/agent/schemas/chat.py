"""Internal chat message and provider delta schemas.

These types are used by agents, providers, and hooks.
They are NOT part of the public API — see app/schemas/events.py for that.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal, Self, Union
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# ── Multimodal content blocks ─────────────────────────────────────────────────


class ImageUrlBlock(BaseModel):
    """Me image from URL — provider fetches it."""

    type: Literal["image_url"] = "image_url"
    # Me URL or data URI (data:image/jpeg;base64,...)
    url: str
    media_type: str | None = None
    detail: Literal["auto", "low", "high"] | None = None


class ImageDataBlock(BaseModel):
    """Me raw base64 image bytes — inline in request."""

    type: Literal["image_data"] = "image_data"
    data: str  # Me base64-encoded bytes
    media_type: str  # Me e.g. "image/jpeg", "image/png", "image/webp"


class TextBlock(BaseModel):
    """Me plain text part of a multimodal message."""

    type: Literal["text"] = "text"
    text: str


# Me union for all content block types
ContentBlock = Annotated[
    Union[TextBlock, ImageUrlBlock, ImageDataBlock],
    Field(discriminator="type"),
]


# ── Structured tool result ────────────────────────────────────────────────────


@dataclass
class ToolResult:
    """Structured return value for tools that produce multimodal output.

    When a tool returns a ``ToolResult`` instead of a plain string, the agent
    loop populates ``ToolMessage.parts`` directly.  ``ToolMessage.content`` is
    derived from the ``TextBlock`` items in *parts* (for DB persistence and
    non-multimodal code paths).

    Tools that only produce text should keep returning a plain ``str`` — this
    class is opt-in for multimodal scenarios (images, PDFs, documents).
    """

    parts: list[ContentBlock]
    mcp_app: dict[str, Any] | None = None


class Usage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int | None = None
    # Prompt tokens written into the provider's cache this call. Billed at a
    # premium over fresh input (Anthropic: 1.25x), so it is tracked apart from
    # both ``prompt_tokens`` and the far cheaper ``cached_tokens`` reads.
    cache_write_tokens: int | None = None
    thoughts_tokens: int | None = None
    tool_use_tokens: int | None = None


class FunctionCall(BaseModel):
    name: str
    arguments: str
    thought: bool | str | None = None
    thought_signature: str | None = None


class ToolCall(BaseModel):
    id: str
    type: Literal["function"] = "function"
    function: FunctionCall


class FunctionCallDelta(BaseModel):
    name: str | None = None
    arguments: str | None = None
    thought: bool | str | None = None
    thought_signature: str | None = None


class ToolCallDelta(BaseModel):
    index: int | None = None
    id: str | None = None
    type: Literal["function"] | None = "function"
    function: FunctionCallDelta | None = None


class BaseMessage(BaseModel):
    content: str | None = None
    # Me: internal flags — never sent to LLM provider
    exclude_from_context: bool = Field(default=False, exclude=True)
    is_summary: bool = Field(default=False, exclude=True)
    # Row kind mirror of ``SessionMessage.kind`` (chat | note | queued |
    # summary | reverted). ``is_summary`` is kept as a convenience alias —
    # the validator below keeps the two in sync in both directions.
    kind: str = Field(default="chat", exclude=True)
    # Position-independent LLM membership (mirror of ``SessionMessage.pinned``):
    # retained skill tool pairs and permanent internal notes survive
    # compaction. Managed by SummarizationHook, persisted by the checkpointer.
    pinned: bool = Field(default=False, exclude=True)
    extra: dict | None = Field(default=None, exclude=True)
    db_id: UUID | None = Field(default=None, exclude=True)
    model_config = ConfigDict(extra="ignore")

    @model_validator(mode="after")
    def _sync_summary_kind(self) -> Self:
        if self.is_summary and self.kind == "chat":
            self.kind = "summary"
        elif self.kind == "summary":
            self.is_summary = True
        return self

    def model_dump_full(self, *, exclude_none: bool = True) -> dict:
        """Dump all fields including exclude=True ones — use for DB persistence and telemetry.

        Providers must use ``model_dump(exclude_none=True)`` which drops internal
        fields via ``Field(exclude=True)``.  This method bypasses that by reading
        all ``model_fields`` directly from the instance and serializing recursively.

        ``db_id`` is always omitted — it is an ORM PK never needed outside checkpointer.
        """
        # Me: pydantic v2 Field(exclude=True) cannot be bypassed via model_dump().
        # Read fields directly from the instance and serialize pydantic models recursively.
        d: dict = {}
        for name, field_info in type(self).model_fields.items():
            if name == "db_id":
                continue  # Me: ORM PK — never needed in full dump
            val = getattr(self, name, None)
            if exclude_none and val is None:
                continue
            # Me: serialize nested pydantic models to dict
            if isinstance(val, BaseModel):
                val = val.model_dump(exclude_none=exclude_none)
            elif isinstance(val, list):
                val = [
                    v.model_dump(exclude_none=exclude_none)
                    if isinstance(v, BaseModel)
                    else v
                    for v in val
                ]
            d[name] = val
        return d


class SystemMessage(BaseMessage):
    role: Literal["system"] = "system"


class HumanMessage(BaseMessage):
    role: Literal["user"] = "user"
    # Me multimodal: list of content blocks (text + images).
    # When set, providers use this instead of content (str).
    # content (str) stays for backward compat and plain-text fallback.
    # exclude=True: providers read parts directly as an attribute — never via model_dump()
    # so raw base64 bytes never leak into generic serialization paths.
    parts: list[ContentBlock] | None = Field(default=None, exclude=True)

    def text_content(self) -> str | None:
        """Me extract plain text — from parts if multimodal, else content."""
        if self.parts:
            texts = [p.text for p in self.parts if isinstance(p, TextBlock)]
            return " ".join(texts) if texts else self.content
        return self.content

    def is_multimodal(self) -> bool:
        """Me true if message has image parts."""
        if not self.parts:
            return False
        return any(isinstance(p, (ImageUrlBlock, ImageDataBlock)) for p in self.parts)


class AssistantMessage(BaseMessage):
    role: Literal["assistant"] = "assistant"
    # Me: receive-only — provider sends this, but no API accepts it back
    reasoning_content: str | None = Field(default=None, exclude=True)
    # Me: Anthropic requires the opaque signature to be round-tripped with
    # thinking blocks in history; store it alongside reasoning_content.
    reasoning_signature: str | None = Field(default=None, exclude=True)
    # Me: Anthropic redacted_thinking blocks must be echoed verbatim in history.
    # Each entry is the raw block dict: {"type": "redacted_thinking", "data": "..."}.
    redacted_thinking_blocks: list[dict] | None = Field(default=None, exclude=True)
    # Me: Anthropic adaptive/interleaved thinking can emit multiple thinking
    # blocks per turn, each immediately preceding the tool_use it justifies.
    # The API requires the exact original content-block order to be replayed
    # verbatim in history (HTTP 400 otherwise) — reconstructing a canonical
    # "thinking, then text, then all tool calls" order (as the legacy
    # reasoning_content/redacted_thinking_blocks fields above do) reorders
    # multi-thinking-block turns and breaks the contract. When captured, this
    # holds the ordered raw block list, verbatim: thinking/redacted_thinking/
    # text dicts as returned, plus a ``{"type": "tool_use_ref", "id": ...}``
    # placeholder resolved against ``tool_calls`` at send time — reusing the
    # already-validated tool call list instead of re-parsing streamed JSON
    # (see ``_split_messages`` / ``_blocks_from_raw_content``).
    raw_content_blocks: list[dict] | None = Field(default=None, exclude=True)
    # Me: OpenAI Responses API reasoning item id + encrypted_content — required
    # to replay the reasoning item ahead of its function_call on the next turn
    # (see codex-rs client.rs: `include: ["reasoning.encrypted_content"]` is
    # sent unconditionally and the whole reasoning item is replayed verbatim).
    # Without this, stateless (store=false) multi-turn tool calls lose reasoning
    # continuity.
    reasoning_item_id: str | None = Field(default=None, exclude=True)
    reasoning_encrypted_content: str | None = Field(default=None, exclude=True)
    tool_calls: list[ToolCall] | None = None

    # Me: agent tracking — internal only, never sent to provider
    agent_id: str | None = Field(default=None, exclude=True)
    agent_name: str | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def _sync_reasoning_extra(self) -> Self:
        if self.reasoning_encrypted_content:
            if self.extra is None:
                self.extra = {}
            self.extra["reasoning_encrypted_content"] = self.reasoning_encrypted_content
            if self.reasoning_item_id:
                self.extra["reasoning_item_id"] = self.reasoning_item_id
        elif self.extra and "reasoning_encrypted_content" in self.extra:
            encrypted = self.extra["reasoning_encrypted_content"]
            if isinstance(encrypted, str) and encrypted:
                self.reasoning_encrypted_content = encrypted
            item_id = self.extra.get("reasoning_item_id")
            if isinstance(item_id, str) and item_id:
                self.reasoning_item_id = item_id
        return self


class ToolMessage(BaseMessage):
    role: Literal["tool"] = "tool"
    tool_call_id: str
    name: str | None = None
    # Me multimodal: content blocks (images, text) from ToolResult-returning tools.
    # When set, providers send these parts directly to the LLM.
    # content (str) is derived from TextBlock items for DB persistence only.
    # exclude=True: providers read parts directly — never via model_dump().
    parts: list[ContentBlock] | None = Field(default=None, exclude=True)


ChatMessage = Annotated[
    Union[SystemMessage, HumanMessage, AssistantMessage, ToolMessage],
    Field(discriminator="role"),
]


# ── Provider delta (internal streaming format) ────────────────────────────────


class ChatCompletionDelta(BaseModel):
    """A single streaming delta from a provider."""

    role: str | None = None
    content: str | None = None
    # Me: ZAI may send reasoning_content as int (token count) in final chunk — accept and discard
    reasoning_content: str | None = None
    # Me: Anthropic opaque signature for thinking blocks — must be stored and
    # round-tripped in history; surfaced here so callers can persist it.
    reasoning_signature: str | None = None
    # Me: Anthropic redacted_thinking block received during streaming — the full
    # block dict must be stored verbatim and replayed in history (HTTP 400 if modified).
    redacted_thinking_block: dict | None = None
    # Me: Anthropic — the fully assembled, ordered raw content-block list for
    # the turn (see AssistantMessage.raw_content_blocks). Anthropic-specific
    # providers emit this once, after the stream completes.
    anthropic_raw_blocks: list[dict] | None = None
    # Me: OpenAI Responses API reasoning item id + encrypted_content, delivered
    # once when the reasoning output item completes (not incremental text).
    reasoning_item_id: str | None = None
    reasoning_encrypted_content: str | None = None

    @field_validator("reasoning_content", mode="before")
    @classmethod
    def _coerce_reasoning(cls, v: object) -> str | None:
        if isinstance(v, str):
            return v
        return None  # Me drop non-string values (e.g. int token count from ZAI)

    tool_calls: list[ToolCallDelta] | None = None


class ChatCompletionChunkChoice(BaseModel):
    index: int
    delta: ChatCompletionDelta
    finish_reason: str | None = None


class ChatCompletionChunk(BaseModel):
    """Internal streaming chunk produced by providers and consumed by hooks."""

    id: str
    created: int
    model: str
    choices: list[ChatCompletionChunkChoice]
    usage: Usage | None = None
    # Set by the streaming hook to identify which agent produced this chunk
    agent_name: str | None = None
