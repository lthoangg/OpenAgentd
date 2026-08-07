"""Tests for automatic chat session title generation."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid7

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.schemas.chat import HumanMessage, SystemMessage
from app.models.chat import ChatSession
from app.services.title_service import (
    _attach_usage,
    _clean_title,
    generate_and_save_title,
)


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture
async def engine():
    """Create an in-memory SQLite engine for testing."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def session(engine):
    """Create a test database session."""
    async_session = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with async_session() as session:
        yield session


@pytest.fixture
def mock_provider():
    """Create a mock LLM provider."""
    provider = MagicMock()
    provider.chat = AsyncMock()
    return provider


# ── Unit Tests: _clean_title ──────────────────────────────────────────────────


class TestCleanTitle:
    """Unit tests for the _clean_title helper function."""

    def test_clean_title_strips_whitespace(self):
        """Strips leading and trailing whitespace."""
        assert _clean_title("  hello world  ") == "hello world"

    def test_clean_title_strips_double_quotes(self):
        """Strips surrounding double quotes."""
        assert _clean_title('"hello world"') == "hello world"

    def test_clean_title_strips_single_quotes(self):
        """Strips surrounding single quotes."""
        assert _clean_title("'hello world'") == "hello world"

    def test_clean_title_strips_trailing_period(self):
        """Strips trailing period."""
        assert _clean_title("hello world.") == "hello world"

    def test_clean_title_strips_quotes_and_period(self):
        """Strips quotes and trailing period together."""
        assert _clean_title('"hello world."') == "hello world"
        assert _clean_title("'hello world.'") == "hello world"

    def test_clean_title_strips_all_combined(self):
        """Strips whitespace, quotes, and period all together."""
        assert _clean_title('  "hello world."  ') == "hello world"
        assert _clean_title("  'hello world.'  ") == "hello world"

    def test_clean_title_truncates_at_255_chars(self):
        """Truncates to 255 characters."""
        long_title = "a" * 300
        result = _clean_title(long_title)
        assert len(result) == 255
        assert result == "a" * 255

    def test_clean_title_empty_string(self):
        """Empty string returns empty string."""
        assert _clean_title("") == ""

    def test_clean_title_only_whitespace(self):
        """String with only whitespace returns empty string."""
        assert _clean_title("   ") == ""

    def test_clean_title_only_quotes(self):
        """String with only quotes returns empty string."""
        assert _clean_title('""') == ""
        assert _clean_title("''") == ""

    def test_clean_title_only_period(self):
        """String with only period returns empty string."""
        assert _clean_title(".") == ""

    def test_clean_title_preserves_internal_punctuation(self):
        """Preserves punctuation inside the title."""
        assert _clean_title("Hello, world!") == "Hello, world!"
        assert _clean_title('"Hello, world!"') == "Hello, world!"

    def test_clean_title_multiple_trailing_periods(self):
        """Strips only the trailing period, not internal ones."""
        assert _clean_title("Hello. World.") == "Hello. World"

    def test_clean_title_nested_quotes(self):
        """Strips outer quotes, then inner quotes."""
        # First strips outer double quotes: "'hello'"
        # Then strips inner single quotes: "hello"
        assert _clean_title("\"'hello'\"") == "hello"


def test_attach_usage_adds_title_generation_token_attributes():
    span = MagicMock()
    result = MagicMock(
        extra={
            "usage": {
                "input": 100,
                "output": 10,
                "cache": 40,
                "cost": {"estimated_usd": 0.00012},
            }
        }
    )

    _attach_usage(span, result, "gpt-test", "openai")

    span.set_attribute.assert_any_call("gen_ai.operation.name", "title_generation")
    span.set_attribute.assert_any_call("gen_ai.provider.name", "openai")
    span.set_attribute.assert_any_call("gen_ai.request.model", "gpt-test")
    span.set_attribute.assert_any_call("gen_ai.usage.input_tokens", 100)
    span.set_attribute.assert_any_call("gen_ai.usage.output_tokens", 10)
    span.set_attribute.assert_any_call("gen_ai.usage.cache_read.input_tokens", 40)
    span.set_attribute.assert_any_call("gen_ai.usage.estimated_cost_usd", 0.00012)


# ── Integration Tests: generate_and_save_title ────────────────────────────────


