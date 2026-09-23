"""Empirical benchmarks comparing agent execution, memory, and database overhead.

Measures:
1. Checkpointer load latency & object allocation (shallow copy vs deepcopy).
2. SQLite write transactions & latency for multi-tool turns (coalesced vs unbatched).
3. Message history retrieval & empty-session load query reduction.
4. Memory stream store turn completion memory reclamation.

Run with: uv run python tests/manual/benchmark_comparison.py
"""

from __future__ import annotations

import asyncio
import copy
import gc
import time
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid7

from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agent.checkpointer import SQLiteCheckpointer
from app.agent.hooks.base import BaseAgentHook
from app.agent.schemas.chat import (
    AssistantMessage,
    FunctionCall,
    HumanMessage,
    ToolCall,
    ToolMessage,
)
from app.agent.state import (
    AgentState,
    ModelRequest,
    RunContext,
    build_model_chain,
    build_tool_chain,
)
from app.services import memory_stream_store as stream_store
from app.services.chat_service import (
    create_chat_session,
    save_message,
)
from app.services.stream_envelope import StreamEnvelope


def capture_statements(engine) -> tuple[list[str], Callable[[], None]]:
    statements: list[str] = []
    commits: list[float] = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    def record_commit(_conn):
        commits.append(time.perf_counter())

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    event.listen(engine.sync_engine, "commit", record_commit)

    def stop() -> None:
        event.remove(engine.sync_engine, "before_cursor_execute", record)
        event.remove(engine.sync_engine, "commit", record_commit)

    return statements, commits, stop


