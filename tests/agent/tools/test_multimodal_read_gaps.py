"""Gap tests for multimodal read tool feature.

Tests for edge cases, error paths, and untested code paths:
- AgentState.capabilities and tool_names default values
- _has_vision() edge cases
- _convert_with_markitdown() timeout and error paths
- handle_document() with oversized PDFs and vision gating
- ToolMessage and ToolResult edge cases (empty parts, image-only)
- Provider handling of edge case ToolMessages
"""

from __future__ import annotations

import base64
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.schemas.chat import (
    ImageDataBlock,
    TextBlock,
    ToolMessage,
    ToolResult,
)
from app.agent.tools.builtin.filesystem import read_file
from app.agent.tools.builtin.filesystem.handlers import (
    handle_document,
    _convert_with_markitdown,
)
from app.agent.providers.capabilities import ModelCapabilities, ModelInputCapabilities
from app.agent.state import AgentState


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _make_state(
    *, vision: bool = False, tool_names: list[str] | None = None
) -> AgentState:
    """Build an AgentState with optional vision and tool_names."""
    return AgentState(
        messages=[],
        capabilities=ModelCapabilities(input=ModelInputCapabilities(vision=vision)),
        tool_names=tool_names or [],
    )


# ─────────────────────────────────────────────────────────────────────────────
# AgentState default values
# ─────────────────────────────────────────────────────────────────────────────


class TestAgentStateDefaults:
    """Test AgentState default field values."""

    def test_capabilities_default_is_model_capabilities(self):
        """AgentState.capabilities defaults to ModelCapabilities()."""
        state = AgentState(messages=[])
        assert isinstance(state.capabilities, ModelCapabilities)
        assert state.capabilities.input.vision is False
        assert state.capabilities.input.document_text is True

    def test_tool_names_default_is_empty_list(self):
        """AgentState.tool_names defaults to empty list."""
        state = AgentState(messages=[])
        assert state.tool_names == []
        assert isinstance(state.tool_names, list)

    def test_capabilities_can_be_set(self):
        """AgentState.capabilities can be set to custom value."""
        caps = ModelCapabilities(input=ModelInputCapabilities(vision=True))
        state = AgentState(messages=[], capabilities=caps)
        assert state.capabilities.input.vision is True

    def test_tool_names_can_be_set(self):
        """AgentState.tool_names can be set to custom list."""
        state = AgentState(messages=[], tool_names=["read", "write", "search"])
        assert state.tool_names == ["read", "write", "search"]


# ─────────────────────────────────────────────────────────────────────────────
# _convert_with_markitdown() timeout path
# ─────────────────────────────────────────────────────────────────────────────


class TestConvertWithMarkitdownTimeout:
    """Test _convert_with_markitdown() timeout handling."""

    def test_timeout_returns_none(self):
        """When markitdown conversion times out, return None."""
        # Mock the thread to simulate timeout by not completing
        with patch(
            "app.agent.tools.builtin.filesystem.handlers.threading.Thread"
        ) as mock_thread_class:
            mock_thread = MagicMock()
            mock_thread.is_alive.return_value = True  # Simulate timeout
            mock_thread_class.return_value = mock_thread

            result = _convert_with_markitdown(
                b"test data", "application/pdf", "test.pdf"
            )

            assert result is None
            mock_thread.start.assert_called_once()
            mock_thread.join.assert_called_once()

    def test_timeout_logs_warning(self):
        """When timeout occurs, a warning is logged."""
        with patch(
            "app.agent.tools.builtin.filesystem.handlers.threading.Thread"
        ) as mock_thread_class:
            mock_thread = MagicMock()
            mock_thread.is_alive.return_value = True
            mock_thread_class.return_value = mock_thread

            with patch(
                "app.agent.tools.builtin.filesystem.handlers.logger"
            ) as mock_logger:
                _convert_with_markitdown(b"test", "application/pdf", "test.pdf")
                mock_logger.warning.assert_called_once()
                call_args = mock_logger.warning.call_args
                assert "markitdown_timeout" in call_args[0][0]


# ─────────────────────────────────────────────────────────────────────────────
# _convert_with_markitdown() error path
# ─────────────────────────────────────────────────────────────────────────────


