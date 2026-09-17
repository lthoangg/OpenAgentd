"""Tests for app/agent/mcp/tools.py — MCPTool adapter."""

from __future__ import annotations

from base64 import b64encode
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.agent.errors import ToolExecutionError
from app.agent.mcp.tools import (
    MCPTool,
    _extract_app_resource,
    _extract_parts,
    _extract_text,
    _normalize_image_mime,
    _sanitize_schema,
)
from app.agent.schemas.chat import ImageDataBlock, TextBlock, ToolResult


class TestSanitizeSchema:
    """Test _sanitize_schema function."""

    def test_sanitize_schema_none_returns_empty_object(self) -> None:
        """_sanitize_schema(None) returns empty object schema."""
        result = _sanitize_schema(None)
        assert result == {"type": "object", "properties": {}, "required": []}

    def test_sanitize_schema_empty_dict_returns_object(self) -> None:
        """_sanitize_schema({}) returns object schema with defaults."""
        result = _sanitize_schema({})
        assert result["type"] == "object"
        assert result["properties"] == {}
        assert result["required"] == []

    def test_sanitize_schema_non_dict_returns_empty_object(self) -> None:
        """_sanitize_schema with non-dict returns empty object schema."""
        result = _sanitize_schema("not a dict")  # type: ignore[arg-type]
        assert result == {"type": "object", "properties": {}, "required": []}

    def test_sanitize_schema_preserves_type(self) -> None:
        """_sanitize_schema preserves existing type."""
        schema = {"type": "object", "properties": {"name": {"type": "string"}}}
        result = _sanitize_schema(schema)
        assert result["type"] == "object"
        assert "name" in result["properties"]

    def test_sanitize_schema_sets_default_type(self) -> None:
        """_sanitize_schema sets type=object if missing."""
        schema = {"properties": {"name": {"type": "string"}}}
        result = _sanitize_schema(schema)
        assert result["type"] == "object"

    def test_sanitize_schema_strips_schema_metadata(self) -> None:
        """_sanitize_schema removes $schema and $id."""
        schema = {
            "type": "object",
            "$schema": "http://json-schema.org/draft-07/schema#",
            "$id": "https://example.com/schema",
            "properties": {},
        }
        result = _sanitize_schema(schema)
        assert "$schema" not in result
        assert "$id" not in result
        assert result["type"] == "object"

    def test_sanitize_schema_sets_defaults(self) -> None:
        """_sanitize_schema sets properties and required if missing."""
        schema = {"type": "object"}
        result = _sanitize_schema(schema)
        assert result["properties"] == {}
        assert result["required"] == []

    def test_sanitize_schema_preserves_existing_properties(self) -> None:
        """_sanitize_schema preserves existing properties and required."""
        schema = {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        }
        result = _sanitize_schema(schema)
        assert result["properties"] == {"name": {"type": "string"}}
        assert result["required"] == ["name"]

    def test_sanitize_schema_flattens_top_level_oneof(self) -> None:
        """_sanitize_schema flattens top-level oneOf combinator."""
        schema = {
            "oneOf": [
                {
                    "type": "object",
                    "properties": {"repo": {"type": "string"}},
                    "required": ["repo"],
                },
                {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"],
                },
            ]
        }
        result = _sanitize_schema(schema)
        assert "oneOf" not in result
        assert result["type"] == "object"
        assert result["properties"] == {
            "repo": {"type": "string"},
            "url": {"type": "string"},
        }
        assert result["required"] == []

    def test_sanitize_schema_flattens_top_level_allof(self) -> None:
        """_sanitize_schema flattens top-level allOf combinator."""
        schema = {
            "type": "object",
            "allOf": [
                {
                    "properties": {"foo": {"type": "string"}},
                    "required": ["foo"],
                },
                {
                    "properties": {"bar": {"type": "number"}},
                    "required": ["bar"],
                },
            ],
        }
        result = _sanitize_schema(schema)
        assert "allOf" not in result
        assert result["type"] == "object"
        assert result["properties"] == {
            "foo": {"type": "string"},
            "bar": {"type": "number"},
        }
        assert result["required"] == ["bar", "foo"]

    def test_sanitize_schema_flattens_top_level_anyof(self) -> None:
        """_sanitize_schema flattens top-level anyOf combinator."""
        schema = {
            "type": "object",
            "properties": {"action": {"type": "string"}},
            "required": ["action"],
            "anyOf": [
                {"properties": {"param1": {"type": "string"}}, "required": ["param1"]},
                {"properties": {"param2": {"type": "boolean"}}},
            ],
        }
        result = _sanitize_schema(schema)
        assert "anyOf" not in result
        assert result["type"] == "object"
        assert result["properties"] == {
            "action": {"type": "string"},
            "param1": {"type": "string"},
            "param2": {"type": "boolean"},
        }
        assert result["required"] == ["action"]


