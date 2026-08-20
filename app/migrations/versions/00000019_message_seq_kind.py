"""session_messages: derived-state remodel — seq + kind + pinned

Replaces the mutable boolean pair (``is_summary`` / ``exclude_from_context``)
and the SQL-queried JSON flags (``extra.hidden_from_user`` /
``extra.queue_status``) with three real columns whose meaning never requires
fan-out UPDATEs over historical rows:

* ``seq``    — sparse per-session position (step 1024). The single ordering
               key for every read path; ``created_at`` becomes display-only.
* ``kind``   — what the row *is*: chat | note | queued | summary | reverted.
* ``pinned`` — position-independent LLM membership (skill pairs, mention /
               roster notes that must survive compaction).

LLM-context membership is now *derived*: the active summary is the
``kind='summary'`` row with the highest ``id`` (uuid7 = creation order), and
the window is ``pinned`` rows plus everything positioned at/after it.

Backfill mapping (uses the old columns before dropping them):

* ``seq``  = ROW_NUMBER() OVER (PARTITION BY session_id
             ORDER BY created_at, id) * 1024
* ``kind``:
    - ``extra.queue_status = 'queued'``            → queued
    - ``is_summary`` and hidden                    → reverted (undone summary)
    - ``is_summary``                               → summary
    - hidden and ``exclude_from_context``          → reverted
    - hidden                                       → note
    - otherwise                                    → chat
* ``pinned`` = 1 for non-summary, non-queued rows positioned before the
  session's active summary that were still in the LLM window
  (``exclude_from_context = 0``) — those are exactly the rows the old model
  deliberately retained through compaction.

Revision ID: 00000019
Revises: 00000018
Create Date: 2026-08-15
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "00000019"
down_revision: Union[str, Sequence[str], None] = "00000018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# json_extract returns 1 for JSON true, and historical writers occasionally
# stored "1"/"true" strings — treat all truthy spellings as hidden.
_HIDDEN = "COALESCE(json_extract(extra, '$.hidden_from_user'), 0) IN (1, '1', 'true')"


def _column_names() -> set[str]:
    inspector = sa.inspect(op.get_bind())

    return {column["name"] for column in inspector.get_columns("session_messages")}


def _index_names() -> set[str]:
    inspector = sa.inspect(op.get_bind())

    return {
        name
        for idx in inspector.get_indexes("session_messages")
        if (name := idx["name"])
    }


def upgrade() -> None:
    # SQLite DDL is not transactional in Alembic's migration environment.
    #
    # A process can therefore be interrupted after one or more ADD COLUMN
    # statements have succeeded but before Alembic stamps this revision.
    #
    # Do explicit schema-state detection instead of relying on
    # ADD COLUMN IF NOT EXISTS, which SQLite does not support.
    columns = _column_names()

    if "seq" not in columns:
        op.add_column(
            "session_messages",
            sa.Column(
                "seq",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )

    if "kind" not in columns:
        op.add_column(
            "session_messages",
            sa.Column(
                "kind",
                sa.String(16),
                nullable=False,
                server_default="chat",
            ),
        )

    if "pinned" not in columns:
        op.add_column(
            "session_messages",
            sa.Column(
                "pinned",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )

    # Refresh after DDL. The initial `columns` snapshot may no longer match
    # the actual schema.
    columns = _column_names()

    has_is_summary = "is_summary" in columns
    has_exclude_from_context = "exclude_from_context" in columns

    # The two legacy columns are removed together by batch_alter_table().
    #
    # Both present:
    #   migration has not yet completed the legacy conversion, so rerun the
    #   deterministic backfill and remove them.
    #
    # Both absent:
    #   an earlier attempt got through the table rebuild but failed before
    #   Alembic stamped the revision. Skip legacy SQL and repair indexes.
    #
    # Exactly one present:
    #   unexpected/corrupt intermediate schema; do not guess how to repair it.
    if has_is_summary != has_exclude_from_context:
        raise RuntimeError(
            "session_messages is in an unexpected partial migration state: "
            f"is_summary={has_is_summary}, "
            f"exclude_from_context={has_exclude_from_context}"
        )

    if has_is_summary:
        _backfill_and_drop_legacy_columns()

    _ensure_indexes()


def _backfill_and_drop_legacy_columns() -> None:
    # ── seq backfill ──────────────────────────────────────────────────────
    #
    # This is deliberately safe to rerun while the legacy columns still
    # exist. If an earlier migration attempt stopped somewhere in the
    # backfill, start again from the canonical legacy ordering.
    op.execute(
        """
        UPDATE session_messages
        SET seq = ordered.rn * 1024
        FROM (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY session_id
                    ORDER BY created_at, id
                ) AS rn
            FROM session_messages
        ) AS ordered
        WHERE session_messages.id = ordered.id
        """
    )

    # ── kind backfill ─────────────────────────────────────────────────────
    op.execute(
        f"""
        UPDATE session_messages
        SET kind = CASE
            WHEN json_extract(extra, '$.queue_status') = 'queued'
                THEN 'queued'

            WHEN is_summary = 1 AND {_HIDDEN}
                THEN 'reverted'

            WHEN is_summary = 1
                THEN 'summary'

            WHEN {_HIDDEN} AND exclude_from_context = 1
                THEN 'reverted'

            WHEN {_HIDDEN}
                THEN 'note'

            ELSE 'chat'
        END
        WHERE is_summary = 1
           OR extra IS NOT NULL
        """
    )

    # ── positional repair ─────────────────────────────────────────────────
    #
    # Legacy anchoring quirk: the old checkpointer anchored a summary before
    # the *first* retained row, so rows it compacted could end up positioned
    # *after* the summary (scattered exclusion).
    #
    # Positional coverage cannot express "excluded but above the summary",
    # so move those rows to tie with the summary's seq. uuid7 ids preserve
    # their relative order and sort them before the newer summary row,
    # putting them back under its coverage without touching anything else.
    op.execute(
        """
        UPDATE session_messages
        SET seq = (
            SELECT s.seq
            FROM session_messages AS s
            WHERE s.session_id = session_messages.session_id
              AND s.kind = 'summary'
            ORDER BY s.id DESC
            LIMIT 1
        )
        WHERE kind IN ('chat', 'note')
          AND exclude_from_context = 1
          AND session_id IN (
              SELECT DISTINCT session_id
              FROM session_messages
              WHERE kind = 'summary'
          )
          AND id < (
              SELECT s.id
              FROM session_messages AS s
              WHERE s.session_id = session_messages.session_id
                AND s.kind = 'summary'
              ORDER BY s.id DESC
              LIMIT 1
          )
          AND (seq, id) > (
              SELECT s.seq, s.id
              FROM session_messages AS s
              WHERE s.session_id = session_messages.session_id
                AND s.kind = 'summary'
              ORDER BY s.id DESC
              LIMIT 1
          )
        """
    )

    # Residual excluded rows that no summary can cover: stranded artifacts of
    # an old queue-promotion bug (user rows whose exclude flag survived a
    # crashed release) in sessions without a summary, or created *after* the
    # active summary.
    #
    # The old model kept them permanently out of the LLM via the flag; the
    # derived model expresses that as ``reverted``.
    op.execute(
        """
        UPDATE session_messages
        SET kind = 'reverted'
        WHERE kind IN ('chat', 'note')
          AND exclude_from_context = 1
          AND (
              session_id NOT IN (
                  SELECT DISTINCT session_id
                  FROM session_messages
                  WHERE kind = 'summary'
              )
              OR (seq, id) > (
                  SELECT s.seq, s.id
                  FROM session_messages AS s
                  WHERE s.session_id = session_messages.session_id
                    AND s.kind = 'summary'
                  ORDER BY s.id DESC
                  LIMIT 1
              )
          )
        """
    )

    # ── pinned backfill ───────────────────────────────────────────────────
    #
    # For every session with an active summary (highest id among
    # kind='summary' — uuid7 hex sorts by creation time), rows positioned
    # before that summary which the old model kept in the LLM window
    # (exclude_from_context = 0) were deliberately retained: skill tool
    # pairs and hidden-from-summary notes.
    #
    # Mark them pinned so the derived window reproduces the old one exactly.
    op.execute(
        """
        UPDATE session_messages
        SET pinned = 1
        WHERE kind IN ('chat', 'note')
          AND exclude_from_context = 0
          AND session_id IN (
              SELECT DISTINCT session_id
              FROM session_messages
              WHERE kind = 'summary'
          )
          AND seq < (
              SELECT s.seq
              FROM session_messages AS s
              WHERE s.session_id = session_messages.session_id
                AND s.kind = 'summary'
              ORDER BY s.id DESC
              LIMIT 1
          )
        """
    )

    # ── drop legacy flags ─────────────────────────────────────────────────
    #
    # batch_alter_table performs the SQLite move/copy/recreate operation.
    #
    # Only reach this point when *both* legacy columns exist.
    with op.batch_alter_table("session_messages") as batch:
        batch.drop_column("is_summary")
        batch.drop_column("exclude_from_context")


def _ensure_indexes() -> None:
    # batch_alter_table rebuilds the table on SQLite. Depending on exactly
    # where a previous migration attempt was interrupted, indexes can be in
    # either their old or new state.
    #
    # Normalize them rather than assuming a specific starting point.
    names = _index_names()

    if "ix_session_messages_session_created_id" in names:
        op.drop_index(
            "ix_session_messages_session_created_id",
            table_name="session_messages",
        )

    # Refresh because index DDL above changes inspector-visible state.
    names = _index_names()

    if "ix_session_messages_session_seq_id" not in names:
        op.create_index(
            "ix_session_messages_session_seq_id",
            "session_messages",
            ["session_id", "seq", "id"],
            unique=False,
        )

    names = _index_names()

    if "ix_session_messages_active_summary" not in names:
        # Partial index for the active-summary lookup
        # (kind='summary' rows only).
        op.create_index(
            "ix_session_messages_active_summary",
            "session_messages",
            ["session_id", "id"],
            unique=False,
            sqlite_where=sa.text("kind = 'summary'"),
        )

    # Do NOT VACUUM here.
    #
    # VACUUM requires leaving Alembic's normal transaction context.
    # autocommit_block() commits preceding migration work before Alembic has
    # necessarily stamped this revision, which creates another recoverability
    # boundary if the application is terminated.
    #
    # Run VACUUM separately as optional DB maintenance after migrations have
    # completed successfully.


def downgrade() -> None:
    op.add_column(
        "session_messages",
        sa.Column(
            "is_summary",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.add_column(
        "session_messages",
        sa.Column(
            "exclude_from_context",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.execute(
        """
        UPDATE session_messages
        SET is_summary = 1
        WHERE kind = 'summary'
        """
    )

    # Approximate reverse mapping: everything positioned below the active
    # summary that is not pinned was out of the LLM window, as is anything
    # reverted.
    #
    # Position is the (seq, id) tuple — legacy re-anchored rows tie with the
    # summary's seq and sort before it only by id, so a bare ``seq <``
    # comparison would miss them.
    #
    # Sessions without a summary yield a NULL row value, which compares
    # falsy, excluding nothing.
    op.execute(
        """
        UPDATE session_messages
        SET exclude_from_context = 1
        WHERE kind = 'reverted'
           OR kind = 'queued'
           OR (
               pinned = 0
               AND kind IN ('chat', 'note')
               AND (seq, id) < (
                   SELECT s.seq, s.id
                   FROM session_messages AS s
                   WHERE s.session_id = session_messages.session_id
                     AND s.kind = 'summary'
                   ORDER BY s.id DESC
                   LIMIT 1
               )
           )
        """
    )

    op.execute(
        """
        UPDATE session_messages
        SET extra = json_set(
            COALESCE(extra, '{}'),
            '$.hidden_from_user',
            1
        )
        WHERE kind IN ('note', 'reverted')
        """
    )

    op.execute(
        """
        UPDATE session_messages
        SET extra = json_set(
            COALESCE(extra, '{}'),
            '$.queue_status',
            'queued'
        )
        WHERE kind = 'queued'
        """
    )

    # Drop indexes over seq/kind before rebuilding the table. Otherwise the
    # SQLite batch operation can attempt to recreate indexes that reference
    # columns which have just been removed.
    names = _index_names()

    if "ix_session_messages_session_seq_id" in names:
        op.drop_index(
            "ix_session_messages_session_seq_id",
            table_name="session_messages",
        )

    names = _index_names()

    if "ix_session_messages_active_summary" in names:
        op.drop_index(
            "ix_session_messages_active_summary",
            table_name="session_messages",
        )

    with op.batch_alter_table("session_messages") as batch:
        batch.drop_column("seq")
        batch.drop_column("kind")
        batch.drop_column("pinned")

    names = _index_names()

    if "ix_session_messages_session_created_id" not in names:
        op.create_index(
            "ix_session_messages_session_created_id",
            "session_messages",
            ["session_id", "created_at", "id"],
            unique=False,
        )
