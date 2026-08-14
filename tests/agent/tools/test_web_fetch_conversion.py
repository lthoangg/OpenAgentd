"""`web_fetch` content conversion: HTML via trafilatura, binaries via anydoc.

markitdown returned the whole page including inline `<script>` bodies — on one
real docs page that was 1,106,641 characters, enough to swallow a context
window on a single fetch. Extraction keeps the article and drops the chrome.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from app.agent.tools.builtin.web import web_fetch

_PAGE = """<!doctype html>
<html><head><title>T</title>
<style>.nav{margin:0;padding:2px;--tw-ring:0}</style>
<script>!function(){window.__x=1;var a=2}()</script>
</head><body>
<nav><ul><li><a href="/a">Nav A</a></li><li><a href="/b">Nav B</a></li></ul></nav>
<article>
<h1>Installing the thing</h1>
<p>This guide explains how to install the thing on your machine in a few steps,
covering prerequisites, the install command itself, and how to verify it.</p>
<pre><code>pip install thing
thing --version</code></pre>
<p>After running the command above the binary is on your PATH and you can
verify the installation by printing its version number as shown.</p>
</article>
<footer>Copyright 2026</footer>
</body></html>"""


@pytest.mark.asyncio
@respx.mock
async def test_html_is_extracted_without_boilerplate_or_scripts():
    url = "https://example.com/guide"
    respx.get(url).mock(
        return_value=httpx.Response(
            200, text=_PAGE, headers={"content-type": "text/html; charset=utf-8"}
        )
    )

    result = await web_fetch(url)

    assert "Installing the thing" in result
    assert "pip install thing" in result
    # Inline script and style bodies must never reach the model.
    assert "window.__x" not in result
    assert "--tw-ring" not in result
    # Navigation chrome is boilerplate.
    assert "Nav A" not in result


@pytest.mark.asyncio
@respx.mock
async def test_html_falls_back_when_extraction_drops_code_blocks():
    """Tabbed code widgets (Starlight/Docusaurus) are pruned as navigation.

    A page whose source clearly has code but whose extraction has none is
    incomplete, so the greedy whole-document text is used instead.
    """
    tabbed = (
        "<html><body><article><h1>Install</h1>"
        "<p>Pick your package manager below to install the tool locally.</p>"
        '<starlight-tabs><div class="tablist-wrapper"><ul role="tablist">'
        '<li role="presentation"><a role="tab">npm</a></li></ul>'
        "<section><pre><code>npm install demo-pkg</code></pre></section>"
        "</div></starlight-tabs></article></body></html>"
    )
    url = "https://example.com/install"
    respx.get(url).mock(
        return_value=httpx.Response(
            200, text=tabbed, headers={"content-type": "text/html"}
        )
    )

    result = await web_fetch(url)

    assert "npm install demo-pkg" in result


@pytest.mark.asyncio
@respx.mock
async def test_json_is_returned_verbatim_not_run_through_an_extractor():
    url = "https://example.com/api.json"
    body = '{"status":"ok","items":[1,2,3]}'
    respx.get(url).mock(
        return_value=httpx.Response(
            200, text=body, headers={"content-type": "application/json"}
        )
    )

    assert await web_fetch(url) == body


@pytest.mark.asyncio
@respx.mock
async def test_pdf_response_is_converted_to_text():
    from tests.agent.tools.test_document_conversion import _minimal_pdf

    url = "https://example.com/paper.pdf"
    respx.get(url).mock(
        return_value=httpx.Response(
            200, content=_minimal_pdf(), headers={"content-type": "application/pdf"}
        )
    )

    assert "Hello Anydoc World" in await web_fetch(url)
