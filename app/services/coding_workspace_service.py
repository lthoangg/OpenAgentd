from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.models.chat import CodingWorkspace


async def upsert_coding_workspace(
    db: AsyncSession,
    *,
    path: str,
    kind: str = "repo",
    source_path: str | None = None,
    name: str | None = None,
    managed: bool = False,
    hidden: bool = False,
    deleted_at: datetime | None = None,
) -> CodingWorkspace:
    resolved_path = str(Path(path).expanduser().resolve())
    resolved_source = (
        str(Path(source_path).expanduser().resolve()) if source_path else None
    )
    row = (
        await db.exec(
            select(CodingWorkspace).where(CodingWorkspace.path == resolved_path)
        )
    ).first()
    if row is None:
        row = CodingWorkspace(path=resolved_path)
    preserve_worktree = (
        row.kind == "worktree" and kind == "repo" and resolved_source is None
    )
    if not preserve_worktree:
        row.kind = kind
        row.source_path = resolved_source
        row.name = name or Path(resolved_path).name
        row.managed = managed
    elif name:
        row.name = name
    row.hidden = hidden
    row.deleted_at = deleted_at
    db.add(row)
    await db.flush()
    await db.refresh(row)
    return row


async def hide_coding_workspace(db: AsyncSession, path: str) -> int:
    resolved_path = str(Path(path).expanduser().resolve())
    rows = list(
        (
            await db.exec(
                select(CodingWorkspace).where(CodingWorkspace.path == resolved_path)
            )
        ).all()
    )
    if not rows:
        row = CodingWorkspace(
            path=resolved_path, name=Path(resolved_path).name, hidden=True
        )
        db.add(row)
        await db.flush()
        return 1
    for row in rows:
        row.hidden = True
        db.add(row)
    return len(rows)


async def mark_coding_workspace_deleted(db: AsyncSession, path: str) -> int:
    resolved_path = str(Path(path).expanduser().resolve())
    deleted_at = datetime.now(timezone.utc)
    rows = list(
        (
            await db.exec(
                select(CodingWorkspace).where(CodingWorkspace.path == resolved_path)
            )
        ).all()
    )
    if not rows:
        row = CodingWorkspace(
            path=resolved_path,
            kind="worktree",
            name=Path(resolved_path).name,
            hidden=True,
            deleted_at=deleted_at,
        )
        db.add(row)
        await db.flush()
        return 1
    for row in rows:
        row.hidden = True
        row.deleted_at = deleted_at
        db.add(row)
    return len(rows)


async def rename_coding_workspace(
    db: AsyncSession, path: str, name: str
) -> CodingWorkspace:
    resolved_path = str(Path(path).expanduser().resolve())
    row = (
        await db.exec(
            select(CodingWorkspace).where(CodingWorkspace.path == resolved_path)
        )
    ).first()
    if row is None:
        row = CodingWorkspace(
            path=resolved_path,
            kind="worktree",
            name=name,
        )
    else:
        row.name = name
    db.add(row)
    await db.flush()
    await db.refresh(row)
    return row


async def list_visible_coding_workspaces(db: AsyncSession) -> list[CodingWorkspace]:
    return list(
        (
            await db.exec(
                select(CodingWorkspace)
                .where(
                    ~col(CodingWorkspace.hidden),
                    col(CodingWorkspace.deleted_at).is_(None),
                )
                .order_by(col(CodingWorkspace.created_at).asc())
            )
        ).all()
    )


async def seed_workspace_registry_from_sessions(
    db: AsyncSession, workspaces: list[str]
) -> None:
    for workspace in workspaces:
        await upsert_coding_workspace(db, path=workspace, kind="repo", hidden=False)
