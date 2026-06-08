"""Adapter that wraps an MCP server tool as a local :class:`Tool`.

An MCP tool ships with a JSON Schema (``inputSchema``) for its arguments.
We forward that schema directly to the LLM in the OpenAI-compatible
function-calling shape, and route invocations back through the live
``ClientSession`` held by the :class:`MCPManager`.

Tool names follow the convention ``mcp_<server>_<tool>`` so they are easy
to gate via the existing permission system (``mcp_*`` wildcard) and never
collide with built-in tool names.
"""

from __future__ import annotations

import base64
from typing import TYPE_CHECKING, Any

from loguru import logger
from pydantic import AnyUrl, BaseModel

from app.agent.errors import ToolExecutionError
from app.agent.schemas.chat import TextBlock, ToolResult
from app.agent.tools.registry import Tool

if TYPE_CHECKING:
    from mcp import ClientSession
    from mcp.types import Tool as MCPToolDef


MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"


def _sanitize_schema(schema: dict[str, Any] | None) -> dict[str, Any]:
    """Coerce an MCP tool ``inputSchema`` into the OpenAI function-call shape.

    MCP servers return JSON Schema; OpenAI tool schemas are JSON Schema with
    a ``type: "object"`` wrapper. Most servers already return that shape.
    """
    if not schema or not isinstance(schema, dict):
        return {"type": "object", "properties": {}, "required": []}

    result = dict(schema)
    result.setdefault("type", "object")
    result.setdefault("properties", {})
    # ``required`` is optional in JSON Schema but expected by some providers.
    result.setdefault("required", [])
    # Drop $schema / $id metadata that some servers include — providers reject it.
    result.pop("$schema", None)
    result.pop("$id", None)
    return result


class _NoopParameters(BaseModel):
    """Placeholder Pydantic model — MCPTool does not use base-class validation."""

    model_config = {"extra": "allow"}


