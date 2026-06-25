"""Differential verification of the team-history N+1 batch refactor.

Background
----------
``app.services.chat_service.get_team_history`` used to fetch each
sub-session's message page with its own ``SELECT`` inside a Python loop
(an N+1). It now fetches every member page with a single batched
``WHERE session_id IN (...)`` query (``_fetch_member_pages``).

This script proves the refactor is *logically equivalent* to the old
loop. It does NOT need a running server: it stands up an in-memory
SQLite DB (same pragmas as production), seeds a range of scenarios, then
compares the live ``_fetch_member_pages`` output against a faithful
reimplementation of the OLD per-session loop on identical data.

Run::

    uv run python -m manual.team_history_n1_verify

Exits non-zero if any scenario diverges.
"""

from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid7

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import ChatSession, SessionMessage
from app.services.chat_service import (
    _HISTORY_PAGE_SIZE,
    _fetch_member_pages,
)
from app.services.chat_service_revert import is_hidden_from_user

_BASE_TS = datetime(2026, 1, 1, tzinfo=timezone.utc)


# ── OLD implementation (the per-session N+1 loop), reproduced verbatim ──────
async def _old_member_pages(
    db: AsyncSession,
    sub_sessions: list[ChatSession],
    *,
    before: datetime | None,
) -> list[tuple[UUID, list[UUID]]]:
    """Faithful copy of the pre-refactor loop. Returns (session_id, [msg_id])."""

    def _fetch_page(session_id: UUID):
        stmt = (
            select(SessionMessage)
            .where(col(SessionMessage.session_id) == session_id)
            .order_by(col(SessionMessage.created_at).desc())
            .limit(_HISTORY_PAGE_SIZE + 1)
        )
        if before is not None:
            stmt = stmt.where(col(SessionMessage.created_at) < before)
        return stmt

    out: list[tuple[UUID, list[UUID]]] = []
    for sub in sub_sessions:
        raw_member = [
            msg
            for msg in (await db.exec(_fetch_page(sub.id))).all()
            if not is_hidden_from_user(msg)
        ]
        member_msgs = list(reversed(raw_member[:_HISTORY_PAGE_SIZE]))
        out.append((sub.id, [m.id for m in member_msgs]))
    return out


def _ids(members) -> list[tuple[UUID, list[UUID]]]:
    """Normalise TeamHistoryMemberData -> (session_id, [msg_id])."""
    return [(m.session.id, [msg.id for msg in m.messages]) for m in members]


async def _seed_interleaved(
    db: AsyncSession, *, n_members: int, per: int
) -> tuple[UUID, list[ChatSession]]:
    """Seed members round-robin so their messages interleave in time.

    Stresses the batched query's global ``created_at DESC`` ordering +
    Python grouping: member rows are NOT contiguous in the global sort.
    """
    lead_id = uuid7()
    db.add(ChatSession(id=lead_id, agent_name="lead"))
    subs = [
        ChatSession(id=uuid7(), parent_session_id=lead_id, agent_name=f"m{i}")
        for i in range(n_members)
    ]
    for s in subs:
        db.add(s)
    await db.flush()

    tick = 0
    for j in range(per):
        for i, sub in enumerate(subs):
            tick += 1
            db.add(
                SessionMessage(
                    session_id=sub.id,
                    role="user",
                    content=f"m{i}-round{j}",
                    created_at=_BASE_TS + timedelta(seconds=tick),
                )
            )
    await db.flush()
    subs_sorted = (
        await db.exec(
            select(ChatSession)
            .where(col(ChatSession.parent_session_id) == lead_id)
            .order_by(col(ChatSession.created_at).asc())
        )
    ).all()
    return lead_id, list(subs_sorted)


# ── Seeding helpers ─────────────────────────────────────────────────────────
async def _seed(
    db: AsyncSession,
    *,
    n_members: int,
    counts: list[int],
    hidden_every: int = 0,
) -> tuple[UUID, list[ChatSession]]:
    """Create a lead + ``n_members`` sub-sessions with ``counts[i]`` messages.

    Timestamps are strictly increasing across the whole tree so ordering is
    deterministic. Every ``hidden_every``-th message (1-indexed) on each
    member is flagged ``extra.hidden_from_user`` (0 = none).
    """
    lead_id = uuid7()
    db.add(ChatSession(id=lead_id, agent_name="lead"))

    subs: list[ChatSession] = []
    tick = 0
    for i in range(n_members):
        sub = ChatSession(id=uuid7(), parent_session_id=lead_id, agent_name=f"m{i}")
        db.add(sub)
        subs.append(sub)

    await db.flush()

    for i, sub in enumerate(subs):
        for j in range(counts[i]):
            tick += 1
            extra = None
            if hidden_every and (j + 1) % hidden_every == 0:
                extra = {"hidden_from_user": True}
            db.add(
                SessionMessage(
                    session_id=sub.id,
                    role="user" if j % 2 == 0 else "assistant",
                    content=f"m{i}-msg{j}",
                    extra=extra,
                    created_at=_BASE_TS + timedelta(seconds=tick),
                )
            )
    await db.flush()
    # order sub_sessions ascending by created_at to match get_team_history
    subs_sorted = (
        await db.exec(
            select(ChatSession)
            .where(col(ChatSession.parent_session_id) == lead_id)
            .order_by(col(ChatSession.created_at).asc())
        )
    ).all()
    return lead_id, list(subs_sorted)


