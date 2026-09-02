from unittest.mock import patch

import httpx
import pytest
import respx

import app.agent.tools.builtin.web as web_module
from app.agent.tools.builtin.web import web_fetch, web_search


@pytest.fixture(autouse=True)
def _public_dns_for_web_tests(monkeypatch):
    async def resolve(host, port):
        return ["93.184.216.34"]

    monkeypatch.setattr(web_module, "_resolve_host", resolve, raising=False)


@pytest.mark.asyncio
async def test_web_search_success():
    with patch("app.agent.tools.builtin.web.DDGS") as mock_ddgs_class:
        mock_ddgs = mock_ddgs_class.return_value
        mock_ddgs.text.return_value = [{"title": "t", "href": "h", "body": "b"}]

        result = await web_search("query")
        assert len(result) == 1
        assert result[0]["title"] == "t"


@pytest.mark.asyncio
async def test_web_search_exception_returns_string():
    """When DDGS raises and Exa also fails, web_search returns 'No result found'."""
    with patch("app.agent.tools.builtin.web.DDGS") as mock_ddgs_class:
        mock_ddgs = mock_ddgs_class.return_value
        mock_ddgs.text.side_effect = Exception("network error")

        with respx.mock:
            respx.post("https://mcp.exa.ai/mcp").mock(side_effect=Exception("exa down"))
            result = await web_search("failing query")
        assert result == "No result found"


@pytest.mark.asyncio
async def test_web_search_exa_fallback_with_error():
    """When DDGS fails and Exa returns an error, the error message is returned."""
    with patch("app.agent.tools.builtin.web.DDGS") as mock_ddgs_class:
        mock_ddgs = mock_ddgs_class.return_value
        mock_ddgs.text.return_value = None

        with respx.mock:
            respx.post("https://mcp.exa.ai/mcp").mock(
                return_value=httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "error": {"code": -32000, "message": "Invalid query"},
                    },
                )
            )

            result = await web_search("failing query")
            assert "Error:" in result
            assert "Invalid query" in result


