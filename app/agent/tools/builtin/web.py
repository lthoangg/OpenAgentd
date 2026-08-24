import asyncio
from typing import Any, Literal

import anydoc
import httpx
import trafilatura
from ddgs import DDGS
from loguru import logger
from pydantic import AliasChoices, BaseModel, Field, field_validator

from app.agent.tools.registry import tool

_MAX_RESPONSE_MB = 50
_MAX_RESPONSE_BYTES = _MAX_RESPONSE_MB * 1024 * 1024
_DEFAULT_TIMEOUT = 30.0
_MAX_TIMEOUT = 120.0

_ACCEPT_HEADERS: dict[str, str] = {
    "markdown": "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
    "html": "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
    "text": "text/plain;q=1.0, text/html;q=0.9, */*;q=0.1",
}

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/143.0.0.0 Safari/537.36"
)


_TEXTUAL_MIMES = frozenset(
    {
        "application/json",
        "application/xml",
        "application/xhtml+xml",
        "application/markdown",
        "application/javascript",
    }
)


_HTML_MIMES = frozenset({"text/html", "application/xhtml+xml"})


def _is_textual(mime: str | None) -> bool:
    """Whether ``mime`` denotes text that can be decoded directly."""
    if mime is None:
        return False
    return mime.startswith("text/") or mime in _TEXTUAL_MIMES


def _dropped_page_content(html: str, extracted: str | None) -> bool:
    """Whether extraction lost enough of the page to be worth redoing.

    Boilerplate removal prunes elements that look like navigation, which
    includes tabbed code widgets built as custom elements with
    ``role="tablist"`` — the pattern Astro Starlight and Docusaurus use for
    per-package-manager install commands. A page whose source clearly has code
    blocks but whose extraction has none has lost them.
    """
    if not extracted or not extracted.strip():
        return True
    return "<pre" in html.lower() and "```" not in extracted


def _html_to_markdown(html: str) -> str:
    """Convert an HTML page to Markdown, keeping the article and dropping chrome.

    Extraction typically returns a third of the raw page — navigation,
    sidebars, and inline ``<script>``/``<style>`` bodies are all discarded —
    which is the difference between a docs page costing 10 KB of context and
    costing 1 MB. ``html2txt`` is the greedy fallback for pages where that
    pruning goes too far.
    """
    # A bare fragment (an htmx partial, a short error body) has no document
    # element, and trafilatura discards it entirely. Wrapping costs nothing on
    # a full page because the parser keeps the inner document.
    if "<body" not in html.lower():
        html = f"<html><body>{html}</body></html>"

    extracted = trafilatura.extract(
        html,
        output_format="markdown",
        include_tables=True,
        include_links=True,
    )
    if _dropped_page_content(html, extracted):
        return trafilatura.html2txt(html) or (extracted or "")
    return extracted or ""


def _resolve_charset(content_bytes: bytes, declared: str | None) -> str | None:
    """Return an encoding that decodes *all* of ``content_bytes``, else ``None``.

    MarkItDown sniffs only the first 4 KB, so an ASCII-looking prefix makes it
    decode the whole body as ASCII and raise ``UnicodeDecodeError`` on the first
    multi-byte character later in the stream. Validating against the full payload
    here avoids that mislabelling, and rejects a wrongly declared charset.
    """

    def _decodes(name: str | None) -> bool:
        if not name:
            return False
        try:
            content_bytes.decode(name)
        except (UnicodeDecodeError, LookupError):
            return False
        return True

    # Trust the declared charset only if it decodes the whole body; utf-8 covers
    # the overwhelming majority of the rest, so only sniff when both fail.
    if _decodes(declared):
        return declared
    if _decodes("utf-8"):
        return "utf-8"

    from charset_normalizer import from_bytes

    best = from_bytes(content_bytes).best()
    detected = None if best is None else best.encoding
    return detected if _decodes(detected) else None


class WebSearchArgs(BaseModel):
    """Arguments for the web_search tool."""

    query: str = Field(
        validation_alias=AliasChoices("query", "q", "search_query"),
        description="Search query string.",
    )
    max_results: int = Field(default=5, ge=1, le=20, description="Results to return.")
    page: int = Field(default=1, ge=1, description="Results page number.")
    safesearch: Literal["on", "moderate", "off"] = Field(
        default="moderate", description="Safe-search setting."
    )