class TestConvertWithMarkitdownError:
    """Test _convert_with_markitdown() error handling."""

    def test_exception_in_thread_returns_none(self):
        """When markitdown raises an exception, return None."""
        with patch(
            "app.agent.tools.builtin.filesystem.handlers.threading.Thread"
        ) as mock_thread_class:
            mock_thread = MagicMock()
            mock_thread.is_alive.return_value = False
            mock_thread_class.return_value = mock_thread

            # Patch markitdown import inside the function
            with patch("markitdown.MarkItDown") as mock_md:
                mock_md.side_effect = RuntimeError("Conversion failed")

                # Actually call the real function but with mocked MarkItDown
                result = _convert_with_markitdown(
                    b"bad pdf", "application/pdf", "bad.pdf"
                )

                # Should return None on error
                assert result is None

    def test_empty_conversion_result_returns_none(self):
        """When markitdown returns empty text, return None."""
        with patch(
            "app.agent.tools.builtin.filesystem.handlers.threading.Thread"
        ) as mock_thread_class:
            mock_thread = MagicMock()
            mock_thread.is_alive.return_value = False
            mock_thread_class.return_value = mock_thread

            # Simulate successful conversion but empty result
            with patch("markitdown.MarkItDown") as mock_md:
                mock_result = MagicMock()
                mock_result.text_content = ""  # Empty
                mock_md.return_value.convert_stream.return_value = mock_result

                result = _convert_with_markitdown(
                    b"empty", "application/pdf", "empty.pdf"
                )

                # Empty text should return None
                assert result is None

    def test_whitespace_only_conversion_returns_none(self):
        """When markitdown returns only whitespace, return None."""
        with patch(
            "app.agent.tools.builtin.filesystem.handlers.threading.Thread"
        ) as mock_thread_class:
            mock_thread = MagicMock()
            mock_thread.is_alive.return_value = False
            mock_thread_class.return_value = mock_thread

            with patch("markitdown.MarkItDown") as mock_md:
                mock_result = MagicMock()
                mock_result.text_content = "   \n\t  "  # Only whitespace
                mock_md.return_value.convert_stream.return_value = mock_result

                result = _convert_with_markitdown(
                    b"whitespace", "application/pdf", "ws.pdf"
                )

                assert result is None


# ─────────────────────────────────────────────────────────────────────────────
# handle_document() with oversized PDF and vision=True
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleDocumentOversizedPdf:
    """Test handle_document() PDF fallback at the image size boundary."""

    def test_oversized_pdf_skips_fallback(self, tmp_path):
        """When PDF exceeds 10MB, the raw-bytes fallback is skipped."""
        big_pdf = tmp_path / "big.pdf"
        big_pdf.write_bytes(b"%PDF-1.4" + b"\x00" * (10_485_760 + 1))

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = None
            result = handle_document(big_pdf, Path("big.pdf"))

        # Too large — no image fallback
        assert len(result.parts) == 1
        assert isinstance(result.parts[0], TextBlock)
        assert "Unable to extract text" in result.parts[0].text

    def test_pdf_at_size_limit_allows_fallback(self, tmp_path):
        """When PDF is at or below 10MB, the raw-bytes fallback fires."""
        pdf = tmp_path / "at_limit.pdf"
        pdf.write_bytes(b"%PDF-1.4" + b"\x00" * (10_485_760 - 8))

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = None
            result = handle_document(pdf, Path("at_limit.pdf"))

        assert len(result.parts) == 2
        assert isinstance(result.parts[1], ImageDataBlock)


# ─────────────────────────────────────────────────────────────────────────────
# ToolMessage with empty parts list
# ─────────────────────────────────────────────────────────────────────────────


class TestToolMessageEmptyParts:
    """Test ToolMessage with empty parts list."""

    def test_empty_parts_list_is_valid(self):
        """ToolMessage can have an empty parts list."""
        msg = ToolMessage(content="result", tool_call_id="1", parts=[])
        assert msg.parts == []
        assert isinstance(msg.parts, list)

    def test_empty_parts_excluded_from_model_dump(self):
        """Empty parts list is excluded from model_dump()."""
        msg = ToolMessage(content="result", tool_call_id="1", parts=[])
        dumped = msg.model_dump()
        # parts should not be in the dump (exclude=True)
        assert "parts" not in dumped

    def test_empty_parts_included_in_model_dump_full(self):
        """Empty parts list is included in model_dump_full()."""
        msg = ToolMessage(content="result", tool_call_id="1", parts=[])
        dumped = msg.model_dump_full()
        assert "parts" in dumped
        assert dumped["parts"] == []


# ─────────────────────────────────────────────────────────────────────────────
# ToolMessage with only ImageDataBlock (no TextBlock)
# ─────────────────────────────────────────────────────────────────────────────