# ── Scenarios ───────────────────────────────────────────────────────────────
async def _run_scenario(
    factory: async_sessionmaker[AsyncSession],
    name: str,
    *,
    n_members: int,
    counts: list[int],
    hidden_every: int,
    before: datetime | None,
) -> bool:
    async with factory() as db:
        _, subs = await _seed(
            db, n_members=n_members, counts=counts, hidden_every=hidden_every
        )
        old = await _old_member_pages(db, subs, before=before)
        new = _ids(await _fetch_member_pages(db, subs, before=before))

    ok = old == new
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] {name}")
    if not ok:
        print(f"        old: {[(str(s)[:8], len(ids)) for s, ids in old]}")
        print(f"        new: {[(str(s)[:8], len(ids)) for s, ids in new]}")
        # Show first divergence in detail
        for (so, io), (sn, inn) in zip(old, new):
            if so != sn or io != inn:
                print(f"        diverge session={str(so)[:8]}")
                print(f"          old ids: {[str(x)[:8] for x in io]}")
                print(f"          new ids: {[str(x)[:8] for x in inn]}")
                break
    return ok


async def main() -> int:
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    page = _HISTORY_PAGE_SIZE
    print(f"_HISTORY_PAGE_SIZE = {page}")
    print("Comparing batched _fetch_member_pages vs old per-session loop:\n")

    scenarios = [
        # (name, n_members, counts, hidden_every, before)
        ("no members", 0, [], 0, None),
        ("single member, few msgs", 1, [3], 0, None),
        ("multi member, uneven counts", 4, [1, 5, 0, 7], 0, None),
        ("empty member among non-empty", 3, [0, 4, 0], 0, None),
        ("hidden rows scattered", 3, [6, 6, 6], 2, None),
        ("all-hidden member", 2, [4, 4], 1, None),
        ("exactly page size", 1, [page], 0, None),
        ("one over page size", 1, [page + 1], 0, None),
        ("well over page size", 2, [page + 25, page + 5], 0, None),
        ("over page size with hidden", 1, [page + 10], 3, None),
        # `before` cursor: cut at a timestamp partway through the tree.
        ("before cursor mid-tree", 3, [5, 5, 5], 0, _BASE_TS + timedelta(seconds=8)),
        (
            "before cursor + hidden",
            3,
            [5, 5, 5],
            2,
            _BASE_TS + timedelta(seconds=10),
        ),
        ("before cursor before all", 2, [3, 3], 0, _BASE_TS),
    ]

    all_ok = True
    for name, n, counts, hidden, before in scenarios:
        ok = await _run_scenario(
            factory,
            name,
            n_members=n,
            counts=counts,
            hidden_every=hidden,
            before=before,
        )
        all_ok = all_ok and ok

    # Interleaved scenarios: members' messages alternate in global time order,
    # so the batched DESC sort must still group + trim correctly per session.
    for label, n, per, before in [
        ("interleaved small", 3, 4, None),
        ("interleaved over page size", 3, page + 10, None),
        ("interleaved + before cursor", 4, 6, _BASE_TS + timedelta(seconds=12)),
    ]:
        async with factory() as db:
            _, subs = await _seed_interleaved(db, n_members=n, per=per)
            old = await _old_member_pages(db, subs, before=before)
            new = _ids(await _fetch_member_pages(db, subs, before=before))
        ok = old == new
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
        if not ok:
            print(f"        old: {[(str(s)[:8], len(i)) for s, i in old]}")
            print(f"        new: {[(str(s)[:8], len(i)) for s, i in new]}")
        all_ok = all_ok and ok

    await engine.dispose()

    print()
    if all_ok:
        print("✅ ALL SCENARIOS EQUIVALENT — batched refactor is logically correct.")
        return 0
    print("❌ DIVERGENCE DETECTED — batched refactor changed behaviour.")
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
