from datetime import datetime, timezone
from uuid import UUID, uuid7

import sqlalchemy as sa
from sqlalchemy import Column, DateTime, ForeignKey, JSON
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


# ── session_messages constants ────────────────────────────────────────────────

# Sparse allocation step for ``SessionMessage.seq``.  Appends take
# ``MAX(seq) + SEQ_STEP``; anchored inserts (summary dividers, healed tool
# stubs) take the midpoint of the two neighbouring rows.  1024 allows ten
# midpoint splits at the same point before falling back to id tie-breaking.
SEQ_STEP = 1024


class MessageKind:
    """Values for ``SessionMessage.kind`` — see the column docstring."""

    CHAT = "chat"
    NOTE = "note"
    QUEUED = "queued"
    SUMMARY = "summary"
    REVERTED = "reverted"

    ALL = (CHAT, NOTE, QUEUED, SUMMARY, REVERTED)


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
    __table_args__ = (
        # Recent-session sidebars filter top-level rows by mode and order by
        # created_at. Keep both the global and per-workspace hot paths out of
        # SQLite's temporary sort B-tree as personal histories grow.
        sa.Index(
            "ix_chat_sessions_top_mode_created",
            "parent_session_id",
            "mode",
            "created_at",
            "id",
        ),
        sa.Index(
            "ix_chat_sessions_top_mode_workspace_created",
            "parent_session_id",
            "mode",
            "workspace",
            "created_at",
            "id",
        ),
        # Sub-session lookups (`get_team_history`, `get_team_history_since`)
        # filter on parent_session_id and order by created_at on every team
        # history load. Ordering the index the same way keeps them out of a
        # temp B-tree, and the leading column still serves plain
        # parent_session_id lookups — including the ON DELETE CASCADE child
        # scan — so no separate single-column index is needed.
        sa.Index(
            "ix_chat_sessions_parent_created",
            "parent_session_id",
            "created_at",
            "id",
        ),
        # Plain column index, deliberately not `sa.desc("created_at")`: a DESC
        # expression index is invisible to Alembic's SQLite comparison and made
        # `alembic check` report a phantom diff forever. SQLite walks an ASC
        # index backwards for `ORDER BY created_at DESC`, so the ordering of
        # the member-restore lookups is unaffected.
        sa.Index(
            "ix_chat_sessions_parent_agent_created",
            "parent_session_id",
            "agent_name",
            "created_at",
        ),
    )

    id: UUID = Field(default_factory=uuid7, primary_key=True)
    parent_session_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            sa.Uuid(),
            ForeignKey("chat_sessions.id", ondelete="CASCADE"),
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
    mode: str = Field(
        default="normal",
        max_length=20,
        sa_column=Column(sa.String(20), nullable=False, server_default="normal"),
    )
    workspace: str | None = Field(default=None)
    model: str | None = Field(default=None, max_length=255)
    thinking_level: str | None = Field(default=None, max_length=50)
    revert: dict | None = Field(
        default=None,
        sa_column=Column(JSON(), nullable=True),
    )
    # Monotonic counter for mutations that can change the effective LLM
    # history.  It lets a live agent distinguish append-only turns from undo,
    # compaction, and queue state changes without rebuilding blindly.
    history_revision: int = Field(
        default=0,
        sa_column=Column(sa.Integer(), nullable=False, server_default="0"),
    )
    history_structure_revision: int = Field(
        default=0,
        sa_column=Column(sa.Integer(), nullable=False, server_default="0"),
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


class CodingWorkspace(SQLModel, table=True):
    __tablename__: str = "coding_workspaces"  # type: ignore[reportIncompatibleVariableOverride]
    __table_args__ = (
        sa.UniqueConstraint("path", name="uq_coding_workspaces_path"),
        sa.Index("ix_coding_workspaces_source_path", "source_path"),
    )

    id: UUID = Field(default_factory=uuid7, primary_key=True)
    path: str = Field(sa_column=Column(sa.String(), nullable=False))
    kind: str = Field(
        default="repo",
        max_length=20,
        sa_column=Column(sa.String(20), nullable=False, server_default="repo"),
    )
    source_path: str | None = Field(default=None)
    name: str | None = Field(default=None, max_length=255)
    managed: bool = Field(
        default=False,
        sa_column=Column(sa.Boolean, nullable=False, server_default=sa.false()),
    )
    hidden: bool = Field(
        default=False,
        sa_column=Column(sa.Boolean, nullable=False, server_default=sa.false()),
    )
    deleted_at: datetime | None = Field(default=None, sa_column=Column(TZDateTime()))
    created_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False),
    )
    updated_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False, onupdate=_utcnow),
    )