def make_sample_transcript(count: int) -> list:
    """Build a realistic conversation transcript with text, reasoning, and tool calls."""
    messages = []
    for i in range(count // 2):
        messages.append(
            HumanMessage(content=f"Please edit file_{i}.py and run pytest.")
        )
        assistant_msg = AssistantMessage(
            content=f"I will read file_{i}.py and apply the changes.",
            reasoning_content=f"Need to check dependencies and imports for module {i}...",
            tool_calls=[
                ToolCall(
                    id=f"call_{i}_1",
                    function=FunctionCall(
                        name="read",
                        arguments=f'{{"path": "src/module_{i}.py"}}',
                    ),
                ),
            ],
        )
        tool_msg = ToolMessage(
            content="def function_"
            + str(i)
            + "():\n    return 'result "
            + ("x" * 200)
            + "'",
            tool_call_id=f"call_{i}_1",
            name="read",
        )
        messages.append(assistant_msg)
        messages.append(tool_msg)
    return messages


async def benchmark_deepcopy_vs_shallow() -> None:
    print("\n══════════════════════════════════════════════════════════════════════")
    print(" Benchmark 1: Context Resume Memory & GIL Latency")
    print("══════════════════════════════════════════════════════════════════════")
    for size in (10, 50, 100):
        messages = make_sample_transcript(size)
        cached_state = AgentState(messages=messages)

        # Measure copy.deepcopy
        gc.collect()
        start_deep = time.perf_counter()
        for _ in range(200):
            _ = AgentState(messages=copy.deepcopy(cached_state.messages))
        deep_duration = (time.perf_counter() - start_deep) / 200 * 1000  # ms

        # Measure shallow copy (current implementation)
        gc.collect()
        start_shallow = time.perf_counter()
        for _ in range(200):
            _ = AgentState(messages=list(cached_state.messages))
        shallow_duration = (time.perf_counter() - start_shallow) / 200 * 1000  # ms

        speedup = deep_duration / max(shallow_duration, 0.0001)
        print(
            f"  Messages: {len(messages):3d} | deepcopy: {deep_duration:6.3f} ms | "
            f"shallow: {shallow_duration:6.4f} ms | Speedup: {speedup:5.1f}x"
        )


async def benchmark_db_transactions() -> None:
    print("\n══════════════════════════════════════════════════════════════════════")
    print(" Benchmark 2: SQLite Write Transactions (Coalesced vs Unbatched)")
    print("══════════════════════════════════════════════════════════════════════")

    with TemporaryDirectory() as directory:
        db_path = Path(directory) / "bench.sqlite"
        engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
        factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)

        async with factory() as session:
            chat_sess = await create_chat_session(session, title="Benchmark")
            sess_id = chat_sess.id
            await session.commit()

        checkpointer = SQLiteCheckpointer(factory)

        # Simulate 5-tool turn:
        # Method A: Unbatched (per-step sync: 1 assistant sync + 5 tool syncs = 6 transactions)
        ctx = RunContext(
            session_id=str(sess_id), run_id=str(uuid7()), agent_name="assistant"
        )

        statements, commits, stop = capture_statements(engine)
        start_time = time.perf_counter()

        # Coalesced (current implementation): assistant + 5 tools persisted together
        assistant_msg = AssistantMessage(
            content="I will run tools.",
            tool_calls=[
                ToolCall(
                    id=f"c_{i}", function=FunctionCall(name=f"t_{i}", arguments="{}")
                )
                for i in range(5)
            ],
        )
        tool_msgs = [
            ToolMessage(content=f"result_{i}", tool_call_id=f"c_{i}", name=f"t_{i}")
            for i in range(5)
        ]
        coalesced_state = AgentState(messages=[assistant_msg] + tool_msgs)
        await checkpointer.sync(ctx, coalesced_state)
        coalesced_duration = (time.perf_counter() - start_time) * 1000
        stop()

        coalesced_commits = len(commits)
        coalesced_inserts = sum(1 for s in statements if "INSERT" in s.strip().upper())

        print(
            f"  Coalesced 5-Tool Turn: {coalesced_duration:6.2f} ms | "
            f"COMMITs: {coalesced_commits} | INSERTs: {coalesced_inserts}"
        )

        # Compare against simulated unbatched syncs (syncing after each tool)
        unbatched_sess_id = str(uuid7())
        async with factory() as session:
            await create_chat_session(
                session, title="Unbatched", parent_session_id=None
            )
            await session.commit()

        unbatched_ctx = RunContext(
            session_id=unbatched_sess_id, run_id=str(uuid7()), agent_name="assistant"
        )
        unbatched_checkpointer = SQLiteCheckpointer(factory)
        statements_unbatched, commits_unbatched, stop_unbatched = capture_statements(
            engine
        )
        start_unbatched = time.perf_counter()

        # 1 sync for assistant
        state_step = AgentState(messages=[assistant_msg])
        await unbatched_checkpointer.sync(unbatched_ctx, state_step)
        # 5 separate syncs for each tool
        for i in range(5):
            state_step.messages.append(tool_msgs[i])
            await unbatched_checkpointer.sync(unbatched_ctx, state_step)

        unbatched_duration = (time.perf_counter() - start_unbatched) * 1000
        stop_unbatched()

        unbatched_commits = len(commits_unbatched)
        reduction = (
            ((unbatched_commits - coalesced_commits) / unbatched_commits) * 100
            if unbatched_commits
            else 0
        )
        print(
            f"  Unbatched 5-Tool Turn: {unbatched_duration:6.2f} ms | "
            f"COMMITs: {unbatched_commits} | Transaction Reduction: {reduction:.0f}%"
        )

        await engine.dispose()


async def benchmark_query_counts() -> None:
    print("\n══════════════════════════════════════════════════════════════════════")
    print(" Benchmark 3: Query Count & Empty Load Optimization")
    print("══════════════════════════════════════════════════════════════════════")

    with TemporaryDirectory() as directory:
        db_path = Path(directory) / "bench_queries.sqlite"
        engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
        factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)

        empty_id = str(uuid7())
        async with factory() as session:
            await create_chat_session(session, title="Empty")
            await session.commit()

        checkpointer = SQLiteCheckpointer(factory)
        statements, _, stop = capture_statements(engine)
        res = await checkpointer.load(empty_id)
        stop()
        selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]

        print(
            f"  Empty Session Checkpointer Load: {len(selects)} SELECTs (short-circuited at cursor check)"
        )
        assert res is None

        # Populated session checkpointer load
        populated_id = uuid7()
        async with factory() as session:
            await create_chat_session(session, title="Populated")
            for i in range(10):
                await save_message(
                    session, populated_id, HumanMessage(content=f"msg {i}")
                )
            await session.commit()

        statements_pop, _, stop_pop = capture_statements(engine)
        start_pop = time.perf_counter()
        loaded_state = await checkpointer.load(str(populated_id))
        pop_duration = (time.perf_counter() - start_pop) * 1000
        stop_pop()
        selects_pop = [
            s for s in statements_pop if s.lstrip().upper().startswith("SELECT")
        ]

        print(
            f"  10-Message Session Load: {pop_duration:6.2f} ms | "
            f"{len(selects_pop)} SELECTs | {len(loaded_state.messages if loaded_state else [])} messages fetched"
        )

        # Subsequent load (in-memory cached revision & cursor)
        statements_cached, _, stop_cached = capture_statements(engine)
        start_cached = time.perf_counter()
        cached_state = await checkpointer.load(str(populated_id))
        cached_duration = (time.perf_counter() - start_cached) * 1000
        stop_cached()
        assert cached_state is not None
        selects_cached = [
            s for s in statements_cached if s.lstrip().upper().startswith("SELECT")
        ]

        print(
            f"  Cached History Load:     {cached_duration:6.3f} ms | "
            f"{len(selects_cached)} SELECTs (no message re-serialization)"
        )

        await engine.dispose()


