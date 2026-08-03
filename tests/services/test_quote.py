"""Tests for quote-of-the-day service and endpoint."""

from __future__ import annotations

import datetime
import json
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx2
import pytest
from pydantic import SecretStr

from app.api.app import create_app
from app.services.quote_service import (
    Quote,
    _FALLBACK,
    _read_cache,
    _write_cache,
    get_quote_of_the_day,
)


def _utc_today() -> datetime.date:
    """Return today's date in UTC — matches the service implementation."""
    return datetime.datetime.now(datetime.timezone.utc).date()


# ── Service Tests ──────────────────────────────────────────────────────────


class TestQuoteCache:
    """Test cache read/write helpers."""

    def test_write_cache_creates_file(self, tmp_path):
        """Cache file is created with correct structure."""
        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = tmp_path / "quoteoftheday.json"
            q = Quote(quote="Test quote", author="Test Author")

            _write_cache(q)

            assert mock_path.return_value.exists()
            data = json.loads(mock_path.return_value.read_text())
            assert data["date"] == _utc_today().isoformat()
            assert data["quote"] == "Test quote"
            assert data["author"] == "Test Author"

    def test_write_cache_creates_parent_dirs(self, tmp_path):
        """Cache file creation creates missing parent directories."""
        cache_path = tmp_path / "nested" / "dir" / "quoteoftheday.json"
        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_path

            q = Quote(quote="Test quote", author="Test Author")
            _write_cache(q)

            assert cache_path.exists()

    def test_write_cache_handles_unicode(self, tmp_path):
        """Cache file correctly handles unicode characters."""
        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = tmp_path / "quoteoftheday.json"
            q = Quote(quote="Être ou ne pas être", author="François Müller")

            _write_cache(q)

            data = json.loads(mock_path.return_value.read_text(encoding="utf-8"))
            assert data["quote"] == "Être ou ne pas être"
            assert data["author"] == "François Müller"

    def test_write_cache_handles_write_error(self, tmp_path):
        """Cache write error is logged but doesn't raise."""
        with patch("app.services.quote_service._cache_path") as mock_path:
            # Mock a path that will fail to write (e.g., permission denied)
            mock_path.return_value = Path("/invalid/path/quoteoftheday.json")
            q = Quote(quote="Test quote", author="Test Author")

            # Should not raise
            _write_cache(q)

    def test_read_cache_returns_none_when_file_missing(self, tmp_path):
        """Cache read returns None when file doesn't exist."""
        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = tmp_path / "nonexistent.json"

            result = _read_cache()

            assert result is None

    def test_read_cache_returns_none_when_file_empty(self, tmp_path):
        """Cache read returns None when file exists but is empty."""
        cache_file = tmp_path / "quoteoftheday.json"
        cache_file.write_text("")  # Empty file

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file

            result = _read_cache()

            assert result is None

    def test_read_cache_returns_quote_when_date_matches(self, tmp_path):
        """Cache read returns quote when cached date matches today."""
        cache_file = tmp_path / "quoteoftheday.json"
        data = {
            "date": _utc_today().isoformat(),
            "quote": "Cached quote",
            "author": "Cached Author",
        }
        cache_file.write_text(json.dumps(data))

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file

            result = _read_cache()

            assert result is not None
            assert result.quote == "Cached quote"
            assert result.author == "Cached Author"

    def test_read_cache_returns_none_when_date_stale(self, tmp_path):
        """Cache read returns None when cached date is not today."""
        cache_file = tmp_path / "quoteoftheday.json"
        yesterday = (_utc_today() - datetime.timedelta(days=1)).isoformat()
        data = {
            "date": yesterday,
            "quote": "Old quote",
            "author": "Old Author",
        }
        cache_file.write_text(json.dumps(data))

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file

            result = _read_cache()

            assert result is None

    def test_read_cache_returns_none_when_file_corrupted(self, tmp_path):
        """Cache read returns None when file is corrupted JSON."""
        cache_file = tmp_path / "quoteoftheday.json"
        cache_file.write_text("{ invalid json }")

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file

            result = _read_cache()

            assert result is None

    def test_read_cache_returns_none_when_missing_fields(self, tmp_path):
        """Cache read returns None when required fields are missing."""
        cache_file = tmp_path / "quoteoftheday.json"
        data = {
            "date": _utc_today().isoformat(),
            # Missing 'quote' and 'author'
        }
        cache_file.write_text(json.dumps(data))

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file

            result = _read_cache()

            assert result is None


