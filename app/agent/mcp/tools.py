"""Adapter that wraps an MCP server tool as a local :class:`Tool`.

An MCP tool ships with a JSON Schema (``inputSchema``) for its arguments.
We forward that schema directly to the LLM in the OpenAI-compatible
function-calling shape, and route invocations back through the live
``ClientSession`` held by the :class:`MCPManager`.

Tool names follow the convention ``<server>_<tool>`` so the originating MCP
server remains obvious while avoiding the extra ``mcp_`` prefix.
"""

from __future__ import annotations

import base64
import mimetypes
from typing import TYPE_CHECKING, Any

from loguru import logger
from pydantic import BaseModel

from app.agent.errors import ToolExecutionError
from app.agent.schemas.chat import ContentBlock, ImageDataBlock, TextBlock, ToolResult
from app.agent.tools.registry import Tool
from app.agent.tools.schema import sanitize_tool_schema as _sanitize_schema

if TYPE_CHECKING:
    from mcp import ClientSession
    from mcp.types import Tool as MCPToolDef


MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"


class _NoopParameters(BaseModel):
    """Placeholder Pydantic model — MCPTool does not use base-class validation."""

    model_config = {"extra": "allow"}


class MCPTool(Tool):
    """A :class:`Tool` whose schema and execution are sourced from an MCP server.

    Unlike the base ``Tool``, the JSON Schema comes from the MCP server's
    ``inputSchema`` rather than being derived from a Python function signature.
    Calls are forwarded to ``session.call_tool(remote_name, args)``.

    The adapter goes through ``super().__init__`` (overriding :meth:`_build`)
    so every base ``Tool`` attribute — ``_args_schema``, ``_model_param``,
    ``_description_factory``, the metadata dunders — is initialised by the
    parent. This keeps the subclass in lockstep with the base contract instead
    of re-implementing it by hand.
    """

    def __init__(
        self,
        *,
        server_name: str,
        mcp_tool: "MCPToolDef",
        session_provider: "_SessionProvider",
    ) -> None:
        # These are read by the overridden ``_build`` below, so they must be
        # set before ``super().__init__`` (which calls ``_build``).
        self._server_name = server_name
        self._remote_name = mcp_tool.name
        self._session_provider = session_provider
        self._mcp_tool = mcp_tool

        local_name = f"{server_name}_{mcp_tool.name}"
        description = (
            mcp_tool.description
            or f"Tool '{mcp_tool.name}' from MCP server '{server_name}'."
        )

        # ``_invoke`` is the underlying callable — keeps repr / __wrapped__
        # behaviour and lets the base ``__init__`` derive metadata consistently.
        super().__init__(self._invoke, name=local_name, description=description)

        # Surface the server-provided description as the introspection docstring
        # (the base would otherwise inherit ``_invoke``'s internal docstring).
        self.__doc__ = description

    def _build(self) -> tuple[type[BaseModel], dict[str, Any], set[str]]:
        """Override base schema synthesis with the MCP server's ``inputSchema``.

        The base ``Tool`` derives parameters from a Python signature; an MCP
        tool instead ships its own JSON Schema. We return a no-op validation
        model (``arun`` is fully overridden, so it is never used) alongside the
        server-sourced definition and an empty injected-param set.
        """
        parameters = _sanitize_schema(getattr(self._mcp_tool, "input_schema", None))
        definition: dict[str, Any] = {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self._custom_description,
                "parameters": parameters,
            },
        }
        return _NoopParameters, definition, set()

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

        if getattr(result, "is_error", False):
            text = _extract_text(result.content)
            raise ToolExecutionError(
                f"MCP tool '{self.name}' returned error: {text or '(no message)'}"
            )

        parts = _extract_parts(result.content)
        has_images = any(isinstance(p, ImageDataBlock) for p in parts)
        text_summary = _extract_text(result.content)

        mcp_app_meta = _get_ui_meta(self._mcp_tool)
        resource_uri = mcp_app_meta.get("resourceUri")

        if resource_uri:
            try:
                resource = await session.read_resource(resource_uri)
                app_resource = _extract_app_resource(resource, resource_uri)

                if app_resource is not None:
                    if app_resource.get("resourceMeta") is None:
                        app_resource["resourceMeta"] = await _get_listing_resource_meta(
                            session, resource_uri
                        )
                    app_parts = list(parts)
                    if not any(isinstance(p, TextBlock) for p in app_parts):
                        app_parts.insert(0, TextBlock(text=text_summary))
                    return ToolResult(
                        parts=app_parts,
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

        if has_images:
            return ToolResult(parts=parts)

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
        mime_type = getattr(content, "mime_type", None)
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
    ``EmbeddedResource``).
    """
    if not content:
        return ""
    if not isinstance(content, list):
        return str(content)

    parts: list[str] = []
    for block in content:
        block_type = _get_block_type(block)
        if block_type == "text":
            parts.append(_get_text(block) or "")
        elif block_type == "image":
            mime = _get_mime_type(block) or "image/*"
            parts.append(f"[image: {mime}]")
        elif block_type == "resource":
            res = _get_resource(block)
            uri = (
                (res.get("uri") if isinstance(res, dict) else getattr(res, "uri", None))
                if res
                else None
            ) or "?"
            parts.append(f"[resource: {uri}]")
        else:
            parts.append(str(block))
    return "\n".join(parts)


def _normalize_image_mime(mime: str | None) -> str:
    """Normalize an image MIME type string to a standard media_type."""
    if not mime:
        return "image/png"
    clean = mime.split(";")[0].strip().lower()
    if clean == "image/jpg":
        return "image/jpeg"
    if "/" not in clean:
        if clean in ("jpg", "jpeg"):
            return "image/jpeg"
        return f"image/{clean}"
    return clean


def _get_block_type(block: Any) -> str | None:
    if isinstance(block, dict):
        return block.get("type")
    return getattr(block, "type", None)


def _get_mime_type(item: Any) -> str | None:
    if isinstance(item, dict):
        return item.get("mime_type") or item.get("mimeType")
    return getattr(item, "mime_type", None) or getattr(item, "mimeType", None)


def _get_data(item: Any) -> str | None:
    if isinstance(item, dict):
        return item.get("data")
    return getattr(item, "data", None)


def _get_text(item: Any) -> str | None:
    if isinstance(item, dict):
        return item.get("text")
    return getattr(item, "text", None)


def _get_resource(block: Any) -> Any:
    if isinstance(block, dict):
        return block.get("resource")
    return getattr(block, "resource", None)


def _extract_parts(content: Any) -> list[ContentBlock]:
    """Extract structured ContentBlock items from MCP CallToolResult.content.

    Translates:
    - Text blocks -> TextBlock
    - Image blocks (with base64 data) -> ImageDataBlock
    - Embedded resources with image MIME types and base64 blobs -> ImageDataBlock
    - Embedded resources with text -> TextBlock
    - Other resources / unknown blocks -> TextBlock
    """
    if not content:
        return []
    if not isinstance(content, list):
        return [TextBlock(text=str(content))]

    parts: list[ContentBlock] = []
    for block in content:
        block_type = _get_block_type(block)
        if block_type == "text":
            text = _get_text(block) or ""
            parts.append(TextBlock(text=text))
        elif block_type == "image":
            data = _get_data(block)
            mime = _get_mime_type(block)
            if data and isinstance(data, str):
                parts.append(
                    ImageDataBlock(
                        data=data,
                        media_type=_normalize_image_mime(mime),
                    )
                )
            else:
                parts.append(TextBlock(text=f"[image: {mime or 'image/*'}]"))
        elif block_type == "resource":
            res = _get_resource(block)
            blob = (
                (
                    res.get("blob")
                    if isinstance(res, dict)
                    else getattr(res, "blob", None)
                )
                if res
                else None
            )
            mime = _get_mime_type(res) if res else None
            uri = (
                (res.get("uri") if isinstance(res, dict) else getattr(res, "uri", None))
                if res
                else None
            ) or "?"
            if not mime and uri and uri != "?":
                mime = mimetypes.guess_type(uri)[0]

            if (
                blob
                and isinstance(blob, str)
                and mime
                and (mime.startswith("image/") or "/" not in mime)
            ):
                parts.append(
                    ImageDataBlock(
                        data=blob,
                        media_type=_normalize_image_mime(mime),
                    )
                )
            else:
                res_text = (
                    (
                        res.get("text")
                        if isinstance(res, dict)
                        else getattr(res, "text", None)
                    )
                    if res
                    else None
                )
                if res_text:
                    parts.append(TextBlock(text=res_text))
                else:
                    parts.append(TextBlock(text=f"[resource: {uri}]"))
        else:
            parts.append(TextBlock(text=str(block)))

    return parts


# ── Type alias for the session-resolution callback ──────────────────────────
# Defined at module bottom to avoid a forward reference in MCPTool.__init__.

from typing import Callable, Optional  # noqa: E402

_SessionProvider = Callable[[], Optional["ClientSession"]]