class MCPTool(Tool):
    """A :class:`Tool` whose schema and execution are sourced from an MCP server.

    Unlike the base ``Tool``, the JSON Schema comes from the MCP server's
    ``inputSchema`` rather than being derived from a Python function signature.
    Calls are forwarded to ``session.call_tool(remote_name, args)``.
    """

    def __init__(
        self,
        *,
        server_name: str,
        mcp_tool: "MCPToolDef",
        session_provider: "_SessionProvider",
    ) -> None:
        self._server_name = server_name
        self._remote_name = mcp_tool.name
        self._session_provider = session_provider
        self._mcp_tool = mcp_tool

        local_name = f"mcp_{server_name}_{mcp_tool.name}"
        description = (
            mcp_tool.description
            or f"Tool '{mcp_tool.name}' from MCP server '{server_name}'."
        )

        # ── Build the OpenAI-compatible tool definition directly ─────────
        parameters = _sanitize_schema(
            mcp_tool.inputSchema if hasattr(mcp_tool, "inputSchema") else None
        )
        self._definition = {
            "type": "function",
            "function": {
                "name": local_name,
                "description": description,
                "parameters": parameters,
            },
        }
        self._model = _NoopParameters
        self._injected_params: set[str] = set()
        self._description_factory = None

        self.name = local_name
        self._custom_description = description
        self._func = self._invoke  # for repr / __wrapped__ compatibility

        self.__name__ = local_name
        self.__doc__ = description
        self.__wrapped__ = self._invoke

    async def arun(self, _injected: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        """Forward the call to the MCP server.

        ``_injected`` is accepted for interface compatibility with builtins
        but unused — MCP tools cannot consume :class:`AgentState`.
        """
        del _injected  # unused
        return await self._invoke(**kwargs)

    async def _invoke(self, **kwargs: Any) -> str | ToolResult:
        session = self._session_provider()
        if session is None:
            raise ToolExecutionError(
                f"MCP server '{self._server_name}' is not connected."
            )

        logger.debug(
            "mcp_tool_call server={} tool={} args={}",
            self._server_name,
            self._remote_name,
            list(kwargs.keys()),
        )
        try:
            result = await session.call_tool(self._remote_name, kwargs)
        except Exception as exc:
            raise ToolExecutionError(
                f"MCP tool '{self.name}' failed: {type(exc).__name__}: {exc}"
            ) from exc

        if getattr(result, "isError", False):
            text = _extract_text(result.content)
            raise ToolExecutionError(
                f"MCP tool '{self.name}' returned error: {text or '(no message)'}"
            )

        text_summary = _extract_text(result.content)

        mcp_app_meta = _get_ui_meta(self._mcp_tool)
        resource_uri = mcp_app_meta.get("resourceUri")

        if resource_uri:
            try:
                resource = await session.read_resource(AnyUrl(resource_uri))
                app_resource = _extract_app_resource(resource, resource_uri)

                if app_resource is not None:
                    if app_resource.get("resourceMeta") is None:
                        app_resource["resourceMeta"] = await _get_listing_resource_meta(
                            session, resource_uri
                        )
                    return ToolResult(
                        parts=[TextBlock(text=text_summary)],
                        mcp_app={
                            "server": self._server_name,
                            "tool": self._remote_name,
                            "name": self.name,
                            "resourceUri": resource_uri,
                            "html": app_resource["html"],
                            "mimeType": app_resource.get("mimeType"),
                            "resourceMeta": app_resource.get("resourceMeta"),
                            "toolMeta": mcp_app_meta,
                            "tool_input": kwargs,
                            "result": _dump_mcp_model(result),
                        },
                    )
            except Exception as exc:
                logger.warning(
                    "mcp_app_resource_fetch_failed server={} tool={} uri={} error={}",
                    self._server_name,
                    self._remote_name,
                    resource_uri,
                    exc,
                )

        return text_summary


def _dump_mcp_model(value: Any) -> Any:
    """Return a JSON-serialisable representation of an MCP SDK object."""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    return value


def _get_ui_meta(mcp_tool: Any) -> dict[str, Any]:
    """Extract MCP Apps tool metadata from Pydantic or plain test doubles."""
    meta = getattr(mcp_tool, "meta", None) or getattr(mcp_tool, "_meta", None) or {}
    if not isinstance(meta, dict):
        return {}
    ui = meta.get("ui")
    if isinstance(ui, dict):
        return ui
    # Deprecated flat shape used by early MCP Apps drafts.
    resource_uri = meta.get("ui/resourceUri")
    return {"resourceUri": resource_uri} if isinstance(resource_uri, str) else {}


async def _get_listing_resource_meta(
    session: "ClientSession", resource_uri: str
) -> dict[str, Any] | None:
    """Return listing-level resource metadata when resources/read omits it."""
    try:
        resources_result = await session.list_resources()
    except Exception as exc:
        logger.debug(
            "mcp_app_resource_listing_meta_fetch_failed uri={} error={}",
            resource_uri,
            exc,
        )
        return None

    resources = getattr(resources_result, "resources", None)
    if not isinstance(resources, list):
        return None

    for resource in resources:
        if str(getattr(resource, "uri", "")) != resource_uri:
            continue
        meta = getattr(resource, "meta", None) or getattr(resource, "_meta", None)
        return meta if isinstance(meta, dict) else None
    return None


def _extract_app_resource(
    resource_result: Any, resource_uri: str
) -> dict[str, Any] | None:
    """Extract the HTML payload and UI metadata from a resources/read result."""
    contents = getattr(resource_result, "contents", None)
    if not isinstance(contents, list):
        return None

    for content in contents:
        mime_type = getattr(content, "mimeType", None)
        if mime_type != MCP_APP_MIME_TYPE:
            continue
        html = getattr(content, "text", None)
        if not isinstance(html, str):
            blob = getattr(content, "blob", None)
            if isinstance(blob, str):
                try:
                    html = base64.b64decode(blob).decode("utf-8")
                except (ValueError, UnicodeDecodeError):
                    html = None
        if not html:
            continue
        meta = getattr(content, "meta", None) or getattr(content, "_meta", None)
        return {
            "resourceUri": str(getattr(content, "uri", resource_uri)),
            "mimeType": mime_type,
            "html": html,
            "resourceMeta": meta if isinstance(meta, dict) else None,
        }
    return None


def _extract_text(content: Any) -> str:
    """Best-effort flatten an MCP ``CallToolResult.content`` list to a string.

    MCP content is a list of typed blocks (``TextContent``, ``ImageContent``,
    ``EmbeddedResource``). For now we only render ``TextContent`` and
    summarise the rest, since the agent loop already has rich multimodal
    handling and we don't want to leak base64 image blobs back through here.
    """
    if not content:
        return ""
    if not isinstance(content, list):
        return str(content)

    parts: list[str] = []
    for block in content:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            parts.append(getattr(block, "text", "") or "")
        elif block_type == "image":
            mime = getattr(block, "mimeType", "image/*")
            parts.append(f"[image: {mime}]")
        elif block_type == "resource":
            uri = getattr(getattr(block, "resource", None), "uri", "?")
            parts.append(f"[resource: {uri}]")
        else:
            parts.append(str(block))
    return "\n".join(parts)


# ── Type alias for the session-resolution callback ──────────────────────────
# Defined at module bottom to avoid a forward reference in MCPTool.__init__.

from typing import Callable, Optional  # noqa: E402

_SessionProvider = Callable[[], Optional["ClientSession"]]
