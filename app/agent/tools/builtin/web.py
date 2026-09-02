import asyncio
from dataclasses import dataclass
from enum import StrEnum
import ipaddress
import socket
from typing import Any, Literal

import anydoc
import httpcore
import httpx
from ddgs import DDGS
from httpcore._backends.anyio import AnyIOBackend
from loguru import logger
from pydantic import AliasChoices, BaseModel, Field, field_validator

from app.agent.tools.registry import tool
from app.core.config import settings

_MAX_RESPONSE_MB = 50
_MAX_RESPONSE_BYTES = _MAX_RESPONSE_MB * 1024 * 1024
_DEFAULT_TIMEOUT = 30.0
_MAX_TIMEOUT = 120.0
_MAX_REDIRECTS = 10
# Keep the pool modest: every session shares one client, and idle keep-alive
# sockets to dozens of hosts are not worth holding open.
_CLIENT_LIMITS = httpx.Limits(max_connections=20, max_keepalive_connections=10)

WebFetchFormat = Literal["markdown", "html", "text", "raw"]

_ACCEPT_HEADERS: dict[str, str] = {
    "markdown": "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
    "html": "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1",
    "text": "text/plain;q=1.0, text/html;q=0.9, */*;q=0.1",
    "raw": "text/plain;q=1.0, text/html;q=0.9, */*;q=0.1",
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
_GENERIC_MIMES = frozenset(
    {None, "", "application/octet-stream", "binary/octet-stream"}
)


class FetchErrorKind(StrEnum):
    NOT_FOUND = "not_found"
    ACCESS_DENIED = "access_denied"
    RATE_LIMITED = "rate_limited"
    SERVER_ERROR = "server_error"
    TIMEOUT = "timeout"
    NETWORK_ERROR = "network_error"
    TOO_MANY_REDIRECTS = "too_many_redirects"
    TOO_LARGE = "too_large"
    UNSAFE_URL = "unsafe_url"
    CONVERSION_ERROR = "conversion_error"


@dataclass(slots=True)
class FetchError:
    kind: FetchErrorKind
    message: str
    retryable: bool
    status_code: int | None = None
    hint: str | None = None


class FetchFailure(Exception):
    """Internal exception carrying a concise, typed fetch failure."""

    def __init__(self, error: FetchError):
        super().__init__(error.message)
        self.error = error


class ResponseTooLarge(FetchFailure):
    def __init__(self, size: int, limit: int):
        super().__init__(
            FetchError(
                kind=FetchErrorKind.TOO_LARGE,
                message="Response too large.",
                retryable=False,
                hint=f"The response exceeded the {_MAX_RESPONSE_MB} MB limit "
                f"({size} bytes received; limit {limit} bytes).",
            )
        )


class UnsafeURL(FetchFailure):
    def __init__(self, message: str):
        super().__init__(
            FetchError(
                kind=FetchErrorKind.UNSAFE_URL,
                message="Unsafe URL.",
                retryable=False,
                hint=message,
            )
        )


class PrivateDestinationError(httpcore.ConnectError):
    """Raised by the network backend when a connect target is non-public.

    Subclassing ``httpcore.ConnectError`` lets httpx map it to
    ``httpx.ConnectError`` (with this instance as ``__cause__``) so the fetch
    loop can surface it as an unsafe-URL result rather than a network blip.
    """


@dataclass(slots=True)
class FetchResult:
    requested_url: str
    final_url: str
    status_code: int
    content_type: str | None
    charset: str | None
    content: bytes
    redirect_count: int = 0


@dataclass(slots=True)
class ProcessedContent:
    content: str
    mime: str | None
    charset: str | None


def _is_textual(mime: str | None) -> bool:
    """Whether ``mime`` denotes text that can be decoded directly."""
    if mime is None:
        return False
    return mime.startswith("text/") or mime in _TEXTUAL_MIMES


def _dropped_page_content(html: str, extracted: str | None) -> bool:
    """Whether extraction lost enough of the page to be worth redoing."""
    if not extracted or not extracted.strip():
        return True
    return "<pre" in html.lower() and "```" not in extracted


def _html_to_markdown(html: str) -> str:
    """Convert an HTML page to Markdown while dropping navigation and scripts."""
    # Deferred: trafilatura is ~320 ms of the sidecar's cold import and only
    # needed once a fetch actually converts HTML. Runs under ``to_thread``.
    import trafilatura

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


def _html_to_text(html: str) -> str:
    """Extract readable text from HTML without Markdown formatting."""
    import trafilatura

    if "<body" not in html.lower():
        html = f"<html><body>{html}</body></html>"
    return trafilatura.html2txt(html) or ""


def _resolve_charset(content_bytes: bytes, declared: str | None) -> str | None:
    """Return an encoding that decodes the complete response body."""

    def _decodes(name: str | None) -> bool:
        if not name:
            return False
        try:
            content_bytes.decode(name)
        except (UnicodeDecodeError, LookupError):
            return False
        return True

    if _decodes(declared):
        return declared
    if _decodes("utf-8"):
        return "utf-8"

    from charset_normalizer import from_bytes

    best = from_bytes(content_bytes).best()
    detected = None if best is None else best.encoding
    return detected if _decodes(detected) else None


def _parse_content_type(content_type: str | None) -> tuple[str | None, str | None]:
    if not content_type:
        return None, None
    parts = [part.strip() for part in content_type.split(";")]
    mime = parts[0].lower() or None
    charset = None
    for part in parts[1:]:
        name, separator, value = part.partition("=")
        if separator and name.strip().lower() == "charset":
            charset = value.strip().strip('"') or None
    return mime, charset


def _looks_like_text(data: bytes) -> bool:
    if b"\x00" in data:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def _sniff_mime(content: bytes) -> str | None:
    sample = content[:8192]
    stripped = sample.lstrip()
    lower = stripped.lower()
    if stripped.startswith(b"%PDF-"):
        return "application/pdf"
    if (
        lower.startswith(b"<!doctype html")
        or lower.startswith(b"<html")
        or b"<html" in lower[:1024]
    ):
        return "text/html"
    if lower.startswith(b"<?xml"):
        return "application/xml"
    if _looks_like_text(sample):
        return "text/plain"
    return None


def _effective_mime(declared: str | None, content: bytes) -> str | None:
    return _sniff_mime(content) if declared in _GENERIC_MIMES else declared


def _process_content(
    content: bytes,
    *,
    content_type: str | None,
    output_format: WebFetchFormat,
) -> ProcessedContent:
    declared_mime, declared_charset = _parse_content_type(content_type)
    mime = _effective_mime(declared_mime, content)
    textual = _is_textual(mime)
    charset = _resolve_charset(content, declared_charset) if textual else None
    decoded = content.decode(charset or "utf-8", errors="replace") if textual else None

    if output_format == "raw":
        if not textual:
            raise FetchFailure(
                FetchError(
                    FetchErrorKind.CONVERSION_ERROR,
                    "Cannot return raw binary content.",
                    False,
                    hint=f"The response is {mime or 'binary data'}. Use "
                    'format="markdown" or format="text" instead.',
                )
            )
        return ProcessedContent(decoded or "", mime, charset)

    if output_format == "html":
        if mime not in _HTML_MIMES:
            raise FetchFailure(
                FetchError(
                    FetchErrorKind.CONVERSION_ERROR,
                    "Cannot return HTML for this content type.",
                    False,
                    hint=f"The response is {mime or 'unknown content'}. Use "
                    'format="markdown" or format="text" instead.',
                )
            )
        return ProcessedContent(decoded or "", mime, charset)

    if textual and mime in {"text/markdown", "text/x-markdown"}:
        return ProcessedContent(decoded or "", mime, charset)
    if textual and mime in _HTML_MIMES:
        converted = (
            _html_to_markdown(decoded or "")
            if output_format == "markdown"
            else _html_to_text(decoded or "")
        )
        return ProcessedContent(converted, mime, charset)
    if textual:
        return ProcessedContent(decoded or "", mime, charset)
    try:
        return ProcessedContent(anydoc.to_markdown_bytes(content).strip(), mime, None)
    except FetchFailure:
        raise
    except Exception as exc:
        raise FetchFailure(
            FetchError(
                FetchErrorKind.CONVERSION_ERROR,
                "Content conversion failed.",
                False,
                hint=str(exc),
            )
        ) from exc


async def _resolve_host(host: str, port: int | None) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


async def _validate_fetch_destination(
    url: httpx.URL,
) -> None:
    """Reject schemes, credentials, and (by default) non-public destinations.

    This is the early, friendly gate: it fails before any connection is
    attempted and names the offending address. It is not the enforcement
    point — a rebinding DNS server could answer public here and private a
    moment later. ``_PublicOnlyBackend`` re-validates at connect time and
    pins the socket to the address it validated, so the two lookups cannot
    disagree about what gets connected to.
    """
    scheme = url.scheme.lower()
    if scheme not in {"http", "https"}:
        raise UnsafeURL("Only http:// and https:// URLs are supported.")
    if not url.host:
        raise UnsafeURL("The URL has no host.")
    if url.userinfo:
        raise UnsafeURL("URLs containing embedded credentials are not allowed.")
    if settings.WEB_FETCH_ALLOW_PRIVATE_NETWORK:
        return
    try:
        addresses = await _resolve_host(url.host, url.port)
    except OSError as exc:
        raise FetchFailure(
            FetchError(
                FetchErrorKind.NETWORK_ERROR,
                "Network error.",
                True,
                hint=f"DNS resolution failed: {exc}",
            )
        ) from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise UnsafeURL(
                f"The destination resolves to a non-public address ({address})."
            )


def _http_error(response: httpx.Response) -> FetchError:
    status = response.status_code
    reason = response.reason_phrase or "HTTP error"
    if status in {404, 410}:
        return FetchError(
            FetchErrorKind.NOT_FOUND,
            f"{status} {reason}.",
            False,
            status,
            "The page may have moved or been removed. Use web_search to find the current URL.",
        )
    if status in {401, 403}:
        return FetchError(
            FetchErrorKind.ACCESS_DENIED,
            f"{status} {reason}.",
            False,
            status,
            "The server denied the request or requires authentication/browser access.",
        )
    if status == 429:
        return FetchError(
            FetchErrorKind.RATE_LIMITED,
            "429 Too Many Requests.",
            True,
            status,
            "The server is rate limiting requests. Retry later or use another source.",
        )
    retryable = status in {408, 425} or status >= 500
    return FetchError(
        FetchErrorKind.SERVER_ERROR if status >= 500 else FetchErrorKind.NETWORK_ERROR,
        f"{status} {reason}.",
        retryable,
        status,
        (
            "Retrying may succeed."
            if retryable
            else "Check the URL and request parameters."
        ),
    )


def _render_fetch_error(error: FetchError) -> str:
    lines = [f"Fetch failed: {error.message}"]
    if error.hint:
        lines.append(error.hint)
    return "\n".join(lines)


def _browser_challenge(response: httpx.Response) -> bool:
    return (
        response.status_code == 403
        and response.headers.get("cf-mitigated", "").lower() == "challenge"
    )


async def _read_limited_response(response: httpx.Response, *, max_bytes: int) -> bytes:
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError:
            declared_size = None
        if declared_size is not None and declared_size > max_bytes:
            raise ResponseTooLarge(declared_size, max_bytes)

    chunks: list[bytes] = []
    received = 0
    async for chunk in response.aiter_bytes():
        received += len(chunk)
        if received > max_bytes:
            raise ResponseTooLarge(received, max_bytes)
        chunks.append(chunk)
    return b"".join(chunks)


class _PublicOnlyBackend(AnyIOBackend):
    """httpcore network backend that validates and pins the connect address.

    httpcore hands us the URL host; we resolve it, refuse if any answer is
    non-public, then connect to the validated literal so the kernel does not
    resolve again. TLS is unaffected: httpcore wraps the returned stream with
    ``server_hostname`` taken from the URL, so certificates are still checked
    against the hostname, not the IP. Addresses are tried in order so an
    unreachable first answer still falls back to the next.
    """

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        if settings.WEB_FETCH_ALLOW_PRIVATE_NETWORK:
            return await super().connect_tcp(
                host, port, timeout, local_address, socket_options
            )
        try:
            addresses = await _resolve_host(host, port)
        except OSError as exc:
            raise httpcore.ConnectError(
                f"DNS resolution failed for {host}: {exc}"
            ) from exc
        if not addresses:
            raise httpcore.ConnectError(
                f"DNS resolution returned no addresses for {host}"
            )
        for address in addresses:
            if not ipaddress.ip_address(address).is_global:
                raise PrivateDestinationError(
                    f"{host} resolved to a non-public address ({address})."
                )
        last_error: Exception | None = None
        for address in addresses:
            try:
                return await super().connect_tcp(
                    address, port, timeout, local_address, socket_options
                )
            except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                last_error = exc
        assert last_error is not None
        raise last_error


class _PinnedTransport(httpx.AsyncHTTPTransport):
    """``AsyncHTTPTransport`` whose connection pool opens sockets through
    ``_PublicOnlyBackend``. httpx does not expose ``network_backend`` on the
    transport, so the pool's backend is swapped before its first connection."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        pool = self._pool
        if not isinstance(pool, httpcore.AsyncConnectionPool):  # pragma: no cover
            raise RuntimeError("web_fetch transport requires a direct connection pool")
        pool._network_backend = _PublicOnlyBackend()


_http_client: httpx.AsyncClient | None = None
_http_client_loop: asyncio.AbstractEventLoop | None = None


def _get_http_client() -> httpx.AsyncClient:
    """Return the shared fetch client, creating it on first use.

    Redirects are followed manually so every hop is re-validated; the client
    is shared so repeated fetches to one host reuse its keep-alive socket
    instead of paying a fresh TCP+TLS handshake per call. Pooled sockets are
    bound to the loop that opened them, so a client from a previous loop
    (per-test loops, CLI one-shots) is discarded rather than reused.
    """
    global _http_client, _http_client_loop
    loop = asyncio.get_running_loop()
    if _http_client is None or _http_client.is_closed or _http_client_loop is not loop:
        _http_client = httpx.AsyncClient(
            follow_redirects=False,
            timeout=_DEFAULT_TIMEOUT,
            transport=_PinnedTransport(verify=True, limits=_CLIENT_LIMITS),
        )
        _http_client_loop = loop
    return _http_client


async def close_http_client() -> None:
    """Close the shared client. Called from the API lifespan on shutdown."""
    global _http_client
    client, _http_client = _http_client, None
    if client is not None and not client.is_closed:
        await client.aclose()


async def _fetch_url(
    url: httpx.URL,
    *,
    headers: dict[str, str],
    timeout: float,
) -> FetchResult:
    requested_url = str(url)
    current_url = url
    redirects = 0
    client = _get_http_client()

    while True:
        await _validate_fetch_destination(current_url)
        try:
            async with client.stream(
                "GET", current_url, headers=headers, timeout=timeout
            ) as response:
                if _browser_challenge(response):
                    raise FetchFailure(
                        FetchError(
                            FetchErrorKind.ACCESS_DENIED,
                            "Browser verification required.",
                            False,
                            response.status_code,
                            "Direct HTTP fetching was blocked by anti-bot protection. "
                            "Try another source or use a browser-capable tool.",
                        )
                    )
                if 300 <= response.status_code < 400:
                    location = response.headers.get("location")
                    if not location:
                        raise FetchFailure(_http_error(response))
                    if redirects >= _MAX_REDIRECTS:
                        raise FetchFailure(
                            FetchError(
                                FetchErrorKind.TOO_MANY_REDIRECTS,
                                "Too many redirects.",
                                False,
                                hint="The URL redirected more than the allowed limit.",
                            )
                        )
                    current_url = response.url.join(location)
                    redirects += 1
                    continue
                if response.status_code >= 400:
                    raise FetchFailure(_http_error(response))
                content = await _read_limited_response(
                    response, max_bytes=_MAX_RESPONSE_BYTES
                )
                content_type = response.headers.get("content-type")
                _, charset = _parse_content_type(content_type)
                return FetchResult(
                    requested_url=requested_url,
                    final_url=str(response.url),
                    status_code=response.status_code,
                    content_type=content_type,
                    charset=charset,
                    content=content,
                    redirect_count=redirects,
                )
        except FetchFailure:
            raise
        except httpx.TimeoutException as exc:
            raise FetchFailure(
                FetchError(
                    FetchErrorKind.TIMEOUT,
                    "Request timed out.",
                    True,
                    hint="The request timed out. Retrying may succeed.",
                )
            ) from exc
        except httpx.TooManyRedirects as exc:
            raise FetchFailure(
                FetchError(
                    FetchErrorKind.TOO_MANY_REDIRECTS,
                    "Too many redirects.",
                    False,
                )
            ) from exc
        except httpx.InvalidURL as exc:
            raise UnsafeURL(str(exc)) from exc
        except httpx.ConnectError as exc:
            if isinstance(exc.__cause__, PrivateDestinationError):
                raise UnsafeURL(str(exc.__cause__)) from exc
            raise FetchFailure(
                FetchError(
                    FetchErrorKind.NETWORK_ERROR,
                    "Network error.",
                    True,
                    hint="The request could not reach the server. Retrying may succeed.",
                )
            ) from exc
        except httpx.RequestError as exc:
            raise FetchFailure(
                FetchError(
                    FetchErrorKind.NETWORK_ERROR,
                    "Network error.",
                    True,
                    hint="The request could not reach the server. Retrying may succeed.",
                )
            ) from exc


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


@tool(name="web_search", description="Search the web.", args_schema=WebSearchArgs)
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
    format: WebFetchFormat = Field(  # noqa: A003
        default="markdown", description="Output format: markdown, html, text, or raw."
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
        if "://" not in v:
            v = "https://" + v
        parsed = httpx.URL(v)
        if parsed.scheme not in {"http", "https"} or not parsed.host:
            raise ValueError("url must be an http(s) URL with a host")
        return v


@tool(
    name="web_fetch",
    description="Fetch a URL and convert its content to markdown, text, HTML, or raw output.",
    args_schema=WebFetchArgs,
)
async def web_fetch(
    url: str,
    format: WebFetchFormat = "markdown",  # noqa: A002
    timeout: int | None = None,
) -> str:
    """Fetch a URL, enforce network/content safety, and convert its response."""
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    timeout_s = min(float(timeout) if timeout else _DEFAULT_TIMEOUT, _MAX_TIMEOUT)
    headers = {
        "User-Agent": _USER_AGENT,
        "Accept": _ACCEPT_HEADERS[format],
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        fetched = await _fetch_url(httpx.URL(url), headers=headers, timeout=timeout_s)
        if fetched.status_code == 204:
            return "Fetch succeeded but the server returned no content."
        if not fetched.content:
            return "Fetch succeeded but the response body was empty."
        try:
            processed = await asyncio.to_thread(
                _process_content,
                fetched.content,
                content_type=fetched.content_type,
                output_format=format,
            )
        except FetchFailure:
            raise
        except Exception as exc:
            raise FetchFailure(
                FetchError(
                    FetchErrorKind.CONVERSION_ERROR,
                    "Content conversion failed.",
                    False,
                    hint=str(exc),
                )
            ) from exc
        if not processed.content.strip():
            return (
                "Fetch succeeded, but no readable page content could be extracted. "
                "The page may require JavaScript rendering."
            )
        return processed.content
    except FetchFailure as exc:
        return _render_fetch_error(exc.error)
    except Exception as exc:
        logger.debug("web_fetch_unclassified_error url={} error={}", url, exc)
        return _render_fetch_error(
            FetchError(
                FetchErrorKind.NETWORK_ERROR,
                "Network error.",
                True,
                hint="The request failed unexpectedly. Retrying may succeed.",
            )
        )
