from fastapi.testclient import TestClient
from fastapi.middleware.gzip import GZipMiddleware
from app.api.app import create_app


def test_gzip_middleware_enabled():
    app = create_app()
    middleware_classes = [m.cls for m in app.user_middleware]
    assert GZipMiddleware in middleware_classes


def test_gzip_compression_large_response():
    app = create_app()

    @app.get("/test-large-response")
    def large_route():
        return {"data": "x" * 2000}

    client = TestClient(app)

    # Without gzip header (forcing identity), should not be compressed
    resp_no_gzip = client.get(
        "/test-large-response", headers={"Accept-Encoding": "identity"}
    )
    assert "gzip" not in resp_no_gzip.headers.get("content-encoding", "")

    # With gzip header, should be compressed since it's > 1000 bytes
    resp_gzip = client.get("/test-large-response", headers={"Accept-Encoding": "gzip"})
    assert resp_gzip.headers.get("content-encoding") == "gzip"
