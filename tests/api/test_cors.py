"""CORS behaviour for cross-origin range-request clients.

Covers the scenario where the web UI is loaded from one origin (e.g. the
Tauri mobile app's local webview) and talks to the API on a different
origin (e.g. a remote LAN server at ``http://192.168.x.x:port``). Browsers
only expose CORS-safelisted response headers to JS for such cross-origin
requests unless the server opts in via ``Access-Control-Expose-Headers`` —
``Accept-Ranges``/``Content-Range`` are not on that safelist, so without
explicit exposure, range-aware clients (pdf.js's progressive-loading probe,
native ``<video>`` byte-range seeking) can't detect partial-content support
and silently fall back to downloading the whole file.
"""

from fastapi.testclient import TestClient

from app.api.app import create_app


def _client() -> TestClient:
    return TestClient(create_app())


def test_cors_exposes_range_headers_for_cross_origin_requests(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "doc.pdf").write_bytes(b"%PDF-1.4 " + b"x" * 2000)

    resp = _client().get(
        "/api/team/workspace/files/read",
        params={"workspace": str(workspace), "path": "doc.pdf"},
        headers={"Origin": "http://192.168.1.50:3000", "Range": "bytes=0-99"},
    )

    assert resp.status_code == 206
    assert resp.headers.get("accept-ranges") == "bytes"
    assert "content-range" in resp.headers

    exposed = resp.headers.get("access-control-expose-headers", "")
    assert "Accept-Ranges" in exposed
    assert "Content-Range" in exposed
    assert "Content-Length" in exposed


def test_cors_reflects_arbitrary_origin_with_credentials(tmp_path):
    """Any LAN/remote origin must be allowed — the API has no fixed origin
    allowlist since it's reached from varying local-network addresses."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "doc.pdf").write_bytes(b"%PDF-1.4 " + b"x" * 10)

    resp = _client().get(
        "/api/team/workspace/files/read",
        params={"workspace": str(workspace), "path": "doc.pdf"},
        headers={"Origin": "http://10.0.0.42:5173"},
    )

    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == "http://10.0.0.42:5173"
    assert resp.headers.get("access-control-allow-credentials") == "true"