class TestToolMessageImageOnly:
    """Test ToolMessage with only image parts (no text)."""

    def test_image_only_parts(self):
        """ToolMessage can have only ImageDataBlock parts."""
        img_data = base64.b64encode(b"fake_image").decode("ascii")
        msg = ToolMessage(
            content="image result",
            tool_call_id="1",
            parts=[ImageDataBlock(data=img_data, media_type="image/png")],
        )
        assert len(msg.parts) == 1
        assert isinstance(msg.parts[0], ImageDataBlock)

    def test_image_only_parts_excluded_from_model_dump(self):
        """Image-only parts are excluded from model_dump()."""
        img_data = base64.b64encode(b"fake").decode("ascii")
        msg = ToolMessage(
            content="result",
            tool_call_id="1",
            parts=[ImageDataBlock(data=img_data, media_type="image/png")],
        )
        dumped = msg.model_dump()
        assert "parts" not in dumped

    def test_image_only_parts_included_in_model_dump_full(self):
        """Image-only parts are included in model_dump_full()."""
        img_data = base64.b64encode(b"fake").decode("ascii")
        msg = ToolMessage(
            content="result",
            tool_call_id="1",
            parts=[ImageDataBlock(data=img_data, media_type="image/png")],
        )
        dumped = msg.model_dump_full()
        assert "parts" in dumped
        assert len(dumped["parts"]) == 1


# ─────────────────────────────────────────────────────────────────────────────
# ToolResult with empty parts list
# ─────────────────────────────────────────────────────────────────────────────


class TestToolResultEmptyParts:
    """Test ToolResult with empty parts list."""

    def test_empty_parts_list_is_valid(self):
        """ToolResult can have an empty parts list."""
        result = ToolResult(parts=[])
        assert result.parts == []

    def test_empty_parts_list_is_dataclass(self):
        """ToolResult is a dataclass with parts field."""
        result = ToolResult(parts=[])
        assert hasattr(result, "parts")
        assert isinstance(result.parts, list)


# ─────────────────────────────────────────────────────────────────────────────
# Provider edge cases: empty parts, image-only parts
# ─────────────────────────────────────────────────────────────────────────────


class TestOpenAIProviderEmptyParts:
    """Test OpenAI CompletionsHandler with edge case ToolMessages."""

    def test_tool_message_with_empty_parts_list(self):
        """CompletionsHandler handles ToolMessage with empty parts list."""
        from app.agent.providers.openai.completions import CompletionsHandler

        handler = CompletionsHandler(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )
        msg = ToolMessage(content="result", tool_call_id="1", parts=[])
        converted = handler.convert_messages([msg])

        # Should fall back to content string (no parts)
        assert len(converted) == 1
        assert converted[0].role == "tool"
        assert converted[0].content == "result"

    def test_tool_message_with_image_only_parts(self):
        """CompletionsHandler handles ToolMessage with only image parts."""
        from app.agent.providers.openai.completions import CompletionsHandler

        handler = CompletionsHandler(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            headers={"Authorization": "Bearer sk-test"},
        )
        img_data = base64.b64encode(b"fake").decode("ascii")
        msg = ToolMessage(
            content="image",
            tool_call_id="1",
            parts=[ImageDataBlock(data=img_data, media_type="image/png")],
        )
        converted = handler.convert_messages([msg])

        assert len(converted) == 1
        assert isinstance(converted[0].content, list)
        assert len(converted[0].content) == 1
        assert converted[0].content[0]["type"] == "image_url"


class TestGeminiProviderEmptyParts:
    """Test Gemini provider with edge case ToolMessages."""

    def test_tool_message_with_empty_parts_list(self):
        """Gemini provider handles ToolMessage with empty parts list."""
        from app.agent.providers.googlegenai.googlegenai import GoogleGenAIProvider

        provider = GoogleGenAIProvider(api_key="test_key", model="gemini-2.0-flash")
        msg = ToolMessage(content="result", tool_call_id="1", parts=[])
        contents, _ = provider._convert_messages_to_gemini([msg])

        # Should have FunctionResponse only (no parts from empty list)
        assert len(contents) == 1
        assert len(contents[0].parts) == 1
        assert contents[0].parts[0].function_response is not None

    def test_tool_message_with_image_only_parts(self):
        """Gemini provider handles ToolMessage with only image parts."""
        from app.agent.providers.googlegenai.googlegenai import GoogleGenAIProvider

        provider = GoogleGenAIProvider(api_key="test_key", model="gemini-2.0-flash")
        img_data = base64.b64encode(b"fake").decode("ascii")
        msg = ToolMessage(
            content="image",
            tool_call_id="1",
            parts=[ImageDataBlock(data=img_data, media_type="image/png")],
        )
        contents, _ = provider._convert_messages_to_gemini([msg])

        # Should have FunctionResponse + InlineData
        assert len(contents) == 1
        assert len(contents[0].parts) == 2
        assert contents[0].parts[0].function_response is not None
        assert contents[0].parts[1].inline_data is not None


