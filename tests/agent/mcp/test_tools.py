"""Tests for app/agent/mcp/tools.py — MCPTool adapter."""

from __future__ import annotations

from base64 import b64encode
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import AnyUrl

from app.agent.errors import ToolExecutionError
from app.agent.mcp.tools import (
    MCPTool,
    _extract_app_resource,
    _extract_text,
    _sanitize_schema,
)
from app.agent.schemas.chat import ToolResult


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
        block = SimpleNamespace(type="image", mimeType="image/png")
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
            SimpleNamespace(type="image", mimeType="image/jpeg"),
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


class TestMCPToolDefinition:
    """Test MCPTool.definition property."""

    def test_mcp_tool_definition_name(self) -> None:
        """MCPTool.definition has correct name format mcp_<server>_<tool>."""
        mcp_tool = SimpleNamespace(
            name="list_files",
            description="List files in a directory",
            inputSchema={"type": "object", "properties": {}},
        )
        tool = MCPTool(
            server_name="filesystem",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: None,
        )
        assert tool.name == "mcp_filesystem_list_files"
        assert tool.definition["function"]["name"] == "mcp_filesystem_list_files"

    def test_mcp_tool_definition_description(self) -> None:
        """MCPTool.definition includes description."""
        mcp_tool = SimpleNamespace(
            name="search",
            description="Search the web",
            inputSchema={"type": "object"},
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
            inputSchema={"type": "object"},
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
            inputSchema={
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
            isError=False,
            content=[SimpleNamespace(type="text", text="Success!")],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            inputSchema={"type": "object"},
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
            isError=False,
            content=[SimpleNamespace(type="text", text="Draw a diagram")],
        )
        html = "<html><head></head><body>mcp app</body></html>"
        session.read_resource.return_value = SimpleNamespace(
            contents=[
                SimpleNamespace(
                    uri="ui://excalidraw/mcp-app.html",
                    mimeType="text/html;profile=mcp-app",
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
            inputSchema={"type": "object"},
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
        read_resource_arg = session.read_resource.call_args.args[0]
        assert isinstance(read_resource_arg, AnyUrl)
        assert str(read_resource_arg) == "ui://excalidraw/mcp-app.html"

    @pytest.mark.asyncio
    async def test_arun_uses_listing_resource_meta_when_read_resource_omits_meta(
        self,
    ) -> None:
        session = AsyncMock()
        session.call_tool.return_value = SimpleNamespace(
            isError=False,
            content=[SimpleNamespace(type="text", text="Draw a diagram")],
        )
        session.read_resource.return_value = SimpleNamespace(
            contents=[
                SimpleNamespace(
                    uri="ui://excalidraw/mcp-app.html",
                    mimeType="text/html;profile=mcp-app",
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
            inputSchema={"type": "object"},
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
                    mimeType="text/html;profile=mcp-app",
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
            inputSchema={"type": "object"},
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
            isError=True,
            content=[SimpleNamespace(type="text", text="Error message")],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            inputSchema={"type": "object"},
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
            inputSchema={"type": "object"},
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
            isError=False,
            content=[SimpleNamespace(type="text", text="OK")],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            inputSchema={"type": "object"},
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
            isError=True,
            content=[],
        )
        session.call_tool.return_value = result

        mcp_tool = SimpleNamespace(
            name="mytool",
            description="Test tool",
            inputSchema={"type": "object"},
        )
        tool = MCPTool(
            server_name="test",
            mcp_tool=mcp_tool,  # type: ignore[arg-type]
            session_provider=lambda: session,
        )

        with pytest.raises(ToolExecutionError, match="no message"):
            await tool.arun()
