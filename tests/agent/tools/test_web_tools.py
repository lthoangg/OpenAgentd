from unittest.mock import patch

import httpx
import pytest
import respx

from app.agent.tools.builtin.web import web_fetch, web_search


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
async def test_web_fetch_format_html_still_converts():
    """`format` only selects the Accept header; the body is still converted."""
    url = "https://example.com"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            text="<html><body>Raw</body></html>",
            headers={"content-type": "text/html"},
        )
    )

    assert await web_fetch(url, format="html") == "Raw"


@pytest.mark.asyncio
@respx.mock
async def test_web_fetch_http_error_returns_error_string():
    """Non-2xx response returns an error string."""
    url = "https://nonexistent-url.com"
    respx.get(url).mock(return_value=httpx.Response(404))

    result = await web_fetch(url)
    assert "Error fetching or converting" in result


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
    """403 with cf-mitigated=challenge retries with 'opencode' User-Agent."""
    url = "https://example.com"
    call_count = 0

    def side_effect(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(403, headers={"cf-mitigated": "challenge"})
        return httpx.Response(
            200,
            text="<p>OK</p>",
            headers={"content-type": "text/html"},
        )

    respx.get(url).mock(side_effect=side_effect)

    result = await web_fetch(url)

    assert result == "OK"
    assert call_count == 2


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
    assert "Error fetching or converting" not in result
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

    assert "Error fetching or converting" not in result
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
    """Non-text conversion failures keep returning the error string."""
    url = "https://example.com/broken.pdf"
    respx.get(url).mock(
        return_value=httpx.Response(
            200,
            content=b"%PDF-1.4 broken",
            headers={"content-type": "application/pdf"},
        )
    )

    result = await web_fetch(url)

    assert "Error fetching or converting" in result
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

    assert "Error fetching or converting" not in result
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