class TestExtractText:
    """Test _extract_text function."""

    def test_extract_text_empty_content(self) -> None:
        """_extract_text([]) returns empty string."""
        assert _extract_text([]) == ""

    def test_extract_text_none_content(self) -> None:
        """_extract_text(None) returns empty string."""
        assert _extract_text(None) == ""

    def test_extract_text_single_text_block(self) -> None:
        """_extract_text extracts text from TextContent block."""
        block = SimpleNamespace(type="text", text="Hello, world!")
        result = _extract_text([block])
        assert result == "Hello, world!"

    def test_extract_text_multiple_text_blocks(self) -> None:
        """_extract_text joins multiple text blocks with newlines."""
        blocks = [
            SimpleNamespace(type="text", text="Line 1"),
            SimpleNamespace(type="text", text="Line 2"),
        ]
        result = _extract_text(blocks)
        assert result == "Line 1\nLine 2"

    def test_extract_text_image_block(self) -> None:
        """_extract_text renders image blocks as [image: mime]."""
        block = SimpleNamespace(type="image", mime_type="image/png")
        result = _extract_text([block])
        assert result == "[image: image/png]"

    def test_extract_text_image_block_default_mime(self) -> None:
        """_extract_text uses image/* when mimeType is missing."""
        block = SimpleNamespace(type="image")
        result = _extract_text([block])
        assert result == "[image: image/*]"

    def test_extract_text_resource_block(self) -> None:
        """_extract_text renders resource blocks as [resource: uri]."""
        resource = SimpleNamespace(uri="file:///tmp/data.txt")
        block = SimpleNamespace(type="resource", resource=resource)
        result = _extract_text([block])
        assert result == "[resource: file:///tmp/data.txt]"

    def test_extract_text_mixed_blocks(self) -> None:
        """_extract_text handles mixed content types."""
        blocks = [
            SimpleNamespace(type="text", text="Text content"),
            SimpleNamespace(type="image", mime_type="image/jpeg"),
            SimpleNamespace(type="text", text="More text"),
        ]
        result = _extract_text(blocks)
        assert "Text content" in result
        assert "[image: image/jpeg]" in result
        assert "More text" in result

    def test_extract_text_unknown_block_type(self) -> None:
        """_extract_text converts unknown blocks to string."""
        block = SimpleNamespace(type="unknown", data="some data")
        result = _extract_text([block])
        assert "unknown" in str(result).lower() or "some data" in result

    def test_extract_text_non_list_content(self) -> None:
        """_extract_text converts non-list content to string."""
        result = _extract_text("plain string")
        assert result == "plain string"


class TestNormalizeImageMime:
    """Test _normalize_image_mime function."""

    def test_normalize_default_when_none(self) -> None:
        assert _normalize_image_mime(None) == "image/png"

    def test_normalize_default_when_empty(self) -> None:
        assert _normalize_image_mime("") == "image/png"

    def test_normalize_jpeg_alias(self) -> None:
        assert _normalize_image_mime("image/jpg") == "image/jpeg"

    def test_normalize_bare_extension(self) -> None:
        assert _normalize_image_mime("png") == "image/png"
        assert _normalize_image_mime("jpg") == "image/jpeg"
        assert _normalize_image_mime("jpeg") == "image/jpeg"
        assert _normalize_image_mime("webp") == "image/webp"

    def test_normalize_strips_parameters(self) -> None:
        assert _normalize_image_mime("image/png; charset=utf-8") == "image/png"

    def test_normalize_preserves_standard_mimes(self) -> None:
        assert _normalize_image_mime("image/png") == "image/png"
        assert _normalize_image_mime("image/jpeg") == "image/jpeg"
        assert _normalize_image_mime("image/gif") == "image/gif"
        assert _normalize_image_mime("image/webp") == "image/webp"
        assert _normalize_image_mime("image/svg+xml") == "image/svg+xml"