class PendingQuestion(SQLModel, table=True):
    """A question the lead agent asked the user, and the turn waiting on it.

    Written when ``ask_user`` suspends a turn and resolved when the
    user answers or dismisses.  The row is what makes the suspension durable:
    it outlives the process, so a restarted daemon can re-render the question
    and resume the turn from the tool call that raised it.

    ``payload`` holds the validated tool input (``{"questions": [...]}``) and
    ``answers`` the user's reply — a list of selected-label lists, index-matched
    to ``payload["questions"]``.
    """

    __tablename__: str = "pending_questions"  # type: ignore[reportIncompatibleVariableOverride]
    __table_args__ = (
        # At most one *open* question per session. The agent loop already caps
        # asks per turn, but a partial unique index makes a double-suspend
        # impossible even under a race, and keeps "is this session waiting on
        # me?" a single-row lookup.
        sa.Index(
            "uq_pending_questions_open_per_session",
            "session_id",
            unique=True,
            sqlite_where=sa.text("status = 'pending'"),
        ),
        # Session-list badges and startup reconciliation both scan by status.
        sa.Index("ix_pending_questions_status", "status"),
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
    # The suspended tool call. Its placeholder ToolMessage row is rewritten in
    # place on resolution, which is also what keeps heal_orphaned_tool_calls
    # from treating the suspended call as an orphan.
    tool_call_id: str = Field(
        sa_column=Column(sa.String(100), nullable=False, unique=True),
    )
    payload: dict = Field(sa_column=Column(JSON(), nullable=False))
    # pending → answered | dismissed | superseded | expired
    status: str = Field(
        default="pending",
        max_length=20,
        sa_column=Column(sa.String(20), nullable=False, server_default="pending"),
    )
    answers: list | None = Field(default=None, sa_column=Column(JSON(), nullable=True))
    created_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False),
    )
    answered_at: datetime | None = Field(
        default=None, sa_column=Column(TZDateTime(), nullable=True)
    )


