import uuid
from datetime import datetime, timezone
from uuid import UUID, uuid7

import sqlalchemy as sa
from sqlalchemy import Column, DateTime, ForeignKey, JSON
import sqlalchemy.dialects.postgresql as pg
from sqlalchemy.types import TypeDecorator
from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    """Return the current UTC time with microsecond precision.

    Using a Python-side default (rather than ``server_default=func.now()``)
    ensures the value is set *before* the INSERT statement is issued.  This
    guarantees microsecond-level precision in all environments including
    in-memory SQLite (which only has second-level resolution for SQL ``NOW()``),
    making timestamp-based ordering reliable in fast-running tests.
    """
    return datetime.now(timezone.utc)


class TZDateTime(TypeDecorator):
    """DateTime type that always returns timezone-aware UTC datetimes.

    SQLite stores datetimes as naive strings. This decorator re-attaches
    UTC tzinfo on read so that Pydantic serializes them with a 'Z' suffix
    and downstream consumers (web UI, API clients) get correct timezone info.

    On *write* we reject naive datetimes outright. Accepting a naive value
    silently treats whatever wall-clock the caller produced as UTC, which
    has bitten us in the scheduler (see git history: a tool parsed
    ``2026-05-10T01:12:42`` from the user's local zone and we stored it
    verbatim, mis-labelled UTC on read, off by 7 hours from intent).
    Aware values are normalised to UTC for consistent storage.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(
        self, value: datetime | None, dialect: sa.Dialect
    ) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError(
                "TZDateTime received a naive datetime; callers must attach "
                "tzinfo (use the user's IANA zone or `timezone.utc`). "
                f"Got: {value!r}"
            )
        # Normalise to UTC so on-disk values are unambiguous regardless of
        # the source zone.
        return value.astimezone(timezone.utc)

    def process_result_value(
        self, value: datetime | None, dialect: sa.Dialect
    ) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


class ChatSession(SQLModel, table=True):
    __tablename__: str = "chat_sessions"  # type: ignore[reportIncompatibleVariableOverride]

    id: UUID = Field(default_factory=uuid7, primary_key=True)
    parent_session_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            sa.Uuid(),
            ForeignKey("chat_sessions.id", ondelete="CASCADE"),
            index=True,
            nullable=True,
        ),
    )
    # Top-level sessions (team leads, scheduled tasks) have parent_session_id=NULL.
    # Team-member sessions are children of their lead via parent_session_id.
    agent_name: str | None = Field(default=None, max_length=100)
    title: str | None = Field(default=None, max_length=255)
    # Set when this session was created by the scheduler; None for normal chat.
    scheduled_task_name: str | None = Field(
        default=None,
        max_length=100,
        sa_column=Column(sa.String(100), nullable=True),
    )
    created_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(
            TZDateTime(),
            nullable=False,
            onupdate=_utcnow,
        ),
    )


class SessionMessage(SQLModel, table=True):
    __tablename__: str = "session_messages"  # type: ignore[reportIncompatibleVariableOverride]
    __table_args__ = (
        # Me cover ORDER BY created_at queries (get_messages, get_messages_for_llm)
        sa.Index("ix_session_messages_session_created", "session_id", "created_at"),
        # Me cover is_summary lookup (get_messages_for_llm summary query)
        sa.Index("ix_session_messages_session_summary", "session_id", "is_summary"),
    )

    id: UUID = Field(default_factory=uuid7, primary_key=True)
    session_id: UUID = Field(
        sa_column=Column(
            sa.Uuid(),
            ForeignKey("chat_sessions.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
    )
    role: str = Field(max_length=50)
    content: str | None = Field(default=None)
    reasoning_content: str | None = Field(default=None)

    # Stores tool_calls as a list of dicts
    tool_calls: list[dict] | None = Field(
        default=None,
        sa_column=Column(JSON),
    )

    # For tool messages
    tool_call_id: str | None = Field(default=None, max_length=100)
    name: str | None = Field(default=None, max_length=100)

    # Flexible extra data (usage stats, etc.)
    # JSONB on Postgres, JSON on SQLite
    extra: dict | None = Field(
        default=None,
        sa_column=Column(
            JSON().with_variant(pg.JSONB(), "postgresql"),
        ),
    )

    # Summarization support
    # is_summary=True           → this message IS the conversation summary (assistant role)
    # exclude_from_context=True → this message exists in audit log but is not sent to LLM
    is_summary: bool = Field(
        default=False,
        sa_column=Column(sa.Boolean, nullable=False, server_default=sa.false()),
    )
    exclude_from_context: bool = Field(
        default=False,
        sa_column=Column(sa.Boolean, nullable=False, server_default=sa.false()),
    )

    created_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False),
    )


class DreamLog(SQLModel, table=True):
    """Records sessions that have been processed by the dream agent."""

    __tablename__ = "dream_log"  # type: ignore[reportIncompatibleVariableOverride]

    id: int | None = Field(default=None, primary_key=True)
    session_id: uuid.UUID = Field(index=True, unique=True)
    processed_at: datetime = Field(sa_column=Column(TZDateTime, nullable=False))
    agent_name: str | None = Field(default=None)
    topics_written: str | None = Field(default=None)  # JSON array of slugs


class DreamNotesLog(SQLModel, table=True):
    """Records note files that have been processed by the dream agent."""

    __tablename__ = "dream_notes_log"  # type: ignore[reportIncompatibleVariableOverride]

    id: int | None = Field(default=None, primary_key=True)
    filename: str = Field(index=True, unique=True)  # e.g. "2026-04-29-abc123.md"
    processed_at: datetime = Field(sa_column=Column(TZDateTime, nullable=False))