class TestExtractParts:
    """Test _extract_parts function."""

    def test_extract_parts_empty_or_none(self) -> None:
        assert _extract_parts([]) == []
        assert _extract_parts(None) == []

    def test_extract_parts_non_list(self) -> None:
        parts = _extract_parts("plain text")
        assert len(parts) == 1
        assert isinstance(parts[0], TextBlock)
        assert parts[0].text == "plain text"

    def test_extract_parts_text_block(self) -> None:
        block = SimpleNamespace(type="text", text="Hello world")
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], TextBlock)
        assert parts[0].text == "Hello world"

    def test_extract_parts_image_block_mime_type(self) -> None:
        block = SimpleNamespace(type="image", data="b64data", mime_type="image/png")
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], ImageDataBlock)
        assert parts[0].data == "b64data"
        assert parts[0].media_type == "image/png"

    def test_extract_parts_image_block_camel_case_mime(self) -> None:
        block = SimpleNamespace(type="image", data="b64data", mimeType="image/jpg")
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], ImageDataBlock)
        assert parts[0].data == "b64data"
        assert parts[0].media_type == "image/jpeg"

    def test_extract_parts_image_block_dict(self) -> None:
        block = {"type": "image", "data": "b64dict", "mimeType": "image/gif"}
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], ImageDataBlock)
        assert parts[0].data == "b64dict"
        assert parts[0].media_type == "image/gif"

    def test_extract_parts_image_block_without_data(self) -> None:
        block = SimpleNamespace(type="image", mime_type="image/png")
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], TextBlock)
        assert "[image: image/png]" in parts[0].text

    def test_extract_parts_resource_blob_with_image_mime(self) -> None:
        resource = SimpleNamespace(
            blob="b64blob", mime_type="image/png", uri="ui://chart.png"
        )
        block = SimpleNamespace(type="resource", resource=resource)
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], ImageDataBlock)
        assert parts[0].data == "b64blob"
        assert parts[0].media_type == "image/png"

    def test_extract_parts_resource_blob_with_guessed_mime(self) -> None:
        resource = SimpleNamespace(blob="b64blob", uri="file:///tmp/cat.webp")
        block = SimpleNamespace(type="resource", resource=resource)
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], ImageDataBlock)
        assert parts[0].data == "b64blob"
        assert parts[0].media_type == "image/webp"

    def test_extract_parts_resource_text(self) -> None:
        resource = SimpleNamespace(text="res content", uri="ui://text.txt")
        block = SimpleNamespace(type="resource", resource=resource)
        parts = _extract_parts([block])
        assert len(parts) == 1
        assert isinstance(parts[0], TextBlock)
        assert parts[0].text == "res content"

    def test_extract_parts_mixed(self) -> None:
        blocks = [
            SimpleNamespace(type="text", text="Header:"),
            SimpleNamespace(type="image", data="b64img", mime_type="image/png"),
            SimpleNamespace(type="text", text="Footer"),
        ]
        parts = _extract_parts(blocks)
        assert len(parts) == 3
        assert isinstance(parts[0], TextBlock)
        assert parts[0].text == "Header:"
        assert isinstance(parts[1], ImageDataBlock)
        assert parts[1].data == "b64img"
        assert isinstance(parts[2], TextBlock)
        assert parts[2].text == "Footer"


