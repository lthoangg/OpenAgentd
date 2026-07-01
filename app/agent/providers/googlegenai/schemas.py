from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class GeminiBaseModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )


class FunctionCall(GeminiBaseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    id: str | None = None


class FunctionResponse(GeminiBaseModel):
    name: str
    response: dict[str, Any]
    id: str | None = None


class InlineData(GeminiBaseModel):
    """Me raw bytes image inline in Gemini request."""

    mime_type: str
    data: str  # Me base64-encoded


class FileData(GeminiBaseModel):
    """Me image from URL for Gemini (HTTP/HTTPS)."""

    mime_type: str
    file_uri: str


class Part(GeminiBaseModel):
    text: str | None = None
    thought: bool | None = None
    thought_signature: str | None = None
    function_call: FunctionCall | None = None
    function_response: FunctionResponse | None = None
    inline_data: InlineData | None = None
    file_data: FileData | None = None


class Content(GeminiBaseModel):
    role: Literal["user", "model"] | None = None
    parts: list[Part] = Field(default_factory=list)
    thought_signature: str | None = None


class ThinkingConfig(GeminiBaseModel):
    include_thoughts: bool = True
    thinking_level: str | None = None


class GenerationConfig(GeminiBaseModel):
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    max_output_tokens: int | None = None
    stop_sequences: list[str] | None = None
    thinking_config: ThinkingConfig | None = None


class FunctionDeclaration(GeminiBaseModel):
    name: str
    description: str
    parameters: dict[str, Any] | None = None


class Tool(GeminiBaseModel):
    function_declarations: list[FunctionDeclaration] | None = None


class GeminiChatRequest(GeminiBaseModel):
    contents: list[Content]
    system_instruction: Content | None = None
    generation_config: GenerationConfig | None = None
    tools: list[Tool] | None = None
    service_tier: str | None = None


class Candidate(GeminiBaseModel):
    content: Content = Field(default_factory=lambda: Content(parts=[]))
    finish_reason: str | None = None
    index: int = 0


class UsageMetadata(GeminiBaseModel):
    prompt_token_count: int = 0
    candidates_token_count: int = 0
    total_token_count: int = 0
    cached_content_token_count: int | None = None
    thoughts_token_count: int | None = None
    tool_use_prompt_token_count: int | None = None


class GeminiChatResponse(GeminiBaseModel):
    candidates: list[Candidate] = Field(default_factory=list)
    usage_metadata: UsageMetadata | None = None