@tool(
    name="web_search",
    description="Search the web.",
    args_schema=WebSearchArgs,
)
async def web_search(
    query: str,
    max_results: int = 5,
    page: int = 1,
    safesearch: Literal["on", "moderate", "off"] = "moderate",
) -> list[dict[str, Any]] | str:
    """Search the web via DDGS with an Exa fallback."""
    results = None
    backends = ["auto", "brave", "wikipedia", "mojeek"]
    for backend in backends:
        try:
            loop = asyncio.get_running_loop()
            results = await loop.run_in_executor(
                None,
                lambda b=backend: DDGS().text(
                    query,
                    max_results=max_results,
                    page=page,
                    safesearch=safesearch,
                    backend=b,
                ),
            )
            if results:
                logger.info(f"Web search succeeded with backend: {backend}")
                break
        except Exception as e:
            logger.debug(f"Web search failed with backend {backend}: {str(e)}")

    if results:
        return results

    logger.debug(
        "DDGS search failed or returned no results, falling back to Exa search"
    )
    # Fallback to Exa search tool if DDGS fails or returns no results
    url = "https://mcp.exa.ai/mcp"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    data = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "search",
            "arguments": {"query": query, "numResults": max_results},
        },
    }
    try:
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
            response = await client.post(url, headers=headers, json=data)
            response.raise_for_status()
            result = response.json()
            if "error" in result:
                logger.debug(f"Exa search error: {result['error']}")
                return f"Error: {result['error']}"
            return result.get("result", [])
    except Exception as e:
        logger.debug(f"Error during Exa search: {str(e)}")
        return "No result found"


class WebFetchArgs(BaseModel):
    """Arguments for the web_fetch tool."""

    url: str = Field(
        validation_alias=AliasChoices("url", "uri", "link"),
        description="URL to fetch. https:// prepended if no scheme.",
    )
    format: Literal["markdown", "html", "text"] = Field(  # noqa: A003
        default="markdown", description="Output format."
    )
    timeout: int | None = Field(
        default=None,
        ge=1,
        le=120,
        description="Request timeout in seconds.",
    )

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        if not v.startswith(("http://", "https://")):
            return "https://" + v
        return v


@tool(
    name="web_fetch",
    description="Fetch a URL and convert its content to the requested format.",
    args_schema=WebFetchArgs,
)
async def web_fetch(
    url: str,
    format: Literal["markdown", "html", "text"] = "markdown",  # noqa: A002
    timeout: int | None = None,
) -> str:
    """Fetch a URL and convert its content to the requested format."""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    timeout_s = min(float(timeout) if timeout else _DEFAULT_TIMEOUT, _MAX_TIMEOUT)

    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": _ACCEPT_HEADERS[format],
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        async with httpx.AsyncClient(
            follow_redirects=True, verify=True, timeout=timeout_s
        ) as client:
            response = await client.get(url, headers=headers)

            # Cloudflare bot-detection retry with honest UA
            if (
                response.status_code == 403
                and response.headers.get("cf-mitigated") == "challenge"
            ):
                logger.debug("web_fetch_cloudflare_retry url={}", url)
                response = await client.get(
                    url, headers={**headers, "User-Agent": "opencode"}
                )

            response.raise_for_status()

            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > _MAX_RESPONSE_BYTES:
                return (
                    "Error: Response too large "
                    f"(content-length {content_length} exceeds "
                    f"{_MAX_RESPONSE_MB} MB limit)"
                )

            content_bytes = response.content
            if len(content_bytes) > _MAX_RESPONSE_BYTES:
                return (
                    "Error: Response too large "
                    f"({len(content_bytes)} bytes exceeds "
                    f"{_MAX_RESPONSE_MB} MB limit)"
                )

            content_type = response.headers.get("content-type", "")
            declared_charset = response.charset_encoding

        mime = content_type.split(";")[0].strip().lower() or None
        textual = _is_textual(mime)
        # Resolve the charset against the whole body rather than a prefix, so a
        # multi-byte character late in the stream cannot break the decode.
        charset = _resolve_charset(content_bytes, declared_charset) if textual else None

        # If the response is already markdown, return it as-is
        if mime in ("text/markdown", "text/x-markdown"):
            # ``errors="replace"`` only bites when nothing decoded cleanly.
            return content_bytes.decode(charset or "utf-8", errors="replace")

        def _convert() -> str:
            if mime in _HTML_MIMES:
                return _html_to_markdown(
                    content_bytes.decode(charset or "utf-8", errors="replace")
                )
            if textual:
                # Source, JSON, CSV: an extractor would mangle these, and the
                # agent wants the bytes as served.
                return content_bytes.decode(charset or "utf-8", errors="replace")
            # Binary payloads — PDF, DOCX, and anydoc's other office formats.
            return anydoc.to_markdown_bytes(content_bytes).strip()

        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, _convert)
        except Exception as e:
            # Text payloads are still useful even when conversion fails (for
            # example a mislabelled charset), so fall back to a lenient decode
            # rather than losing the whole response.
            if textual:
                logger.debug(
                    "web_fetch_conversion_fallback url={} error={}", url, str(e)
                )
                return content_bytes.decode(charset or "utf-8", errors="replace")
            raise

    except Exception as e:
        return f"Error fetching or converting: {str(e)}"