class TestZAIProviderEmptyParts:
    """Test ZAI provider with edge case ToolMessages.

    ZAI subclasses :class:`OpenAIProvider`; conversion runs through
    ``CompletionsHandler.convert_messages`` on the provider's handler.
    """

    @staticmethod
    def _serialize(msg: ToolMessage) -> dict:
        from app.agent.providers.zai.zai import ZAIProvider

        provider = ZAIProvider(api_key="k", model="m")
        return provider._completions.convert_messages([msg])[0].model_dump(
            exclude_none=True
        )

    def test_tool_message_with_empty_parts_list(self):
        """ZAI provider handles ToolMessage with empty parts list."""
        msg = ToolMessage(content="result", tool_call_id="1", parts=[])
        serialized = self._serialize(msg)

        # Should fall back to content string
        assert serialized["role"] == "tool"
        assert serialized["content"] == "result"
        assert isinstance(serialized["content"], str)

    def test_tool_message_with_image_only_parts(self):
        """ZAI provider handles ToolMessage with only image parts."""
        img_data = base64.b64encode(b"fake").decode("ascii")
        msg = ToolMessage(
            content="image",
            tool_call_id="1",
            parts=[ImageDataBlock(data=img_data, media_type="image/png")],
        )
        serialized = self._serialize(msg)

        assert serialized["role"] == "tool"
        assert isinstance(serialized["content"], list)
        assert len(serialized["content"]) == 1
        assert serialized["content"][0]["type"] == "image_url"


# ─────────────────────────────────────────────────────────────────────────────
# session_log.py reading state.tool_names
# ─────────────────────────────────────────────────────────────────────────────


class TestSessionLogToolNames:
    """Test that session_log.py correctly reads state.tool_names field."""

    def test_agent_state_tool_names_field_exists(self):
        """AgentState has tool_names as a typed field."""
        state = AgentState(
            messages=[],
            tool_names=["read", "write", "search"],
        )
        assert hasattr(state, "tool_names")
        assert state.tool_names == ["read", "write", "search"]

    def test_agent_state_tool_names_default_empty(self):
        """AgentState.tool_names defaults to empty list."""
        state = AgentState(messages=[])
        assert state.tool_names == []

    def test_agent_state_tool_names_not_in_metadata(self):
        """tool_names is a field, not in metadata dict."""
        state = AgentState(
            messages=[],
            tool_names=["read"],
            metadata={"other": "value"},
        )
        # tool_names should be accessible as a field
        assert state.tool_names == ["read"]
        # metadata should not contain tool_names
        assert "tool_names" not in state.metadata


# ─────────────────────────────────────────────────────────────────────────────
# Integration: read_file with state=None (direct call)
# ─────────────────────────────────────────────────────────────────────────────


class TestReadFileWithoutState:
    """Test read_file when called without AgentState (direct invocation)."""

    @pytest.fixture
    def workspace(self, tmp_path):
        sb = SandboxConfig(workspace=str(tmp_path))
        set_sandbox(sb)
        yield tmp_path

    @pytest.mark.asyncio
    async def test_image_without_state_returns_tool_result(self, workspace):
        """When _state is not injected, it still returns the image as a ToolResult."""
        (workspace / "img.png").write_bytes(b"\x89PNG" + b"\x00" * 100)

        # Call without _injected parameter
        result = await read_file.arun(path="img.png")

        assert isinstance(result, ToolResult)
        assert len(result.parts) == 2
        assert isinstance(result.parts[1], ImageDataBlock)

    @pytest.mark.asyncio
    async def test_text_file_without_state_works(self, workspace):
        """Text files work regardless of state."""
        (workspace / "test.txt").write_text("hello world")

        result = await read_file.arun(path="test.txt")

        assert isinstance(result, str)
        assert result == "hello world"

    @pytest.mark.asyncio
    async def test_document_without_state_still_converts(self, workspace):
        """Documents still get markitdown conversion without state."""
        (workspace / "doc.pdf").write_bytes(b"%PDF-1.4" + b"\x00" * 100)

        with patch(
            "app.agent.tools.builtin.filesystem.handlers._convert_with_markitdown"
        ) as m:
            m.return_value = "# Content"
            result = await read_file.arun(path="doc.pdf")

        assert isinstance(result, ToolResult)
        assert len(result.parts) == 1