class TestMCPToolDefinition:
    """Test MCPTool.definition property."""

    def test_mcp_tool_definition_name(self) -> None:
        """MCPTool.definition has correct name format <server>_<tool>."""
        mcp_tool = SimpleNamespace(
            name="list_files",
            description="List files in a directory",
            input_schema={"type": "object", "properties": {}},
        )
        tool = MCPTool(
            server_name="filesystem",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: None,
        )
        assert tool.name == "filesystem_list_files"
        assert tool.definition["function"]["name"] == "filesystem_list_files"

    def test_mcp_tool_definition_description(self) -> None:
        """MCPTool.definition includes description."""
        mcp_tool = SimpleNamespace(
            name="search",
            description="Search the web",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="web",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: None,
        )
        assert tool.definition["function"]["description"] == "Search the web"

    def test_mcp_tool_definition_default_description(self) -> None:
        """MCPTool uses default description if MCP tool has none."""
        mcp_tool = SimpleNamespace(
            name="mytool",
            description=None,
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="myserver",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: None,
        )
        assert "mytool" in tool.definition["function"]["description"]
        assert "myserver" in tool.definition["function"]["description"]

    def test_mcp_tool_definition_parameters(self) -> None:
        """MCPTool.definition includes sanitized parameters."""
        mcp_tool = SimpleNamespace(
            name="search",
            description="Search",
            input_schema={
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        )
        tool = MCPTool(
            server_name="web",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: None,
        )
        params = tool.definition["function"]["parameters"]
        assert params["type"] == "object"
        assert "query" in params["properties"]
        assert "limit" in params["properties"]
        assert params["required"] == ["query"]

    def test_mcp_tool_definition_no_input_schema(self) -> None:
        """MCPTool handles missing inputSchema gracefully."""
        mcp_tool = SimpleNamespace(
            name="mytool",
            description="A tool",
        )
        tool = MCPTool(
            server_name="myserver",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: None,
        )
        params = tool.definition["function"]["parameters"]
        assert params["type"] == "object"
        assert params["properties"] == {}


class TestMCPToolArun:
    """Test MCPTool.arun execution."""

    @pytest.mark.asyncio
    async def test_arun_success_returns_text(self) -> None:
        """arun() returns extracted text on success."""
        session = AsyncMock()
        result = SimpleNamespace(
            is_error=False,
            content=[SimpleNamespace(type="text", text="Success!")],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="test",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        result_text = await tool.arun(arg1="value1")
        assert result_text == "Success!"
        session.call_tool.assert_called_once_with("mytool", {"arg1": "value1"})

    @pytest.mark.asyncio
    async def test_arun_with_mcp_app_resource_uri_and_html_blob(self) -> None:
        session = AsyncMock()
        session.call_tool.return_value = SimpleNamespace(
            is_error=False,
            content=[SimpleNamespace(type="text", text="Draw a diagram")],
        )
        html = "<html><head></head><body>mcp app</body></html>"
        session.read_resource.return_value = SimpleNamespace(
            contents=[
                SimpleNamespace(
                    uri="ui://excalidraw/mcp-app.html",
                    mime_type="text/html;profile=mcp-app",
                    blob=b64encode(html.encode()).decode(),
                    _meta={
                        "ui": {
                            "prefersBorder": True,
                            "permissions": {"clipboardWrite": True},
                        }
                    },
                )
            ]
        )

        mcp_tool = SimpleNamespace(
            name="excalidraw",
            description="Excalidraw",
            input_schema={"type": "object"},
            _meta={"ui": {"resourceUri": "ui://excalidraw/mcp-app.html"}},
        )
        tool = MCPTool(
            server_name="design", mcp_tool=mcp_tool, session_provider=lambda: session
        )  # type: ignore[arg-type]

        result = await tool.arun()
        assert isinstance(result, ToolResult)
        assert result.mcp_app is not None
        assert result.mcp_app["resourceUri"] == "ui://excalidraw/mcp-app.html"
        assert result.mcp_app["html"] == html
        assert result.mcp_app["mimeType"] == "text/html;profile=mcp-app"
        assert result.mcp_app["resourceMeta"] == {
            "ui": {"prefersBorder": True, "permissions": {"clipboardWrite": True}}
        }
        # MCP v2 takes resource URIs as plain `str` (v1 required `AnyUrl`).
        read_resource_arg = session.read_resource.call_args.args[0]
        assert isinstance(read_resource_arg, str)
        assert read_resource_arg == "ui://excalidraw/mcp-app.html"

    @pytest.mark.asyncio
    async def test_arun_uses_listing_resource_meta_when_read_resource_omits_meta(
        self,
    ) -> None:
        session = AsyncMock()
        session.call_tool.return_value = SimpleNamespace(
            is_error=False,
            content=[SimpleNamespace(type="text", text="Draw a diagram")],
        )
        session.read_resource.return_value = SimpleNamespace(
            contents=[
                SimpleNamespace(
                    uri="ui://excalidraw/mcp-app.html",
                    mime_type="text/html;profile=mcp-app",
                    text="<html><body>mcp app</body></html>",
                )
            ]
        )
        session.list_resources.return_value = SimpleNamespace(
            resources=[
                SimpleNamespace(
                    uri="ui://excalidraw/mcp-app.html",
                    _meta={
                        "ui": {
                            "csp": {
                                "resourceDomains": ["https://esm.sh"],
                                "connectDomains": ["https://esm.sh"],
                            }
                        }
                    },
                )
            ]
        )

        mcp_tool = SimpleNamespace(
            name="excalidraw",
            description="Excalidraw",
            input_schema={"type": "object"},
            _meta={"ui": {"resourceUri": "ui://excalidraw/mcp-app.html"}},
        )
        tool = MCPTool(
            server_name="design", mcp_tool=mcp_tool, session_provider=lambda: session
        )  # type: ignore[arg-type]

        result = await tool.arun()
        assert isinstance(result, ToolResult)
        assert result.mcp_app is not None
        assert result.mcp_app["resourceMeta"] == {
            "ui": {
                "csp": {
                    "resourceDomains": ["https://esm.sh"],
                    "connectDomains": ["https://esm.sh"],
                }
            }
        }
        session.list_resources.assert_called_once()

    def test_extract_app_resource_ignores_listing_resource_meta(self) -> None:
        resource = SimpleNamespace(
            contents=[
                SimpleNamespace(
                    uri="ui://excalidraw/mcp-app.html",
                    mime_type="text/html;profile=mcp-app",
                    text="<html><body>mcp app</body></html>",
                )
            ]
        )

        result = _extract_app_resource(resource, "ui://excalidraw/mcp-app.html")
        assert result is not None
        assert result["resourceMeta"] is None

    @pytest.mark.asyncio
    async def test_arun_no_session_raises_error(self) -> None:
        """arun() raises ToolExecutionError when session is None."""
        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="test",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: None,
        )

        with pytest.raises(ToolExecutionError, match="not connected"):
            await tool.arun(arg1="value1")

    @pytest.mark.asyncio
    async def test_arun_error_result_raises_error(self) -> None:
        """arun() raises ToolExecutionError when result.isError is True."""
        session = AsyncMock()
        result = SimpleNamespace(
            is_error=True,
            content=[SimpleNamespace(type="text", text="Error message")],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="test",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        with pytest.raises(ToolExecutionError, match="returned error"):
            await tool.arun(arg1="value1")

    @pytest.mark.asyncio
    async def test_arun_exception_raises_error(self) -> None:
        """arun() raises ToolExecutionError when session.call_tool raises."""
        session = AsyncMock()
        session.call_tool.side_effect = RuntimeError("Connection lost")

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="test",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        with pytest.raises(ToolExecutionError, match="failed"):
            await tool.arun(arg1="value1")

    @pytest.mark.asyncio
    async def test_arun_ignores_injected_param(self) -> None:
        """arun() accepts _injected but ignores it."""
        session = AsyncMock()
        result = SimpleNamespace(
            is_error=False,
            content=[SimpleNamespace(type="text", text="OK")],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="test",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        result_text = await tool.arun(_injected={"state": "ignored"}, arg1="value1")
        assert result_text == "OK"
        # _injected should not be passed to call_tool
        session.call_tool.assert_called_once_with("mytool", {"arg1": "value1"})

    @pytest.mark.asyncio
    async def test_arun_empty_error_message(self) -> None:
        """arun() handles error result with no content."""
        session = AsyncMock()
        result = SimpleNamespace(
            is_error=True,
            content=[],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="test",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        with pytest.raises(ToolExecutionError, match="no message"):
            await tool.arun()

    @pytest.mark.asyncio
    async def test_arun_with_image_content_returns_tool_result(self) -> None:
        session = AsyncMock()
        result = SimpleNamespace(
            is_error=False,
            content=[
                SimpleNamespace(
                    type="image",
                    data="b64data",
                    mime_type="image/png",
                )
            ],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="screenshot",
            description="Capture screen",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="screen",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        res = await tool.arun()
        assert isinstance(res, ToolResult)
        assert len(res.parts) == 1
        assert isinstance(res.parts[0], ImageDataBlock)
        assert res.parts[0].data == "b64data"
        assert res.parts[0].media_type == "image/png"

    @pytest.mark.asyncio
    async def test_arun_with_text_and_image_content_returns_tool_result(self) -> None:
        session = AsyncMock()
        result = SimpleNamespace(
            is_error=False,
            content=[
                SimpleNamespace(type="text", text="Look at this chart:"),
                SimpleNamespace(
                    type="image",
                    data="b64data",
                    mime_type="image/jpeg",
                ),
            ],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="plot",
            description="Plot chart",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="analytics",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        res = await tool.arun()
        assert isinstance(res, ToolResult)
        assert len(res.parts) == 2
        assert isinstance(res.parts[0], TextBlock)
        assert res.parts[0].text == "Look at this chart:"
        assert isinstance(res.parts[1], ImageDataBlock)
        assert res.parts[1].data == "b64data"
        assert res.parts[1].media_type == "image/jpeg"

    @pytest.mark.asyncio
    async def test_arun_with_embedded_image_resource_returns_tool_result(self) -> None:
        session = AsyncMock()
        resource = SimpleNamespace(
            blob="blobdata",
            mime_type="image/webp",
            uri="ui://canvas.webp",
        )
        result = SimpleNamespace(
            is_error=False,
            content=[SimpleNamespace(type="resource", resource=resource)],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="render",
            description="Render canvas",
            input_schema={"type": "object"},
        )
        tool = MCPTool(
            server_name="canvas",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        res = await tool.arun()
        assert isinstance(res, ToolResult)
        assert len(res.parts) == 1
        assert isinstance(res.parts[0], ImageDataBlock)
        assert res.parts[0].data == "blobdata"
        assert res.parts[0].media_type == "image/webp"


class TestRealSDKModels:
    """Contract tests against real MCP SDK models, not hand-rolled doubles.

    The rest of this module uses ``SimpleNamespace`` doubles. Those cannot catch
    a field rename in the SDK: when v2 renamed ``inputSchema`` -> ``input_schema``
    and ``isError`` -> ``is_error``, every double kept using camelCase, so the
    suite stayed green while the real client silently dropped every tool's
    parameters and stopped detecting tool errors. These tests bind the adapter to
    the actual model classes so that class of drift fails loudly.
    """

    def test_definition_reads_input_schema_from_real_tool_model(self) -> None:
        """Parameters come from a real ``mcp.types.Tool``, not an empty fallback."""
        from mcp.types import Tool as MCPToolDef

        schema = {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        }
        # Construct by wire alias to prove alias->field mapping still holds.
        mcp_tool = MCPToolDef.model_validate(
            {"name": "read_file", "description": "Read a file", "inputSchema": schema}
        )

        tool = MCPTool(
            server_name="fs",
            mcp_tool=mcp_tool,
            session_provider=lambda: None,
        )

        params = tool.definition["function"]["parameters"]
        assert params["properties"] == {"path": {"type": "string"}}
        assert params["required"] == ["path"]

    @pytest.mark.asyncio
    async def test_arun_detects_error_on_real_call_tool_result(self) -> None:
        """A real ``CallToolResult`` with is_error=True must raise."""
        from mcp.types import CallToolResult, TextContent
        from mcp.types import Tool as MCPToolDef

        session = AsyncMock()
        session.call_tool.return_value = CallToolResult(
            content=[TextContent(type="text", text="boom")],
            isError=True,
        )

        mcp_tool = MCPToolDef.model_validate(
            {"name": "explode", "inputSchema": {"type": "object"}}
        )
        tool = MCPTool(
            server_name="fs", mcp_tool=mcp_tool, session_provider=lambda: session
        )

        with pytest.raises(ToolExecutionError, match="boom"):
            await tool.arun()

    @pytest.mark.asyncio
    async def test_arun_returns_text_on_real_success_result(self) -> None:
        """A real successful ``CallToolResult`` is flattened to its text."""
        from mcp.types import CallToolResult, TextContent
        from mcp.types import Tool as MCPToolDef

        session = AsyncMock()
        session.call_tool.return_value = CallToolResult(
            content=[TextContent(type="text", text="file contents")],
        )

        mcp_tool = MCPToolDef.model_validate(
            {"name": "read", "inputSchema": {"type": "object"}}
        )
        tool = MCPTool(
            server_name="fs", mcp_tool=mcp_tool, session_provider=lambda: session
        )

        assert await tool.arun() == "file contents"

    def test_extract_app_resource_reads_real_resource_contents(self) -> None:
        """``_extract_app_resource`` reads ``mime_type`` off a real model."""
        from mcp.types import ReadResourceResult, TextResourceContents

        from app.agent.mcp.tools import MCP_APP_MIME_TYPE

        result = ReadResourceResult(
            contents=[
                TextResourceContents.model_validate(
                    {
                        "uri": "ui://app/index.html",
                        "mimeType": MCP_APP_MIME_TYPE,
                        "text": "<h1>hi</h1>",
                    }
                )
            ]
        )

        extracted = _extract_app_resource(result, "ui://app/index.html")
        assert extracted is not None
        assert extracted["html"] == "<h1>hi</h1>"
        # Our outward-facing payload keeps camelCase for the frontend contract.
        assert extracted["mimeType"] == MCP_APP_MIME_TYPE

    @pytest.mark.asyncio
    async def test_arun_returns_tool_result_on_real_image_content(self) -> None:
        """A real ``CallToolResult`` with ``ImageContent`` returns ``ToolResult``."""
        from mcp.types import CallToolResult, ImageContent
        from mcp.types import Tool as MCPToolDef

        session = AsyncMock()
        session.call_tool.return_value = CallToolResult(
            content=[
                ImageContent(type="image", data="b64realimg", mimeType="image/png")
            ],
        )

        mcp_tool = MCPToolDef.model_validate(
            {"name": "take_pic", "inputSchema": {"type": "object"}}
        )
        tool = MCPTool(
            server_name="camera", mcp_tool=mcp_tool, session_provider=lambda: session
        )

        res = await tool.arun()
        assert isinstance(res, ToolResult)
        assert len(res.parts) == 1
        assert isinstance(res.parts[0], ImageDataBlock)
        assert res.parts[0].data == "b64realimg"
        assert res.parts[0].media_type == "image/png"

    @pytest.mark.asyncio
    async def test_arun_returns_tool_result_on_real_embedded_image_resource(
        self,
    ) -> None:
        """A real ``CallToolResult`` with embedded image resource returns ``ToolResult``."""
        from mcp.types import BlobResourceContents, CallToolResult, EmbeddedResource
        from mcp.types import Tool as MCPToolDef

        session = AsyncMock()
        session.call_tool.return_value = CallToolResult(
            content=[
                EmbeddedResource(
                    type="resource",
                    resource=BlobResourceContents(
                        uri="ui://image.jpeg",
                        blob="b64blobjpeg",
                        mimeType="image/jpeg",
                    ),
                )
            ],
        )

        mcp_tool = MCPToolDef.model_validate(
            {"name": "get_asset", "inputSchema": {"type": "object"}}
        )
        tool = MCPTool(
            server_name="assets", mcp_tool=mcp_tool, session_provider=lambda: session
        )

        res = await tool.arun()
        assert isinstance(res, ToolResult)
        assert len(res.parts) == 1
        assert isinstance(res.parts[0], ImageDataBlock)
        assert res.parts[0].data == "b64blobjpeg"
        assert res.parts[0].media_type == "image/jpeg"