@pytest.mark.asyncio
async def test_web_search_exa_fallback_success():
    """When DDGS fails but Exa succeeds, results from Exa are returned."""
    with patch("app.agent.tools.builtin.web.DDGS") as mock_ddgs_class:
        mock_ddgs = mock_ddgs_class.return_value
        mock_ddgs.text.return_value = None

        with respx.mock:
            respx.post("https://mcp.exa.ai/mcp").mock(
                return_value=httpx.Response(
                    200,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": [
                            {"title": "Exa Result", "url": "https://example.com"}
                        ],
                    },
                )
            )

            result = await web_search("test query")
            assert isinstance(result, list)
            assert len(result) == 1
            assert result[0]["title"] == "Exa Result"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_html_converted_to_markdown():
    """HTML responses are extracted to Markdown."""
    url = "https://example.com"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            text="<html><body><h1>Hello</h1></body></html>",
            headers={"content-type": "text/html"},
        )
    )

    assert await web_fetch(url) == "Hello"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_native_markdown_returned_asis():
    """Responses with text/markdown MIME type are returned as-is."""
    url = "https://example.com/readme.md"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            text="# Native Markdown",
            headers={"content-type": "text/markdown"},
        )
    )

    assert await web_fetch(url) == "# Native Markdown"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_no_scheme_prefixed():
    """URL without scheme gets https:// prepended."""
    respx.get("https://example.com").mock(
        return_value=httpx.Response(
            200,
            text="<html><body>Test</body></html>",
            headers={"content-type": "text/html"},
        )
    )

    assert await web_fetch("example.com") == "Test"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_format_html_returns_source():
    """The legacy html format returns source HTML rather than Markdown."""
    url = "https://example.com"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            text="<html><body>Raw</body></html>",
            headers={"content-type": "text/html"},
        )
    )

    assert await web_fetch(url, format="html") == "<html><body>Raw</body></html>"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_http_error_returns_error_string():
    """HTTP errors are concise and actionable rather than HTTPX boilerplate."""
    url = "https://nonexistent-url.com"
    respx.get(url).mock(return_value=httpx.Response(404))

    result = await web_fetch(url)
    assert "Fetch failed: 404 Not Found." in result
    assert "developer.mozilla.org" not in result
    assert "web_search" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_content_length_over_50_mb_is_rejected():
    """Responses above the hard 50 MB safety cap are rejected."""
    url = "https://example.com/bigfile.md"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=b"small",
            headers={
                "content-type": "text/markdown",
                "content-length": str(51 * 1024 * 1024),
            },
        )
    )

    result = await web_fetch(url)

    assert "too large" in result
    assert "50 MB limit" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_allows_11_mb_content_length():
    """The former 5 MB cap no longer rejects an 11 MB response."""
    url = "https://example.com/file.md"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=b"small",
            headers={
                "content-type": "text/markdown",
                "content-length": str(11 * 1024 * 1024),
            },
        )
    )

    result = await web_fetch(url)

    assert result == "small"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_cloudflare_retry():
    """Cloudflare challenges are reported without a disguised retry."""
    url = "https://example.com"
    route = respx.get(url).mock(
        return_value=httpx.Response(403, headers={"cf-mitigated": "challenge"})
    )

    result = await web_fetch(url)

    assert "browser verification" in result.lower()
    assert route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_body_over_limit_without_content_length_is_rejected(
    monkeypatch,
):
    """Oversized bodies without content-length still hit the safety cap."""
    monkeypatch.setattr("app.agent.tools.builtin.web._MAX_RESPONSE_BYTES", 10)
    url = "https://example.com/bigbody.md"
    response = httpx.Response(
        200,
        content=b"abcdefghijk",
        headers={"content-type": "text/markdown"},
    )
    response.headers.pop("content-length", None)
    respx.get(url).mock(return_value=response)

    result = await web_fetch(url)

    assert "too large" in result
    assert "11 bytes" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_late_multibyte_plain_text_without_charset():
    """A multi-byte char after the first 4 KB must not fail with an ascii codec error.

    MarkItDown sniffs the charset from the first 4 KB only. When that prefix is
    pure ASCII it decodes the whole body as ascii and raises UnicodeDecodeError.
    """
    url = "https://example.com/long.txt"
    body = ("a" * 5000 + " em dash \u2014 tail").encode("utf-8")
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=body,
            headers={"content-type": "text/plain"},
        )
    )

    result = await web_fetch(url)

    assert "ascii" not in result
    assert "Fetch failed" not in result
    assert "em dash \u2014 tail" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_late_multibyte_html_without_charset():
    """HTML with a late multi-byte char converts without a decode error."""
    url = "https://example.com/long.html"
    body = (
        "<html><body><p>" + "a" * 5000 + " caf\u00e9 \u2014 done</p></body></html>"
    ).encode("utf-8")
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=body,
            headers={"content-type": "text/html"},
        )
    )

    result = await web_fetch(url)

    assert "Fetch failed" not in result
    assert "caf\u00e9 \u2014 done" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_declared_charset_is_passed_to_markitdown():
    """The charset from the content-type header is forwarded to MarkItDown."""
    url = "https://example.com/latin.txt"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content="caf\u00e9".encode("latin-1"),
            headers={"content-type": "text/plain; charset=latin-1"},
        )
    )

    result = await web_fetch(url)

    assert result == "caf\u00e9"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_native_markdown_late_multibyte():
    """Native markdown responses decode multi-byte content without mangling."""
    url = "https://example.com/readme.md"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=("# " + "a" * 5000 + " \u2014 end").encode("utf-8"),
            headers={"content-type": "text/markdown"},
        )
    )

    result = await web_fetch(url)

    assert result.endswith("\u2014 end")


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_binary_conversion_failure_still_reports_error():
    """Non-text conversion failures remain actionable error strings."""
    url = "https://example.com/broken.pdf"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=b"%PDF-1.4 broken",
            headers={"content-type": "application/pdf"},
        )
    )

    result = await web_fetch(url)

    assert "Fetch failed: Content conversion failed." in result
    # anydoc names the reason rather than failing anonymously.
    assert "PDF" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_text_falls_back_when_conversion_raises_decode_error():
    """A wrong declared charset still yields readable text via the fallback decode."""
    url = "https://example.com/mislabelled.txt"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content="caf\u00e9 \u2014 ok".encode("utf-8"),
            headers={"content-type": "text/plain; charset=ascii"},
        )
    )

    result = await web_fetch(url)

    assert "Fetch failed" not in result
    assert "caf\u00e9 \u2014 ok" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_timeout_capped_at_120():
    """timeout > 120 is capped to 120 seconds."""
    url = "https://example.com"
    respx.get(url).mock(
        return_value=httpx.Response(
            200, text="<p>hi</p>", headers={"content-type": "text/html"}
        )
    )

    assert await web_fetch(url, timeout=9999) == "hi"


