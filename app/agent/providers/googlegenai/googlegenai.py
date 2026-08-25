import json
import time
from typing import Any

from loguru import logger
from pydantic.types import SecretStr

from app.agent.usage import provider_cost_model_id, usage_to_dict
from app.agent.providers.base import LLMProviderBase
from app.agent.schemas.chat import (
    AssistantMessage,
    ChatCompletionChunk,
    ChatCompletionChunkChoice,
    ChatCompletionDelta,
    ChatMessage,
    FunctionCallDelta,
    HumanMessage,
    SystemMessage,
    ToolCall,
    ToolCallDelta,
    ToolMessage,
    Usage,
)
from app.agent.schemas.chat import (
    FunctionCall as ChatFunctionCall,
)

from app.agent.providers.streaming import iter_sse_data
from app.agent.schemas.chat import ImageDataBlock, ImageUrlBlock, TextBlock

from .schemas import (
    Content,
    FileData,
    FunctionCall,
    FunctionCallingConfig,
    FunctionDeclaration,
    FunctionResponse,
    GeminiChatRequest,
    GeminiChatResponse,
    GenerationConfig,
    InlineData,
    Part,
    ThinkingConfig,
    Tool,
    ToolConfig,
)

# GenerateContent REST API: https://ai.google.dev/api/generate-content
API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class GeminiProviderBase(LLMProviderBase):
    """
    Shared message conversion and HTTP logic for Gemini-compatible endpoints.
    Subclasses must set `self.base_url`, `self.model`, and implement `_auth_headers()`.
    """

    support_interrupt: bool = False
    base_url: str
    model: str

    def _auth_headers(self) -> dict[str, str]:
        raise NotImplementedError

    def _build_url(self, method: str) -> str:
        raise NotImplementedError

    def _convert_messages_to_gemini(
        self, messages: list[ChatMessage]
    ) -> tuple[list[Content], Content | None]:
        contents = []
        system_instruction = None

        for msg in messages:
            if isinstance(msg, SystemMessage):
                system_instruction = Content(parts=[Part(text=msg.content)])
            elif isinstance(msg, HumanMessage):
                if msg.parts:
                    # Me build multimodal parts for Gemini
                    gemini_parts: list[Part] = []
                    for part in msg.parts:
                        if isinstance(part, TextBlock):
                            gemini_parts.append(Part(text=part.text))
                        elif isinstance(part, ImageDataBlock):
                            gemini_parts.append(
                                Part(
                                    inline_data=InlineData(
                                        mime_type=part.media_type, data=part.data
                                    )
                                )
                            )
                        elif isinstance(part, ImageUrlBlock):
                            # Me Gemini supports HTTP/HTTPS URLs via file_data
                            # data: URIs must be sent as inline_data
                            url = part.url
                            if url.startswith("data:"):
                                # Me parse data URI: data:<mime>;base64,<data>
                                header, b64data = url.split(",", 1)
                                mime = header.split(":")[1].split(";")[0]
                                gemini_parts.append(
                                    Part(
                                        inline_data=InlineData(
                                            mime_type=mime, data=b64data
                                        )
                                    )
                                )
                            else:
                                mime = part.media_type or "image/jpeg"
                                gemini_parts.append(
                                    Part(
                                        file_data=FileData(mime_type=mime, file_uri=url)
                                    )
                                )
                    contents.append(Content(role="user", parts=gemini_parts))
                else:
                    contents.append(
                        Content(role="user", parts=[Part(text=msg.content)])
                    )
            elif isinstance(msg, AssistantMessage):
                parts = []

                if msg.content:
                    if msg.tool_calls:
                        # When tool calls are present, accompanying text represents reasoning/pre-call notes.
                        # In Gemini API, non-thought text preceding function calls violates turn order.
                        parts.append(Part(text=msg.content, thought=True))
                    else:
                        parts.append(Part(text=msg.content))

                if msg.tool_calls:
                    for tc in msg.tool_calls:
                        args = tc.function.arguments
                        if isinstance(args, str):
                            try:
                                args = json.loads(args)
                            except (json.JSONDecodeError, TypeError):
                                args = {}
                        elif not isinstance(args, dict):
                            args = {}

                        if tc.function.thought:
                            parts.append(
                                Part(text=str(tc.function.thought), thought=True)
                            )

                        thought_sig = (
                            tc.function.thought_signature
                            or msg.reasoning_signature
                            or None
                        )
                        parts.append(
                            Part(
                                function_call=FunctionCall(
                                    name=tc.function.name,
                                    args=args,
                                    id=tc.id if not tc.id.startswith("call_") else None,
                                ),
                                thought_signature=thought_sig,
                            )
                        )
                elif msg.reasoning_content:
                    parts.append(
                        Part(
                            text=msg.reasoning_content,
                            thought=True,
                            thought_signature=msg.reasoning_signature or None,
                        )
                    )

                if not parts:
                    continue
                contents.append(Content(role="model", parts=parts))
            elif isinstance(msg, ToolMessage):
                try:
                    tool_result = (
                        json.loads(msg.content)
                        if msg.content
                        else {"result": "No content"}
                    )
                except (json.JSONDecodeError, TypeError):
                    tool_result = {"result": msg.content}

                if not isinstance(tool_result, dict):
                    tool_result = {"result": tool_result}

                tool_parts: list[Part] = [
                    Part(
                        function_response=FunctionResponse(
                            name=msg.name or "unknown",
                            response=tool_result,
                            id=msg.tool_call_id,
                        )
                    )
                ]

                # Me multimodal tool result — append image/text parts alongside
                # the FunctionResponse so Gemini sees them in the same turn
                if msg.parts:
                    for part in msg.parts:
                        if isinstance(part, TextBlock):
                            tool_parts.append(Part(text=part.text))
                        elif isinstance(part, ImageDataBlock):
                            tool_parts.append(
                                Part(
                                    inline_data=InlineData(
                                        mime_type=part.media_type, data=part.data
                                    )
                                )
                            )
                        elif isinstance(part, ImageUrlBlock):
                            url = part.url
                            if url.startswith("data:"):
                                header, b64data = url.split(",", 1)
                                mime = header.split(":")[1].split(";")[0]
                                tool_parts.append(
                                    Part(
                                        inline_data=InlineData(
                                            mime_type=mime, data=b64data
                                        )
                                    )
                                )
                            else:
                                mime = part.media_type or "image/jpeg"
                                tool_parts.append(
                                    Part(
                                        file_data=FileData(mime_type=mime, file_uri=url)
                                    )
                                )

                contents.append(Content(role="user", parts=tool_parts))

        # Merge consecutive messages with the same role ONLY if they are compatible turn types.
        # Specifically, Gemini API strictly differentiates between:
        # 1. User prompt turns (text/multimodal parts)
        # 2. Function response turns (FunctionResponse parts)
        # Mixing FunctionResponse and Text in the same role="user" Content block creates an invalid
        # hybrid turn that causes HTTP 400 ("function call turn comes immediately after a user turn or after a function response turn").
        merged_contents: list[Content] = []
        for content in contents:
            if not merged_contents:
                merged_contents.append(content)
                continue
            prev = merged_contents[-1]
            if prev.role == content.role:
                prev_has_fn = any(p.function_response is not None for p in prev.parts)
                curr_has_fn = any(
                    p.function_response is not None for p in content.parts
                )
                if prev_has_fn == curr_has_fn:
                    merged_contents[-1] = Content(
                        role=content.role,
                        parts=list(prev.parts) + list(content.parts),
                    )
                    continue
            else:
                merged_contents.append(content)
                continue
            merged_contents.append(content)

        return merged_contents, system_instruction

    # Me fields that Gemini's function declaration schema does not support.
    # Passing them causes a 400 INVALID_ARGUMENT from the API.
    _UNSUPPORTED_SCHEMA_KEYS: frozenset[str] = frozenset(
        {
            "discriminator",
            "const",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "additionalProperties",
            "$schema",
            "$id",
            "$ref",
            "contentEncoding",
            "contentMediaType",
        }
    )

    def _sanitize_schema(self, schema: Any) -> Any:
        """Recursively strip JSON Schema keys unsupported by the Gemini API."""
        if isinstance(schema, dict):
            return {
                k: self._sanitize_schema(v)
                for k, v in schema.items()
                if k not in self._UNSUPPORTED_SCHEMA_KEYS
            }
        if isinstance(schema, list):
            return [self._sanitize_schema(item) for item in schema]
        return schema

    def _convert_tools_to_gemini(
        self, tools: list[dict[str, Any]] | None
    ) -> list[Tool] | None:
        if not tools:
            return None

        declarations = []
        for t in tools:
            if t.get("type") == "function":
                f = t["function"]
                raw_params = f.get("parameters")
                params = self._sanitize_schema(raw_params) if raw_params else None
                declarations.append(
                    FunctionDeclaration(
                        name=f["name"],
                        description=f.get("description", ""),
                        parameters=params,
                    )
                )

        return [Tool(function_declarations=declarations)] if declarations else None

    def _build_generation_config(self, **kwargs: Any) -> GenerationConfig:
        thinking_level = kwargs.get("thinking_level")
        # "none" disables thinking entirely; omit ThinkingConfig so the model
        # uses its default (no active reasoning budget).
        thinking_config = (
            None
            if thinking_level == "none" or "gemma" in self.model.lower()
            else ThinkingConfig(include_thoughts=True, thinking_level=thinking_level)
        )
        return GenerationConfig(
            max_output_tokens=kwargs.get("max_tokens"),
            thinking_config=thinking_config,
        )

    async def chat(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ) -> AssistantMessage:
        merged = self._merged_kwargs(**kwargs)
        contents, system_instruction = self._convert_messages_to_gemini(messages)
        gemini_tools = self._convert_tools_to_gemini(tools)
        generation_config = self._build_generation_config(**merged)

        service_tier = merged.get("service_tier")
        if service_tier == "fast":
            service_tier = "priority"

        # Translate tool_choice="none" to Gemini's tool_config NONE mode.
        # Only set when tools are present — the API ignores tool_config
        # without a tools list, but keeping the guard makes intent clear.
        tool_config: ToolConfig | None = None
        if gemini_tools and merged.get("tool_choice") == "none":
            tool_config = ToolConfig(
                function_calling_config=FunctionCallingConfig(mode="NONE")
            )

        request = GeminiChatRequest(
            contents=contents,
            system_instruction=system_instruction,
            generation_config=generation_config,
            tools=gemini_tools,
            tool_config=tool_config,
            service_tier=service_tier,
        )

        url = self._build_url("generateContent")

        async with self._http_client_context() as client:
            request_body = request.model_dump(exclude_none=True, by_alias=True)
            response = await client.post(
                url,
                headers=self._auth_headers(),
                json=request_body,
                timeout=120.0,
            )
            response.raise_for_status()
            data = response.json()

        gemini_resp = GeminiChatResponse.model_validate(data)
        if not gemini_resp.candidates:
            raise ValueError("Gemini API response contained no candidates")
        candidate = gemini_resp.candidates[0]
        content = ""
        reasoning = ""
        tool_calls = []

        reasoning_signature = ""
        for part in candidate.content.parts:
            if part.thought:
                if part.text:
                    reasoning += part.text
                if part.thought_signature:
                    reasoning_signature += part.thought_signature
            elif part.text:
                content += part.text
            if part.function_call:
                tool_calls.append(
                    ToolCall(
                        id=part.function_call.id
                        or f"call_{part.function_call.name}_{int(time.time())}",
                        function=ChatFunctionCall(
                            name=part.function_call.name,
                            arguments=json.dumps(part.function_call.args),
                            thought_signature=part.thought_signature,
                        ),
                    )
                )

        usage = None
        if gemini_resp.usage_metadata is not None:
            meta = gemini_resp.usage_metadata
            usage = Usage(
                prompt_tokens=meta.prompt_token_count or 0,
                completion_tokens=meta.candidates_token_count or 0,
                total_tokens=meta.total_token_count or 0,
                cached_tokens=meta.cached_content_token_count,
                thoughts_tokens=meta.thoughts_token_count,
                tool_use_tokens=meta.tool_use_prompt_token_count,
            )

        extra: dict | None = (
            {"usage": usage_to_dict(usage, provider_cost_model_id(self))}
            if usage
            else None
        )
        if reasoning_signature:
            extra = extra or {}
            extra["reasoning_signature"] = reasoning_signature
        return AssistantMessage(
            content=content if content else None,
            reasoning_content=reasoning if reasoning else None,
            reasoning_signature=reasoning_signature or None,
            tool_calls=tool_calls if tool_calls else None,
            extra=extra,
        )

    async def stream(
        self,
        messages: list[ChatMessage],
        tools: list[dict] | None = None,
        **kwargs,
    ):
        merged = self._merged_kwargs(**kwargs)
        contents, system_instruction = self._convert_messages_to_gemini(messages)
        gemini_tools = self._convert_tools_to_gemini(tools)
        generation_config = self._build_generation_config(**merged)

        service_tier = merged.get("service_tier")
        if service_tier == "fast":
            service_tier = "priority"

        tool_config: ToolConfig | None = None
        if gemini_tools and merged.get("tool_choice") == "none":
            tool_config = ToolConfig(
                function_calling_config=FunctionCallingConfig(mode="NONE")
            )

        request = GeminiChatRequest(
            contents=contents,
            system_instruction=system_instruction,
            generation_config=generation_config,
            tools=gemini_tools,
            tool_config=tool_config,
            service_tier=service_tier,
        )

        url = self._build_url("streamGenerateContent") + "?alt=sse"

        async with self._http_client_context() as client:
            request_body = request.model_dump(exclude_none=True, by_alias=True)
            async with client.stream(
                "POST",
                url,
                headers=self._auth_headers(),
                json=request_body,
                timeout=120.0,
            ) as response:
                if response.status_code >= 400:
                    body = await response.aread()
                    logger.warning(
                        "gemini_api_error status={} model={} body={}",
                        response.status_code,
                        self.model,
                        body.decode("utf-8", errors="replace"),
                    )
                response.raise_for_status()
                # Me map tool_call id → stable monotonic index, scoped to
                # this stream() call.  Each Gemini SSE chunk is a complete
                # snapshot of the candidate's `parts`, so using the part
                # index directly causes collisions when parts re-arrange
                # between chunks (e.g. a `thought` part appearing/disappearing
                # shifts every downstream function_call by one slot).  The
                # agent_loop tool_calls_buffer keys by (id, idx); a shifting
                # idx makes it merge the wrong delta into an existing slot
                # and emit a second, never-completed tool_call SSE event.
                # Track id → idx once and reuse so the buffer sees stable
                # slots regardless of intra-chunk part ordering.
                #
                # Me each Gemini SSE chunk is a full snapshot, not a delta —
                # the same function_call (same id, same args) is re-emitted
                # verbatim in every subsequent chunk until the stream ends.
                # The generic accumulator in streaming.py appends each chunk's
                # args to the buffer, so a re-emitted chunk doubles the JSON
                # and breaks validation.  Suppress args (and name) on every
                # chunk after the first for a given tool call id so the
                # accumulator receives exactly one copy.
                tool_idx_by_id: dict[str, int] = {}
                tool_args_emitted: set[str] = set()

                async for data in iter_sse_data(response, sentinel=None):
                    gemini_resp = GeminiChatResponse.model_validate(data)

                    if not gemini_resp.candidates:
                        continue

                    candidate = gemini_resp.candidates[0]
                    delta_content = ""
                    delta_reasoning = ""
                    delta_tool_calls: list[ToolCallDelta] = []

                    delta_reasoning_signature = ""
                    for part in candidate.content.parts:
                        if part.thought:
                            if part.text:
                                delta_reasoning += part.text
                            if part.thought_signature:
                                delta_reasoning_signature += part.thought_signature
                        elif part.text:
                            delta_content += part.text
                        if part.function_call:
                            fc_id = (
                                part.function_call.id
                                or f"call_{part.function_call.name}_{int(time.time())}"
                            )
                            # Me first-seen id wins a fresh slot; duplicates
                            # reuse the same idx so the agent_loop buffer
                            # treats re-emitted snapshots as continuations
                            # rather than new tool calls.
                            stable_idx = tool_idx_by_id.setdefault(
                                fc_id, len(tool_idx_by_id)
                            )
                            first_emission = fc_id not in tool_args_emitted
                            if first_emission:
                                tool_args_emitted.add(fc_id)
                            delta_tool_calls.append(
                                ToolCallDelta(
                                    index=stable_idx,
                                    id=fc_id,
                                    function=FunctionCallDelta(
                                        name=part.function_call.name
                                        if first_emission
                                        else None,
                                        arguments=json.dumps(part.function_call.args)
                                        if first_emission
                                        else None,
                                        thought_signature=part.thought_signature,
                                    ),
                                )
                            )

                    meta = gemini_resp.usage_metadata
                    usage = (
                        Usage(
                            prompt_tokens=meta.prompt_token_count or 0,
                            completion_tokens=meta.candidates_token_count or 0,
                            total_tokens=meta.total_token_count or 0,
                            cached_tokens=meta.cached_content_token_count,
                            thoughts_tokens=meta.thoughts_token_count,
                            tool_use_tokens=meta.tool_use_prompt_token_count,
                        )
                        if meta
                        else None
                    )

                    yield ChatCompletionChunk(
                        id="gemini-stream",
                        created=int(time.time()),
                        model=self.model,
                        choices=[
                            ChatCompletionChunkChoice(
                                index=0,
                                delta=ChatCompletionDelta(
                                    content=delta_content if delta_content else None,
                                    reasoning_content=delta_reasoning
                                    if delta_reasoning
                                    else None,
                                    reasoning_signature=delta_reasoning_signature
                                    if delta_reasoning_signature
                                    else None,
                                    tool_calls=delta_tool_calls
                                    if delta_tool_calls
                                    else None,
                                ),
                                finish_reason=candidate.finish_reason,
                            )
                        ],
                        usage=usage,
                    )


class GoogleGenAIProvider(GeminiProviderBase):
    """
    Gemini Developer API (generativelanguage.googleapis.com).
    Authenticates with a Google AI Studio API key via x-goog-api-key header.
    """

    def __init__(
        self,
        api_key: str | SecretStr,
        model: str,
        base_url: str = API_BASE_URL,
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ):
        super().__init__(
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

        resolved_key = (
            api_key.get_secret_value() if isinstance(api_key, SecretStr) else api_key
        )
        if not resolved_key:
            raise ValueError(
                "Google API key is required. Provide it or set GOOGLE_API_KEY."
            )

        self.api_key = resolved_key
        self.model = model
        self.base_url = base_url.rstrip("/")

    def _auth_headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self.api_key}

    def _build_url(self, method: str) -> str:
        return f"{self.base_url}/models/{self.model}:{method}"
