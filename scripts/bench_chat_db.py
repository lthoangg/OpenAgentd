"""Benchmark chat persistence hot paths against a (copy of a) production DB.

Times the read paths (LLM window, agent history pages/deltas, session list)
and the write paths (checkpointer sync, single message save) using the real
service-layer functions, so before/after numbers reflect what the app pays.

The source database is never touched: the DB (+ ``-wal``) is copied to a
scratch path first and everything runs against the copy.

Usage:
    uv run python scripts/bench_chat_db.py --db path/to/prod.db --label baseline
    uv run python scripts/bench_chat_db.py --db path/to/prod.db --label after \
        --migrate --compare .openagentd/dev/bench-baseline.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import statistics
import time
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="Source SQLite DB to copy.")
    parser.add_argument("--label", default="run", help="Label for the JSON output.")
    parser.add_argument("--repeat", type=int, default=7, help="Timed iterations.")
    parser.add_argument(
        "--out-dir",
        default=".openagentd/dev",
        help="Directory for the scratch DB copy and JSON results.",
    )
    parser.add_argument(
        "--compare",
        default=None,
        help="Previous results JSON to print a comparison against.",
    )
    parser.add_argument(
        "--migrate",
        action="store_true",
        help="Upgrade the scratch copy to the current schema before timing.",
    )
    return parser.parse_args()


ARGS = _parse_args()

# Point the app at the scratch copy *before* importing anything from app.*.
_out_dir = Path(ARGS.out_dir)
_out_dir.mkdir(parents=True, exist_ok=True)
_scratch = _out_dir / "bench-work.db"
_src = Path(ARGS.db)
shutil.copyfile(_src, _scratch)
_wal = _src.with_name(_src.name + "-wal")
_scratch_wal = _scratch.with_name(_scratch.name + "-wal")
if _wal.exists():
    shutil.copyfile(_wal, _scratch_wal)
elif _scratch_wal.exists():
    _scratch_wal.unlink()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_scratch.resolve()}"

import sqlalchemy as sa  # noqa: E402
from sqlmodel import col, select  # noqa: E402

from app.agent.schemas.chat import AssistantMessage, HumanMessage, ToolCall, ToolMessage  # noqa: E402
from app.agent.schemas.chat import FunctionCall  # noqa: E402
from app.agent.checkpointer import SQLiteCheckpointer  # noqa: E402
from app.agent.state import AgentState, RunContext  # noqa: E402
from app.core.db import async_session_factory, run_migrations  # noqa: E402
from app.models.chat import SessionMessage  # noqa: E402
from app.services import chat_service  # noqa: E402


async def _timed(fn, repeat: int) -> list[float]:
    """Run *fn* once as warmup, then *repeat* timed iterations (ms)."""
    await fn()
    out: list[float] = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        await fn()
        out.append((time.perf_counter() - t0) * 1000.0)
    return out


async def _pick_targets() -> dict:
    """Deterministically pick benchmark sessions from the DB itself."""
    async with async_session_factory() as db:
        # Top sessions by row count (LLM window benches).
        rows = (
            await db.exec(
                select(SessionMessage.session_id, sa.func.count().label("c"))
                .group_by(col(SessionMessage.session_id))
                .order_by(sa.desc("c"))
                .limit(3)
            )
        ).all()
        top_sessions = [(r[0], int(r[1])) for r in rows]

        # Start with the most child rows (session history benches).
        lead_row = (
            await db.exec(
                sa.text(
                    """
                    SELECT cs.parent_session_id, COUNT(*) AS c
                    FROM session_messages sm
                    JOIN chat_sessions cs ON cs.id = sm.session_id
                    WHERE cs.parent_session_id IS NOT NULL
                    GROUP BY cs.parent_session_id ORDER BY c DESC LIMIT 1
                    """
                )
            )
        ).first()
        from uuid import UUID

        lead_id = UUID(lead_row[0])

        # A tail cursor ≈ the newest 5% of the lead tree —
        # matches what a turn-completion delta poll sends.
        id_rows = (
            await db.exec(
                sa.text(
                    """
                    SELECT sm.id FROM session_messages sm
                    WHERE sm.session_id IN (
                        SELECT id FROM chat_sessions
                        WHERE id = :lead OR parent_session_id = :lead
                    )
                    ORDER BY sm.id
                    """
                ).bindparams(lead=lead_row[0])
            )
        ).all()
        tail_id = id_rows[int(len(id_rows) * 0.95)][0]

    return {
        "top_sessions": top_sessions,
        "lead_id": lead_id,
        "lead_rows": len(id_rows),
        "tail_id": tail_id,
    }


def _make_turn_messages(n_tools: int) -> list:
    """One assistant turn with *n_tools* tool calls + results (realistic sizes)."""
    calls = [
        ToolCall(
            id=f"call_bench_{i}_{time.monotonic_ns()}",
            function=FunctionCall(name="Shell", arguments='{"command": "ls -la"}'),
        )
        for i in range(n_tools)
    ]
    msgs: list = [
        AssistantMessage(content="Working on it. " * 40, tool_calls=calls or None)
    ]
    for c in calls:
        msgs.append(
            ToolMessage(content="output line\n" * 200, tool_call_id=c.id, name="Shell")
        )
    return msgs


async def main() -> None:
    from uuid import UUID

    if ARGS.migrate:
        await asyncio.to_thread(run_migrations)

    targets = await _pick_targets()
    repeat = ARGS.repeat
    results: dict[str, dict] = {}

    def record(name: str, timings: list[float], note: str = "") -> None:
        results[name] = {
            "median_ms": round(statistics.median(timings), 3),
            "min_ms": round(min(timings), 3),
            "mean_ms": round(statistics.fmean(timings), 3),
            "note": note,
        }
        print(
            f"{name:34s} median={results[name]['median_ms']:>9.3f}ms "
            f"min={results[name]['min_ms']:>9.3f}ms  {note}"
        )

    # ── Read: LLM window (SQL only, and full pipeline) ────────────────────
    for sid, count in targets["top_sessions"]:
        sid = UUID(sid) if isinstance(sid, str) else sid

        async def rows_only(sid=sid):
            async with async_session_factory() as db:
                await chat_service._llm_window_rows(db, sid)

        async def full(sid=sid):
            async with async_session_factory() as db:
                await chat_service.get_messages_for_llm(db, sid)

        record(f"llm_window_rows[{count}]", await _timed(rows_only, repeat))
        record(f"get_messages_for_llm[{count}]", await _timed(full, repeat))

    # ── Read: incremental window after cursor (member turn hot path) ─────
    big_sid, big_count = targets["top_sessions"][0]
    big_sid = UUID(big_sid) if isinstance(big_sid, str) else big_sid
    async with async_session_factory() as db:
        cur_rows = (
            await db.exec(
                select(SessionMessage.seq, SessionMessage.id)
                .where(col(SessionMessage.session_id) == big_sid)
                .order_by(col(SessionMessage.seq).asc(), col(SessionMessage.id).asc())
            )
        ).all()
    cursor = cur_rows[int(len(cur_rows) * 0.98)]

    async def after_cursor():
        async with async_session_factory() as db:
            await chat_service.get_messages_for_llm_after(
                db, big_sid, (cursor[0], cursor[1])
            )

    record(f"llm_after_cursor[{big_count}]", await _timed(after_cursor, repeat))

    # ── Read: heal scan (runs before every user message) ─────────────────
    async def heal():
        async with async_session_factory() as db:
            await chat_service.heal_orphaned_tool_calls(db, big_sid)
            # no commit — rolled back on close so reruns stay comparable

    record(f"heal_orphaned[{big_count}]", await _timed(heal, repeat))

    # ── Read: agent history page 1 / page 2 / delta ───────────────────────
    lead_id = targets["lead_id"]

    async def page1():
        async with async_session_factory() as db:
            return await chat_service.get_agent_history(db, lead_id)

    record(f"agent_history_p1[{targets['lead_rows']}]", await _timed(page1, repeat))

    async with async_session_factory() as db:
        h = await chat_service.get_agent_history(db, lead_id)
    assert h is not None

    async def page2():
        async with async_session_factory() as db:
            await chat_service.get_agent_history(
                db, lead_id, before_seq=h.next_cursor, before_id=h.next_cursor_id
            )

    if h.next_cursor is not None:
        record(f"agent_history_p2[{targets['lead_rows']}]", await _timed(page2, repeat))

    tail_id = UUID(hex=targets["tail_id"])

    async def delta():
        async with async_session_factory() as db:
            await chat_service.get_agent_history_since(db, lead_id, since_id=tail_id)

    record(f"agent_history_since[{targets['lead_rows']}]", await _timed(delta, repeat))

    # ── Read: session list scan (all pages) ───────────────────────────────
    async def list_all():
        async with async_session_factory() as db:
            before = None
            while True:
                _, before, more = await chat_service.list_sessions_page(
                    db, before=before, limit=50
                )
                if not more:
                    break

    record("list_sessions_all_pages", await _timed(list_all, repeat))

    # ── Write: checkpointer sync of a tool-heavy turn ─────────────────────
    sync_timings: list[float] = []
    for i in range(repeat + 1):
        cp = SQLiteCheckpointer(async_session_factory)
        state = AgentState(messages=_make_turn_messages(20))
        ctx = RunContext(session_id=str(big_sid), run_id="bench", agent_name="bench")
        t0 = time.perf_counter()
        await cp.sync(ctx, state)
        dt = (time.perf_counter() - t0) * 1000.0
        if i > 0:  # first run is warmup
            sync_timings.append(dt)
    record("checkpointer_sync_1a+20t", sync_timings, "writes 21 rows/iter")

    # ── Write: single user message via save_message ───────────────────────
    async def save_user():
        async with async_session_factory() as db:
            await chat_service.save_message(
                db, big_sid, HumanMessage(content="bench user message")
            )
            await db.commit()

    record("save_user_message", await _timed(save_user, repeat))

    out_path = _out_dir / f"bench-{ARGS.label}.json"
    out_path.write_text(json.dumps({"label": ARGS.label, "results": results}, indent=2))
    print(f"\nwrote {out_path}")

    if ARGS.compare:
        prev = json.loads(Path(ARGS.compare).read_text())
        print(f"\n── comparison vs {prev['label']} ──")
        for name, cur in results.items():
            old = prev["results"].get(name)
            if not old:
                continue
            base, now = old["median_ms"], cur["median_ms"]
            delta_pct = ((now - base) / base * 100.0) if base else 0.0
            print(f"{name:34s} {base:>9.3f} → {now:>9.3f} ms  ({delta_pct:+6.1f}%)")


if __name__ == "__main__":
    asyncio.run(main())