@pytest.mark.asyncio
async def test_web_search_accepts_aliases():
    with patch("app.agent.tools.builtin.web.DDGS") as mock_ddgs_class:
        mock_ddgs = mock_ddgs_class.return_value
        mock_ddgs.text.return_value = [{"title": "res", "href": "h", "body": "b"}]
        res1 = await web_search.arun(q="test query")
        assert res1[0]["title"] == "res"
        res2 = await web_search.arun(search_query="test query")
        assert res2[0]["title"] == "res"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_accepts_aliases():
    url = "https://example.com/alias"
    respx.get(url).mock(
        return_value=httpx.Response(
            200, text="<p>alias text</p>", headers={"content-type": "text/html"}
        )
    )
    assert await web_fetch.arun(uri="https://example.com/alias") == "alias text"
    assert await web_fetch.arun(link="https://example.com/alias") == "alias text"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected", "hint"),
    [
        (401, "401 Unauthorized", "authentication"),
        (403, "403 Forbidden", "denied"),
        (410, "410 Gone", "web_search"),
        (429, "429 Too Many Requests", "rate limiting"),
        (500, "500 Internal Server Error", "retry"),
        (502, "502 Bad Gateway", "retry"),
        (503, "503 Service Unavailable", "retry"),
        (504, "504 Gateway Timeout", "retry"),
    ],
)
@respx.mock
async def test_web_fetch_classifies_http_errors(status, expected, hint):
    url = f"https://example.com/status/{status}"
    respx.get(url).mock(return_value=httpx.Response(status))

    result = await web_fetch(url)

    assert f"Fetch failed: {expected}." in result
    assert hint.lower() in result.lower()


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_classifies_network_errors():
    url = "https://example.com/network"
    respx.get(url).mock(side_effect=httpx.ConnectError("dns failed"))

    result = await web_fetch(url)

    assert "Fetch failed: Network error." in result
    assert "retry" in result.lower()


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_classifies_timeouts():
    url = "https://example.com/timeout"
    respx.get(url).mock(side_effect=httpx.ReadTimeout("timed out"))

    result = await web_fetch(url)

    assert "Fetch failed: Request timed out." in result
    assert "retry" in result.lower()


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_redirect_loop_is_classified():
    url = "https://example.com/loop"
    respx.get(url).mock(return_value=httpx.Response(302, headers={"location": url}))

    result = await web_fetch(url)

    assert "Fetch failed: Too many redirects." in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_stream_limit_rejects_body_without_content_length(monkeypatch):
    monkeypatch.setattr(web_module, "_MAX_RESPONSE_BYTES", 10)
    url = "https://example.com/chunked"
    response = httpx.Response(
        200, content=b"abcdefghijk", headers={"content-type": "text/plain"}
    )
    response.headers.pop("content-length", None)
    respx.get(url).mock(return_value=response)

    result = await web_fetch(url)

    assert "Fetch failed: Response too large." in result
    assert "11 bytes" in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_invalid_content_length_is_ignored(monkeypatch):
    monkeypatch.setattr(web_module, "_MAX_RESPONSE_BYTES", 10)
    url = "https://example.com/invalid-length"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=b"small",
            headers={"content-type": "text/plain", "content-length": "unknown"},
        )
    )

    assert await web_fetch(url) == "small"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_raw_and_text_formats_have_distinct_semantics():
    url = "https://example.com/raw"
    html = "<html><body><h1>Title</h1><p>Body</p></body></html>"
    respx.get(url).mock(
        return_value=httpx.Response(
            200, text=html, headers={"content-type": "text/html"}
        )
    )

    assert await web_fetch(url, format="raw") == html
    text_result = await web_fetch(url, format="text")
    assert "Title" in text_result
    assert "Body" in text_result
    assert "<h1>" not in text_result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_sniffs_html_without_specific_content_type():
    url = "https://example.com/sniff.html"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=b"<html><body><h1>Sniffed</h1></body></html>",
            headers={"content-type": "application/octet-stream"},
        )
    )

    assert await web_fetch(url) == "Sniffed"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_empty_results_are_actionable():
    empty = "https://example.com/empty"
    respx.get(empty).mock(return_value=httpx.Response(204))
    result = await web_fetch(empty)
    assert "Fetch succeeded but the server returned no content." in result

    body = "https://example.com/empty-body"
    respx.get(body).mock(return_value=httpx.Response(200, content=b""))
    result = await web_fetch(body)
    assert "Fetch succeeded but the response body was empty." in result


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_metadata_tracks_redirect_and_content_type():
    first = "https://example.com/start"
    final = "https://example.com/final"
    respx.get(first).mock(return_value=httpx.Response(302, headers={"location": final}))
    respx.get(final).mock(
        return_value=httpx.Response(
            200, text="done", headers={"content-type": "text/plain; charset=utf-8"}
        )
    )

    result = await web_module._fetch_url(
        httpx.URL(first), timeout=30.0, headers={"Accept": "text/plain"}
    )

    assert result.requested_url == first
    assert result.final_url == final
    assert result.status_code == 200
    assert result.content_type == "text/plain; charset=utf-8"
    assert result.redirect_count == 1