class SessionMessage(SQLModel, table=True):
    __tablename__: str = "session_messages"  # type: ignore[reportIncompatibleVariableOverride]
    __table_args__ = (
        # The workhorse index. Every read filters on session_id and
        # then orders by (seq, id) — the transcript, the LLM window, and the
        # team-history ROW_NUMBER() windows — so all three columns are required
        # to satisfy the sort without a temp B-tree. ``kind`` predicates apply
        # as residual filters; a dedicated kind index lost to this one on every
        # query shape (same reasoning that consolidated the old indexes in
        # migration 00000017).
        #
        # This is the highest-write table in the schema, so a redundant index
        # is a B-tree insert on every persisted message.
        sa.Index(
            "ix_session_messages_session_seq_id",
            "session_id",
            "seq",
            "id",
        ),
        # Turn-completion deltas use the globally monotonic uuid7 ``id`` as a
        # creation cursor. Unlike ``seq`` it still finds freshly anchored
        # summaries whose logical position sits in the middle of history.
        # The session prefix makes each lead/member delta a bounded range
        # scan rather than a residual filter over the whole session.
        sa.Index(
            "ix_session_messages_session_id",
            "session_id",
            "id",
        ),
        # Active-summary lookup: ``WHERE kind='summary' ORDER BY id DESC
        # LIMIT 1`` runs on every window derivation. Without this it walks
        # all of the session's rows through a temp B-tree (~1.7 ms on a
        # 3k-row session); the partial index makes it a direct seek. Summary
        # rows are vanishingly rare (<0.05% of prod rows), so the index costs
        # kilobytes and is only touched when a compaction writes one.
        sa.Index(
            "ix_session_messages_active_summary",
            "session_id",
            "id",
            sqlite_where=sa.text("kind = 'summary'"),
        ),
    )

    id: UUID = Field(default_factory=uuid7, primary_key=True)
    session_id: UUID = Field(
        sa_column=Column(
            sa.Uuid(),
            ForeignKey("chat_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
    )
    role: str = Field(max_length=50)
    content: str | None = Field(default=None)
    reasoning_content: str | None = Field(default=None)

    # ── Position ──────────────────────────────────────────────────────────
    # Sparse per-session sequence number: the single ordering key for every
    # read path (transcript, LLM window, pagination). Allocated in steps of
    # ``SEQ_STEP`` so rows can be *anchored* between two existing rows
    # (summary dividers, healed tool stubs) by taking the midpoint. Ties are
    # broken by ``id`` (uuid7 — creation-ordered), so even a fully exhausted
    # gap only costs deterministic tie-breaking, never a constraint failure.
    #
    # ``created_at`` remains as honest wall-clock metadata for display; it is
    # never used for ordering or boundary math.
    seq: int = Field(
        default=0,
        sa_column=Column(sa.Integer(), nullable=False, server_default="0"),
    )

    # ── Kind ──────────────────────────────────────────────────────────────
    # What this row *is* — replaces the old ``is_summary`` /
    # ``exclude_from_context`` boolean pair and the ``extra.hidden_from_user``
    # / ``extra.queue_status`` JSON flags. LLM-context membership is *derived*
    # from (kind, seq) — see ``chat_service_revert.llm_window_rows`` — so
    # compaction and undo never mutate historical rows.
    #
    #   chat     — normal message. UI ✓. LLM ✓ when positioned at/after the
    #              active summary (or when no summary exists).
    #   note     — internal context for the LLM (mention blocks, truncation
    #              recovery, roster changes, team inbox copies). UI ✗, LLM
    #              same positional rule as chat.
    #   queued   — user message waiting for the current turn to finish.
    #              UI ✓ (queued badge), LLM ✓; promotion re-seqs it to the
    #              end and flips it to ``chat``.
    #   summary  — compaction summary. The *active* summary is the one with
    #              the highest ``id`` (uuid7 = true creation order — position
    #              can't be trusted because summaries are anchored before the
    #              window they kept). Non-active summaries stay visible in the
    #              UI as dividers but never enter the LLM window.
    #   reverted — undone by revert cleanup. UI ✗, LLM ✗, audit only.
    kind: str = Field(
        default="chat",
        max_length=16,
        sa_column=Column(sa.String(16), nullable=False, server_default="chat"),
    )

    # Position-independent LLM membership: pinned rows stay in the LLM window
    # even when positioned below the active summary. Set for retained skill
    # tool pairs (kind=chat) and for permanent internal context such as
    # mention blocks and roster notes (kind=note, saved with
    # ``extra.hidden_from_summary``). Orthogonal to ``kind`` because UI
    # visibility and compaction survival are independent axes — a mention
    # note is hidden *and* pinned, a skill pair is visible *and* pinned.
    # ``kind='reverted'`` always wins over pinned.
    pinned: bool = Field(
        default=False,
        sa_column=Column(sa.Boolean, nullable=False, server_default=sa.false()),
    )

    # Stores tool_calls as a list of dicts
    tool_calls: list[dict] | None = Field(
        default=None,
        sa_column=Column(JSON),
    )

    # For tool messages
    tool_call_id: str | None = Field(default=None, max_length=100)
    name: str | None = Field(default=None, max_length=100)

    # Flexible extra data (usage stats, provider blobs, attachments…).
    # Contract: ``extra`` is never queried in SQL on a hot path — anything
    # that needs an indexed predicate must be a real column (``kind``/``seq``).
    extra: dict | None = Field(
        default=None,
        sa_column=Column(JSON()),
    )

    created_at: datetime = Field(
        default_factory=_utcnow,
        sa_column=Column(TZDateTime(), nullable=False),
    )
