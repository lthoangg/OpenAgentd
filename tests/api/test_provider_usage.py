"""Tests for GET /api/settings/providers/{id}/usage."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes.settings import router as settings_router
from app.api.schemas.settings import (
    ProviderUsageCredits,
    ProviderUsageLimit,
    ProviderUsageResponse,
)
from app.services import provider_usage


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(settings_router, prefix="/api/settings")
    return app


def test_get_provider_usage_returns_200_with_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = TestClient(_make_app())

    async def _fake_get_provider_usage(
        provider_id: str, api_key: str | None = None
    ) -> ProviderUsageResponse:
        assert provider_id == "openrouter"
        assert api_key == "test-key-123"
        return ProviderUsageResponse(
            provider="openrouter",
            limits=[
                ProviderUsageLimit(
                    limit_id="openrouter",
                    limit_name="OpenRouter Credits",
                    credits=ProviderUsageCredits(
                        has_credits=True,
                        unlimited=False,
                        balance="$25.00",
                    ),
                )
            ],
        )

    monkeypatch.setattr(
        "app.api.routes.settings.load_provider_usage", _fake_get_provider_usage
    )

    response = client.get(
        "/api/settings/providers/openrouter/usage",
        params={"api_key": "test-key-123"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["provider"] == "openrouter"
    assert data["limits"][0]["credits"]["balance"] == "$25.00"


def test_get_provider_usage_unsupported_returns_404(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = TestClient(_make_app())

    async def _fake_raise(*_args, **_kwargs):
        raise provider_usage.ProviderUsageUnsupportedError("unsupported-provider")

    monkeypatch.setattr("app.api.routes.settings.load_provider_usage", _fake_raise)

    response = client.get("/api/settings/providers/unsupported-provider/usage")
    assert response.status_code == 404
    assert "unsupported" in response.json()["detail"].lower()
