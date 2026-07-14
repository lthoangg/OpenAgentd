"""Tests for FastAPI application assembly."""

from fastapi.testclient import TestClient

from app.api.app import create_app


def test_api_documentation_endpoints_are_disabled() -> None:
    app = create_app()
    client = TestClient(app)

    assert app.docs_url is None
    assert app.redoc_url is None
    assert app.openapi_url is None
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_metrics_are_served_under_the_api_namespace() -> None:
    client = TestClient(create_app())

    assert client.get("/metrics").status_code == 404
    assert client.get("/api/metrics").status_code == 200
