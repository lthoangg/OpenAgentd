"""DeepSeek Chat Completions API request schemas.

DeepSeek is OpenAI-compatible but has several wire differences:

- ``max_tokens`` only (rejects ``max_completion_tokens``).
- Thinking mode is controlled by a ``thinking`` object + ``reasoning_effort``,
  not ``reasoning_effort`` alone.
- Assistant messages that contained tool calls in a thinking-mode turn MUST
  echo ``reasoning_content`` back; omitting it returns a 400.

Reference: https://api-docs.deepseek.com/api/create-chat-completion
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from app.agent.providers.openai.schemas import (
    OpenAIStreamOptions,
    OpenAITool,
    OpenAIToolCall,
)


class DeepSeekMessage(BaseModel):
    """A single message in the DeepSeek conversation history (request).

    Extends the OpenAI message shape with ``reasoning_content`` on the
    assistant role.  DeepSeek requires this field to be present when an
    assistant turn contained tool calls and thinking mode was active —
    omitting it produces a 400.  Other providers never see this field
    because it lives in this DeepSeek-specific schema only.
    """

    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[dict[str, Any]] | None = None
    # assistant role only
    tool_calls: list[OpenAIToolCall] | None = None
    # assistant role only — must be echoed back when tool_calls were present
    # during a thinking-mode turn (DeepSeek returns 400 if omitted).
    reasoning_content: str | None = None
    # tool role only
    tool_call_id: str | None = None
    name: str | None = None


class DeepSeekThinking(BaseModel):
    """Controls thinking mode on/off."""

    type: Literal["enabled", "disabled"] = "enabled"


class DeepSeekChatRequest(BaseModel):
    """DeepSeek /chat/completions request body.

    Mirrors ``OpenAIChatRequest`` but uses ``DeepSeekMessage``,
    ``max_tokens`` only, and the DeepSeek-specific ``thinking`` +
    ``reasoning_effort`` fields.
    """

    model: str
    messages: list[DeepSeekMessage]
    tools: list[OpenAITool] | None = None
    max_tokens: int | None = None
    stream: bool = False
    stream_options: OpenAIStreamOptions | None = None
    # thinking mode — required alongside reasoning_effort to activate thinking
    thinking: DeepSeekThinking | None = None
    reasoning_effort: str | None = None