class TestGenerateAndSaveTitle:
    """Integration tests for generate_and_save_title function."""

    @pytest.mark.asyncio
    async def test_happy_path_generates_and_saves_title(
        self, engine, session, mock_provider
    ):
        """Provider returns clean title → saved to DB and event pushed."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content="Japan Trip Planning")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            mock_push.return_value = None

            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="I'm planning a trip to Japan next month",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == "Japan Trip Planning"
            mock_push.assert_called_once()
            call_args = mock_push.call_args
            assert call_args[0][0] == "title_update"
            assert call_args[0][1]["session_id"] == str(chat_session.id)
            assert call_args[0][1]["title"] == "Japan Trip Planning"
            assert "updated_at" in call_args[0][1]

    @pytest.mark.asyncio
    async def test_message_truncated_to_500_chars(self, engine, session, mock_provider):
        """User message longer than 500 chars → provider receives only first 500."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        long_message = "a" * 600
        mock_provider.chat.return_value = MagicMock(content="Title")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish"):
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message=long_message,
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            call_args = mock_provider.chat.call_args
            messages = call_args[0][0]
            # The second message (index 1) is the user message
            user_msg = messages[1]
            assert len(user_msg.content) == 500
            assert user_msg.content == "a" * 500

    @pytest.mark.asyncio
    async def test_llm_returns_dirty_title_cleaned(
        self, engine, session, mock_provider
    ):
        """Provider returns dirty title → cleaned before saving."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content='"Japan trip planning."')

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish"):
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="I'm planning a trip to Japan",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == "Japan trip planning"

    @pytest.mark.asyncio
    async def test_provider_raises_exception_returns_silently(
        self, engine, session, mock_provider
    ):
        """Provider.chat raises → function returns silently, DB not written."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.side_effect = Exception("API error")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act & Assert (no exception raised)
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == ""  # unchanged
            mock_push.assert_not_called()

    @pytest.mark.asyncio
    async def test_provider_timeout_returns_silently(
        self, engine, session, mock_provider
    ):
        """Provider.chat hangs → asyncio.timeout fires → returns silently."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        # Raise TimeoutError immediately instead of waiting 15s for the real timeout
        mock_provider.chat.side_effect = asyncio.TimeoutError()

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act & Assert (no exception raised)
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == ""  # unchanged
            mock_push.assert_not_called()

    @pytest.mark.asyncio
    async def test_provider_returns_empty_string_returns_silently(
        self, engine, session, mock_provider
    ):
        """Provider returns empty string → function returns silently, DB not written."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content="")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == ""  # unchanged
            mock_push.assert_not_called()

    @pytest.mark.asyncio
    async def test_provider_returns_none_content_returns_silently(
        self, engine, session, mock_provider
    ):
        """Provider returns None content → function returns silently."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content=None)

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == ""  # unchanged
            mock_push.assert_not_called()

    @pytest.mark.asyncio
    async def test_session_not_found_in_db_returns_silently(
        self, engine, session, mock_provider
    ):
        """Session not found in DB → push_event not called."""
        # Arrange
        nonexistent_session_id = uuid7()
        mock_provider.chat.return_value = MagicMock(content="Some Title")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act
            await generate_and_save_title(
                session_id=nonexistent_session_id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            mock_push.assert_not_called()

    @pytest.mark.asyncio
    async def test_uses_real_db_fixture(self, engine, session, mock_provider):
        """Create real ChatSession, run function, assert DB updated."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content="Real DB Test Title")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish"):
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="Testing with real DB",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == "Real DB Test Title"

    @pytest.mark.asyncio
    async def test_provider_chat_called_with_correct_params(
        self, engine, session, mock_provider
    ):
        """Provider.chat called with correct message structure and params."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content="Title")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish"):
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            call_args = mock_provider.chat.call_args
            messages = call_args[0][0]
            kwargs = call_args[1]

            # Check message structure
            assert len(messages) == 2
            assert isinstance(messages[0], SystemMessage)
            assert isinstance(messages[1], HumanMessage)
            assert messages[1].content == "test message"

            assert kwargs["tools"] == []
            assert kwargs["max_tokens"] == 20
            assert kwargs["thinking_level"] == "none"
            assert kwargs["tool_choice"] == "none"
            assert "temperature" not in kwargs

    @pytest.mark.asyncio
    async def test_retries_without_thinking_override_on_failure(
        self, engine, session, mock_provider
    ):
        """First attempt fails (e.g. Codex rejects missing ``reasoning``) →
        retry once without the ``thinking_level="none"`` override."""
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.side_effect = [
            Exception("Codex 400: missing 'reasoning'"),
            MagicMock(content="Recovered Title"),
        ]

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish"):
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="hi",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

        assert mock_provider.chat.await_count == 2
        first_kwargs = mock_provider.chat.call_args_list[0].kwargs
        second_kwargs = mock_provider.chat.call_args_list[1].kwargs
        assert first_kwargs.get("tools") == []
        assert first_kwargs.get("thinking_level") == "none"
        assert first_kwargs.get("tool_choice") == "none"
        assert second_kwargs.get("tools") == []
        assert "thinking_level" not in second_kwargs
        assert second_kwargs.get("tool_choice") == "none"

        await session.refresh(chat_session)
        assert chat_session.title == "Recovered Title"

    @pytest.mark.asyncio
    async def test_terminal_error_does_not_retry(self, engine, session, mock_provider):
        """Terminal provider error (e.g. Rate limit 429) → log error and return without retrying."""
        import httpx
        from app.agent.errors import ProviderRateLimitError

        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        for error in [
            ProviderRateLimitError("Rate limit reached"),
            httpx.HTTPStatusError(
                "429 Too Many Requests",
                request=MagicMock(),
                response=MagicMock(status_code=429),
            ),
            httpx.HTTPStatusError(
                "500 Internal Server Error",
                request=MagicMock(),
                response=MagicMock(status_code=500),
            ),
        ]:
            mock_provider.chat.reset_mock()
            mock_provider.chat.side_effect = error

            with patch("app.services.title_service.event_broadcaster.publish"):
                await generate_and_save_title(
                    session_id=chat_session.id,
                    user_message="test message",
                    provider=mock_provider,
                    db_factory=db_factory,
                    system_prompt="test title prompt",
                )

            assert mock_provider.chat.await_count == 1
            await session.refresh(chat_session)
            assert chat_session.title == ""  # unchanged

    @pytest.mark.asyncio
    async def test_event_payload_structure(self, engine, session, mock_provider):
        """Verify the event payload has correct structure."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content="Test Title")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            call_args = mock_push.call_args
            event = call_args[0][0]
            payload = call_args[0][1]

            assert event == "title_update"
            assert payload["session_id"] == str(chat_session.id)
            assert payload["title"] == "Test Title"
            assert isinstance(payload["updated_at"], str)

    @pytest.mark.asyncio
    async def test_title_truncated_to_255_chars_before_save(
        self, engine, session, mock_provider
    ):
        """Title longer than 255 chars → truncated before saving."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        long_title = "a" * 300
        mock_provider.chat.return_value = MagicMock(content=long_title)

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish"):
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title is not None
            assert len(chat_session.title) == 255
            assert chat_session.title == "a" * 255

    @pytest.mark.asyncio
    async def test_whitespace_only_title_returns_silently(
        self, engine, session, mock_provider
    ):
        """Provider returns whitespace-only title → returns silently."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content="   ")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == ""  # unchanged
            mock_push.assert_not_called()

    @pytest.mark.asyncio
    async def test_only_quotes_title_returns_silently(
        self, engine, session, mock_provider
    ):
        """Provider returns only quotes → cleaned to empty → returns silently."""
        # Arrange
        chat_session = ChatSession(title="")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content='""')

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish") as mock_push:
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == ""  # unchanged
            mock_push.assert_not_called()

    @pytest.mark.asyncio
    async def test_overwrites_existing_title(self, engine, session, mock_provider):
        """Existing title → overwritten with new title."""
        # Arrange
        chat_session = ChatSession(title="Old Title")
        session.add(chat_session)
        await session.commit()

        mock_provider.chat.return_value = MagicMock(content="New Title")

        db_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        with patch("app.services.title_service.event_broadcaster.publish"):
            # Act
            await generate_and_save_title(
                session_id=chat_session.id,
                user_message="test message",
                provider=mock_provider,
                db_factory=db_factory,
                system_prompt="test title prompt",
            )

            # Assert
            await session.refresh(chat_session)
            assert chat_session.title == "New Title"

    @pytest.mark.asyncio
    async def test_empty_system_prompt_raises(self, mock_provider):
        """generate_and_save_title requires a non-empty system_prompt."""
        from uuid import uuid4

        import pytest

        with pytest.raises(ValueError, match="requires a non-empty system_prompt"):
            await generate_and_save_title(
                session_id=uuid4(),
                user_message="hi",
                provider=mock_provider,
                db_factory=MagicMock(),
                system_prompt="",
            )