class TestGetQuoteOfTheDay:
    """Test the main get_quote_of_the_day function."""

    @pytest.mark.asyncio
    async def test_returns_cached_quote_on_hit(self, tmp_path):
        """Returns cached quote when cache is valid."""
        cache_file = tmp_path / "quoteoftheday.json"
        data = {
            "date": _utc_today().isoformat(),
            "quote": "Cached quote",
            "author": "Cached Author",
        }
        cache_file.write_text(json.dumps(data))

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file

            result = await get_quote_of_the_day()

            assert result.quote == "Cached quote"
            assert result.author == "Cached Author"

    @pytest.mark.asyncio
    async def test_returns_fallback_when_no_api_key(self, tmp_path):
        """Returns fallback quote when API key is not configured."""
        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = tmp_path / "quoteoftheday.json"
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = None

                result = await get_quote_of_the_day()

                assert result == _FALLBACK

    @pytest.mark.asyncio
    async def test_fetches_from_api_on_cache_miss(self, tmp_path):
        """Fetches from API when cache is missing."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                mock_response.json.return_value = [
                    {"quote": "API quote", "author": "API Author"}
                ]
                mock_response.raise_for_status = Mock()

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result.quote == "API quote"
                    assert result.author == "API Author"
                    # Verify API was called with correct headers
                    mock_client.get.assert_called_once()
                    call_kwargs = mock_client.get.call_args[1]
                    assert call_kwargs["headers"]["X-Api-Key"] == "test_key"

    @pytest.mark.asyncio
    async def test_caches_fetched_quote(self, tmp_path):
        """Caches the quote after fetching from API."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                mock_response.json.return_value = [
                    {"quote": "New quote", "author": "New Author"}
                ]
                mock_response.raise_for_status = Mock()

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    await get_quote_of_the_day()

                    # Verify cache file was written
                    assert cache_file.exists()
                    data = json.loads(cache_file.read_text())
                    assert data["quote"] == "New quote"
                    assert data["author"] == "New Author"
                    assert data["date"] == _utc_today().isoformat()

    @pytest.mark.asyncio
    async def test_handles_api_list_response(self, tmp_path):
        """Correctly handles API response as a list."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                # API returns a list with one item
                mock_response.json.return_value = [
                    {"quote": "First quote", "author": "First Author"}
                ]
                mock_response.raise_for_status = Mock()

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result.quote == "First quote"
                    assert result.author == "First Author"

    @pytest.mark.asyncio
    async def test_handles_api_dict_response(self, tmp_path):
        """Correctly handles API response as a dict (fallback format)."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                # API returns a dict directly (not a list)
                mock_response.json.return_value = {
                    "quote": "Direct quote",
                    "author": "Direct Author",
                }
                mock_response.raise_for_status = Mock()

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result.quote == "Direct quote"
                    assert result.author == "Direct Author"

    @pytest.mark.asyncio
    async def test_handles_empty_api_list(self, tmp_path):
        """Returns fallback when API returns empty list."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                mock_response.json.return_value = []  # Empty list
                mock_response.raise_for_status = Mock()

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result == _FALLBACK

    @pytest.mark.asyncio
    async def test_handles_missing_quote_text(self, tmp_path):
        """Returns fallback when API response has no quote text."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                mock_response.json.return_value = [
                    {"quote": "", "author": "Some Author"}  # Empty quote
                ]
                mock_response.raise_for_status = Mock()

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result == _FALLBACK

    @pytest.mark.asyncio
    async def test_handles_missing_author(self, tmp_path):
        """Uses 'Unknown' when author is missing."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                mock_response.json.return_value = [
                    {"quote": "Some quote"}  # Missing author
                ]
                mock_response.raise_for_status = Mock()

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result.quote == "Some quote"
                    assert result.author == "Unknown"

    @pytest.mark.asyncio
    async def test_handles_http_error(self, tmp_path):
        """Returns fallback when API request fails with HTTP error."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                mock_response.raise_for_status.side_effect = httpx2.HTTPStatusError(
                    "500 Server Error",
                    request=Mock(),
                    response=Mock(),
                )

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result == _FALLBACK

    @pytest.mark.asyncio
    async def test_handles_network_error(self, tmp_path):
        """Returns fallback when network request fails."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(
                        side_effect=httpx2.ConnectError("Connection failed")
                    )
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result == _FALLBACK

    @pytest.mark.asyncio
    async def test_handles_json_decode_error(self, tmp_path):
        """Returns fallback when API response is not valid JSON."""
        cache_file = tmp_path / "quoteoftheday.json"

        with patch("app.services.quote_service._cache_path") as mock_path:
            mock_path.return_value = cache_file
            with patch("app.services.quote_service.settings") as mock_settings:
                mock_settings.NINJA_API_KEY = SecretStr("test_key")

                # Mock httpx2 response - use Mock for json() since it's synchronous
                mock_response = Mock()
                mock_response.raise_for_status = Mock()
                mock_response.json.side_effect = json.JSONDecodeError(
                    "Invalid JSON", "", 0
                )

                with patch("httpx2.AsyncClient") as mock_client_class:
                    mock_client = AsyncMock()
                    mock_client.__aenter__.return_value = mock_client
                    mock_client.__aexit__.return_value = None
                    mock_client.get = AsyncMock(return_value=mock_response)
                    mock_client_class.return_value = mock_client

                    result = await get_quote_of_the_day()

                    assert result == _FALLBACK


# ── Endpoint Tests ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_quote_endpoint_returns_200(setup_db):
    """GET /quote returns 200 with quote and author."""
    from httpx2 import ASGITransport, AsyncClient

    with patch("app.api.routes.quote.get_quote_of_the_day") as mock_get:
        mock_get.return_value = Quote(quote="Test quote", author="Test Author")

        app = create_app()

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.get("/api/quote")

            assert response.status_code == 200
            data = response.json()
            assert data["quote"] == "Test quote"
            assert data["author"] == "Test Author"


@pytest.mark.asyncio
async def test_quote_endpoint_returns_fallback_on_error(setup_db):
    """GET /quote returns fallback quote when service fails."""
    from httpx2 import ASGITransport, AsyncClient

    with patch("app.api.routes.quote.get_quote_of_the_day") as mock_get:
        mock_get.return_value = _FALLBACK

        app = create_app()

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.get("/api/quote")

            assert response.status_code == 200
            data = response.json()
            assert data["quote"] == _FALLBACK.quote
            assert data["author"] == _FALLBACK.author


@pytest.mark.asyncio
async def test_quote_endpoint_response_shape(setup_db):
    """GET /quote response has correct shape."""
    from httpx2 import ASGITransport, AsyncClient

    with patch("app.api.routes.quote.get_quote_of_the_day") as mock_get:
        mock_get.return_value = Quote(quote="Test quote", author="Test Author")

        app = create_app()

        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            response = await client.get("/api/quote")

            data = response.json()
            assert isinstance(data, dict)
            assert "quote" in data
            assert "author" in data
            assert len(data) == 2  # Only these two fields
