"""Deterministic SQLite query-count scenarios for hot persistence paths.

Run with: uv run python tests/manual/performance_scenarios.py
"""

from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable
from pathlib import Path
from tempfile import TemporaryDirectory

from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlmodel import SQLModel, col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import CodingWorkspace
from app.scheduler.models import ScheduledTask
from app.scheduler.scheduler import TaskScheduler
from app.services.coding_workspace_service import (
    hide_coding_workspace,
    mark_coding_workspace_deleted,
)

PASS = "✅ PASS"
FAIL = "❌ FAIL"
results: list[tuple[str, str]] = []


def check(label: str, got: object, expected: object) -> None:
    ok = got == expected
    results.append((PASS if ok else FAIL, label))
    print(f"  {PASS if ok else FAIL}  {label}")
    if not ok:
        print(f"       got:      {got!r}")
        print(f"       expected: {expected!r}")


def capture_statements(engine) -> tuple[list[str], Callable[[], None]]:
    statements: list[str] = []

    def record(_conn, _cursor, statement, _parameters, _context, _executemany):
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)

    def stop() -> None:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    return statements, stop


async def run() -> None:
    with TemporaryDirectory() as directory:
        engine = create_async_engine(
            f"sqlite+aiosqlite:///{Path(directory) / 'db.sqlite'}"
        )
        factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        async with engine.begin() as connection:
            await connection.run_sync(SQLModel.metadata.create_all)

        print("\n── A: enabled-task existence uses one bounded query ──")
        async with factory() as session:
            session.add_all(
                [
                    ScheduledTask(
                        slug=f"task-{index}",
                        name=f"Task {index}",
                        schedule_type="every",
                        every_seconds=60,
                        prompt="check",
                    )
                    for index in range(64)
                ]
            )
            await session.commit()

        scheduler = TaskScheduler(factory)
        statements, stop = capture_statements(engine)
        try:
            has_enabled = await scheduler.has_enabled_tasks()
        finally:
            stop()
        selects = [
            statement
            for statement in statements
            if statement.lstrip().upper().startswith("SELECT")
        ]
        check("A1: enabled task is found", has_enabled, True)
        check("A2: existence check issues one SELECT", len(selects), 1)
        check("A3: existence SELECT is bounded", "LIMIT" in selects[0].upper(), True)

        print("\n── B: unique-path hide updates one row without loading it ──")
        target_path = str((Path(directory) / "target").resolve())
        async with factory() as session:
            session.add_all(
                [
                    CodingWorkspace(path=str(Path(directory) / f"workspace-{index}"))
                    for index in range(64)
                ]
                + [CodingWorkspace(path=target_path)]
            )
            await session.commit()

        async with factory() as session:
            statements, stop = capture_statements(engine)
            try:
                changed = await hide_coding_workspace(session, target_path)
                await session.flush()
            finally:
                stop()
            check("B1: exactly one unique path is hidden", changed, 1)
            check("B2: hiding uses one statement", len(statements), 1)
            check(
                "B3: hiding does not load workspace rows",
                statements[0].lstrip().upper().startswith("UPDATE"),
                True,
            )
            await session.commit()

        print("\n── C: unique-path delete mark updates one row without loading it ──")
        async with factory() as session:
            statements, stop = capture_statements(engine)
            try:
                changed = await mark_coding_workspace_deleted(session, target_path)
                await session.flush()
            finally:
                stop()
            row = (
                await session.exec(
                    select(CodingWorkspace).where(
                        col(CodingWorkspace.path) == target_path
                    )
                )
            ).one()
            check("C1: exactly one unique path is marked deleted", changed, 1)
            check("C2: deleting mark uses one statement", len(statements), 1)
            check(
                "C3: deleting mark does not load workspace rows",
                statements[0].lstrip().upper().startswith("UPDATE"),
                True,
            )
            check(
                "C4: deletion state is persisted",
                (row.hidden, row.deleted_at is not None),
                (True, True),
            )

        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(run())
    failed = [result for result in results if result[0] == FAIL]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(bool(failed))