@pytest.mark.asyncio
async def test_web_fetch_rejects_private_destination(monkeypatch):
    async def resolve(host, port):
        return ["127.0.0.1"]

    monkeypatch.setattr(web_module, "_resolve_host", resolve)

    with pytest.raises(web_module.UnsafeURL):
        await web_module._validate_fetch_destination(httpx.URL("http://example.test"))


@pytest.mark.asyncio
async def test_web_fetch_private_destination_allowed_by_opt_in(monkeypatch):
    """``WEB_FETCH_ALLOW_PRIVATE_NETWORK`` lets a local-first user fetch localhost."""

    async def resolve(host, port):
        return ["127.0.0.1"]

    monkeypatch.setattr(web_module, "_resolve_host", resolve)
    monkeypatch.setattr(web_module.settings, "WEB_FETCH_ALLOW_PRIVATE_NETWORK", True)

    await web_module._validate_fetch_destination(httpx.URL("http://localhost:3000"))


@pytest.mark.asyncio
async def test_web_fetch_opt_in_does_not_relax_scheme_or_credential_checks(
    monkeypatch,
):
    monkeypatch.setattr(web_module.settings, "WEB_FETCH_ALLOW_PRIVATE_NETWORK", True)

    with pytest.raises(web_module.UnsafeURL):
        await web_module._validate_fetch_destination(
            httpx.URL("http://user:pw@localhost:3000")
        )


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_reuses_one_pooled_client():
    """Repeated fetches share a lifecycle-managed client instead of building one per call."""
    await web_module.close_http_client()
    respx.get("https://example.com/a").mock(
        return_value=httpx.Response(
            200, text="a", headers={"content-type": "text/plain"}
        )
    )
    respx.get("https://example.com/b").mock(
        return_value=httpx.Response(
            200, text="b", headers={"content-type": "text/plain"}
        )
    )

    await web_fetch("https://example.com/a")
    first = web_module._get_http_client()
    await web_fetch("https://example.com/b")
    second = web_module._get_http_client()

    assert first is second
    assert not first.is_closed

    await web_module.close_http_client()
    assert first.is_closed
    # A fetch after shutdown transparently opens a fresh client.
    assert await web_fetch("https://example.com/a") == "a"
    assert web_module._get_http_client() is not first
    await web_module.close_http_client()


class _StreamStub:
    pass


@pytest.mark.asyncio
async def test_pinned_backend_connects_to_the_validated_address(monkeypatch):
    """The socket must open to the address that passed validation.

    Resolving in a pre-check and then letting httpcore resolve again leaves a
    window where a rebinding DNS server answers public first, private second.
    Pinning the connect to the validated literal closes it.
    """
    from httpcore._backends.anyio import AnyIOBackend

    async def resolve(host, port):
        return ["93.184.216.34", "93.184.216.35"]

    calls: list[tuple[str, int]] = []

    async def fake_connect(
        self, host, port, timeout=None, local_address=None, socket_options=None
    ):
        calls.append((host, port))
        return _StreamStub()

    monkeypatch.setattr(web_module, "_resolve_host", resolve)
    monkeypatch.setattr(AnyIOBackend, "connect_tcp", fake_connect)

    stream = await web_module._PublicOnlyBackend().connect_tcp("example.com", 443)

    assert isinstance(stream, _StreamStub)
    assert calls == [("93.184.216.34", 443)]