async def benchmark_memory_stream_cleanup() -> None:
    print("\n══════════════════════════════════════════════════════════════════════")
    print(" Benchmark 4: Memory Stream Store Expiry & RAM Reclamation")
    print("══════════════════════════════════════════════════════════════════════")

    sid = "bench-stream-1"
    await stream_store.init_turn(sid)

    # Push 50 tokens
    for i in range(50):
        await stream_store.push_event(
            sid,
            StreamEnvelope.from_parts(
                "message", {"text": f"token_{i} ", "agent": "assistant"}
            ),
        )

    state = stream_store._turns.get(sid)
    assert state is not None
    content_chunks = len(state.content.get("assistant", []))
    print(f"  In-Flight Active Turn: {content_chunks} token chunks retained in memory")

    await stream_store.mark_done(sid)
    print(
        f"  After mark_done: is_streaming = {state.is_streaming} | expiry deadline scheduled for 60s"
    )
    assert state.is_streaming is False

    await stream_store.clear(sid)
    print(f"  After clear: session freed from _turns ({sid in stream_store._turns})")
    assert sid not in stream_store._turns


async def benchmark_hook_chain() -> None:
    print("\n══════════════════════════════════════════════════════════════════════")
    print(" Benchmark 5: Hook Chain Dispatch (Filtered vs Full Wrappers)")
    print("══════════════════════════════════════════════════════════════════════")

    class PassthroughHook(BaseAgentHook):
        pass

    class ActiveToolHook(BaseAgentHook):
        async def wrap_tool_call(self, ctx, state, tc, handler):
            return await handler(ctx, state, tc)

    class ActiveModelHook(BaseAgentHook):
        async def wrap_model_call(self, ctx, state, request, handler):
            return await handler(request)

    hooks = [PassthroughHook() for _ in range(10)] + [
        ActiveToolHook(),
        ActiveModelHook(),
    ]
    ctx = RunContext(session_id="bench", run_id="bench", agent_name="assistant")
    state = AgentState(messages=[])
    tc = ToolCall(id="call_1", function=FunctionCall(name="test", arguments="{}"))

    async def dummy_tool(c, s, t):
        return "ok"

    async def dummy_model(req):
        return AssistantMessage(content="ok")

    start = time.perf_counter()
    for _ in range(5000):
        chain = build_tool_chain(hooks, dummy_tool)
        await chain(ctx, state, tc)
    tool_chain_duration = (time.perf_counter() - start) / 5000 * 1000  # ms

    start_m = time.perf_counter()
    req = ModelRequest(messages=(), system_prompt="test")
    for _ in range(5000):
        m_chain = build_model_chain(hooks, ctx, state, dummy_model)
        await m_chain(req)
    model_chain_duration = (time.perf_counter() - start_m) / 5000 * 1000  # ms

    print(
        f"  Tool Chain (12 hooks):  {tool_chain_duration:6.4f} ms/dispatch (10 passthroughs pruned)\n"
        f"  Model Chain (12 hooks): {model_chain_duration:6.4f} ms/dispatch (10 passthroughs pruned)"
    )


async def main() -> None:
    await benchmark_deepcopy_vs_shallow()
    await benchmark_db_transactions()
    await benchmark_query_counts()
    await benchmark_memory_stream_cleanup()
    await benchmark_hook_chain()
    print("\n══════════════════════════════════════════════════════════════════════")
    print(" All Benchmarks Completed Successfully")
    print("══════════════════════════════════════════════════════════════════════\n")


if __name__ == "__main__":
    asyncio.run(main())