@pytest.mark.asyncio
async def test_pinned_backend_falls_back_to_the_next_validated_address(monkeypatch):
    import httpcore
    from httpcore._backends.anyio import AnyIOBackend

    async def resolve(host, port):
        return ["93.184.216.34", "93.184.216.35"]

    calls: list[str] = []

    async def fake_connect(
        self, host, port, timeout=None, local_address=None, socket_options=None
    ):
        calls.append(host)
        if host == "93.184.216.34":
            raise httpcore.ConnectError("refused")
        return _StreamStub()

    monkeypatch.setattr(web_module, "_resolve_host", resolve)
    monkeypatch.setattr(AnyIOBackend, "connect_tcp", fake_connect)

    await web_module._PublicOnlyBackend().connect_tcp("example.com", 443)

    assert calls == ["93.184.216.34", "93.184.216.35"]


@pytest.mark.asyncio
async def test_pinned_backend_refuses_private_address_at_connect_time(monkeypatch):
    from httpcore._backends.anyio import AnyIOBackend

    async def resolve(host, port):
        return ["93.184.216.34", "10.0.0.7"]

    async def fake_connect(
        self, host, port, timeout=None, local_address=None, socket_options=None
    ):
        raise AssertionError("must not connect when any address is private")

    monkeypatch.setattr(web_module, "_resolve_host", resolve)
    monkeypatch.setattr(AnyIOBackend, "connect_tcp", fake_connect)

    with pytest.raises(web_module.PrivateDestinationError):
        await web_module._PublicOnlyBackend().connect_tcp("rebind.test", 80)


@pytest.mark.asyncio
async def test_pinned_backend_honours_private_network_opt_in(monkeypatch):
    from httpcore._backends.anyio import AnyIOBackend

    calls: list[str] = []

    async def fake_connect(
        self, host, port, timeout=None, local_address=None, socket_options=None
    ):
        calls.append(host)
        return _StreamStub()

    async def resolve(host, port):
        raise AssertionError("opt-in must skip the public-address gate")

    monkeypatch.setattr(web_module, "_resolve_host", resolve)
    monkeypatch.setattr(AnyIOBackend, "connect_tcp", fake_connect)
    monkeypatch.setattr(web_module.settings, "WEB_FETCH_ALLOW_PRIVATE_NETWORK", True)

    await web_module._PublicOnlyBackend().connect_tcp("localhost", 3000)

    # Left to httpcore's normal resolution so IPv4/IPv6 fallback still applies.
    assert calls == ["localhost"]


@pytest.mark.asyncio
async def test_shared_client_uses_the_pinned_backend():
    await web_module.close_http_client()
    client = web_module._get_http_client()
    transport = client._transport
    assert isinstance(transport._pool._network_backend, web_module._PublicOnlyBackend)  # type: ignore[attr-defined]
    await web_module.close_http_client()


@pytest.mark.asyncio
async def test_web_fetch_reports_connect_time_private_block_as_unsafe_url(
    monkeypatch,
):
    # httpx maps httpcore errors with ``raise mapped from exc``; replicate that
    # chain from a MockTransport handler (respx rewrites __cause__).
    exc = httpx.ConnectError("blocked")
    exc.__cause__ = web_module.PrivateDestinationError(
        "rebind.test resolved to a non-public address (10.0.0.7)"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise exc

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(web_module, "_get_http_client", lambda: client)

    result = await web_fetch("https://rebind.test/")

    assert "unsafe url" in result.lower()
    assert "10.0.0.7" in result
    await client.aclose()


def test_web_fetch_args_rejects_unsupported_scheme():
    with pytest.raises(ValueError, match=r"http\(s\)"):
        web_module.WebFetchArgs.model_validate({"url": "ftp://example.com"})


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_rejects_redirect_to_private_destination(monkeypatch):
    async def resolve(host, port):
        return ["127.0.0.1"] if host == "private.test" else ["93.184.216.34"]

    monkeypatch.setattr(web_module, "_resolve_host", resolve)
    public = "https://public.test/start"
    respx.get(public).mock(
        return_value=httpx.Response(
            302, headers={"location": "http://private.test/secret"}
        )
    )

    result = await web_fetch(public)

    assert "unsafe url" in result.lower()
