"""Git worktree endpoints for coding workspaces."""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
import app.core.db as db_module
from app.services.coding_workspace_service import (
    mark_coding_workspace_deleted,
    rename_coding_workspace,
    upsert_coding_workspace,
)
from app.services import team_manager

router = APIRouter()

_WORKTREE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


class WorktreeRemoveRequest(BaseModel):
    source_workspace: str = Field(
        description="Primary git repository that owns the worktree."
    )
    directory: str = Field(description="Worktree directory to remove.")


class WorktreeRenameRequest(BaseModel):
    directory: str = Field(description="Worktree directory to rename in the sidebar.")
    name: str = Field(min_length=1, max_length=255)


class WorktreeCreateRequest(BaseModel):
    source_workspace: str = Field(
        description="Existing git repository to create the worktree from."
    )
    name: str | None = Field(
        default=None,
        max_length=80,
        description="Optional worktree name. Defaults to a generated name.",
    )
    branch: str | None = Field(
        default=None,
        max_length=255,
        description="Optional branch name. Defaults to openagentd/<name>.",
    )
    detached: bool = Field(
        default=False,
        description="Create a detached worktree at HEAD instead of creating a branch.",
    )


class WorktreeInfo(BaseModel):
    name: str
    directory: str
    branch: str | None = None
    managed: bool = False


class WorktreeCreateResponse(WorktreeInfo):
    source_workspace: str


def _run_git(workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", "-C", str(workspace), *args],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=500, detail=f"git failed: {exc}") from exc


def _require_git_repo(workspace: Path) -> None:
    result = _run_git(workspace, "rev-parse", "--is-inside-work-tree")
    if result.returncode != 0 or result.stdout.strip() != "true":
        raise HTTPException(
            status_code=422, detail="Worktrees are only supported for git projects."
        )


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug[:80].strip("-")


def _validate_name(value: str | None) -> str:
    name = _slugify(value or "") or "session"
    if not _WORKTREE_NAME_RE.fullmatch(name):
        raise HTTPException(
            status_code=422,
            detail="Worktree name may only contain letters, numbers, '.', '_' and '-'.",
        )
    return name


def _validate_branch(
    source: Path, value: str | None, *, name: str, detached: bool
) -> str | None:
    if detached:
        return None
    branch = value.strip() if value else f"openagentd/{name}"
    if not branch or branch.startswith("-"):
        raise HTTPException(status_code=422, detail="Invalid branch name.")
    result = _run_git(source, "check-ref-format", "--branch", branch)
    if result.returncode != 0:
        raise HTTPException(status_code=422, detail="Invalid branch name.")
    return branch


def _worktree_root(source: Path, *, create: bool = True) -> Path:
    key = hashlib.sha1(str(source).encode("utf-8")).hexdigest()[:10]
    root = Path(settings.OPENAGENTD_DATA_DIR) / "worktrees" / f"{source.name}-{key}"
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _candidate(source: Path, name: str, branch: str | None) -> WorktreeInfo:
    root = _worktree_root(source)
    for attempt in range(27):
        suffix = "" if attempt == 0 else f"-{attempt}"
        candidate_name = f"{name}{suffix}"
        directory = (root / candidate_name).resolve()
        if directory.parent != root:
            raise HTTPException(status_code=422, detail="Invalid worktree path.")
        if directory.exists():
            continue
        candidate_branch = f"{branch}{suffix}" if branch and attempt > 0 else branch
        if candidate_branch:
            result = _run_git(
                source,
                "show-ref",
                "--verify",
                "--quiet",
                f"refs/heads/{candidate_branch}",
            )
            if result.returncode == 0:
                continue
        return WorktreeInfo(
            name=candidate_name,
            directory=str(directory),
            branch=candidate_branch,
            managed=True,
        )
    raise HTTPException(
        status_code=409, detail="Failed to generate a unique worktree name."
    )


def _parse_worktree_list(text: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for line in text.splitlines():
        if line.startswith("worktree "):
            entries.append({"directory": line.removeprefix("worktree ").strip()})
        elif line.startswith("branch ") and entries:
            entries[-1]["branch"] = (
                line.removeprefix("branch ").strip().removeprefix("refs/heads/")
            )
    return entries


def _list_worktree_entries(source: Path) -> list[dict[str, str]]:
    result = _run_git(source, "worktree", "list", "--porcelain")
    if result.returncode != 0:
        detail = (
            result.stderr.strip()
            or result.stdout.strip()
            or "Failed to read git worktrees."
        )
        raise HTTPException(status_code=500, detail=detail)
    return _parse_worktree_list(result.stdout)


def _managed_root(source: Path, *, create: bool = True) -> Path:
    return _worktree_root(source, create=create)


def _canonical(path: str | Path) -> str:
    return os.path.realpath(Path(path).expanduser().resolve())


def _entry_for_directory(source: Path, directory: Path) -> dict[str, str] | None:
    target = _canonical(directory)
    for entry in _list_worktree_entries(source):
        entry_dir = entry.get("directory")
        if entry_dir and _canonical(entry_dir) == target:
            return entry
    return None


def find_managed_worktree_source(directory: Path) -> str | None:
    resolved = directory.expanduser().resolve()
    data_root = (Path(settings.OPENAGENTD_DATA_DIR) / "worktrees").resolve()
    if data_root not in resolved.parents:
        return None
    result = _run_git(resolved, "rev-parse", "--show-toplevel")
    if result.returncode != 0 or Path(result.stdout.strip()).resolve() != resolved:
        return None
    common_dir = _run_git(
        resolved, "rev-parse", "--path-format=absolute", "--git-common-dir"
    )
    if common_dir.returncode != 0:
        return None
    common_path = Path(common_dir.stdout.strip()).resolve()
    source = common_path.parent if common_path.name == ".git" else common_path
    if source == resolved:
        return None
    expected_root = _worktree_root(source, create=False)
    if expected_root not in resolved.parents:
        return None
    return str(source)


@router.get("/workspace/worktrees", response_model=list[WorktreeInfo])
async def list_coding_workspace_worktrees(source_workspace: str) -> list[WorktreeInfo]:
    try:
        source = Path(team_manager.validate_workspace(source_workspace))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    _require_git_repo(source)

    source_real = os.path.realpath(source)
    managed_root = _managed_root(source)
    infos: list[WorktreeInfo] = []
    for entry in _list_worktree_entries(source):
        directory = entry.get("directory")
        if not directory or os.path.realpath(directory) == source_real:
            continue
        resolved = Path(directory).resolve()
        infos.append(
            WorktreeInfo(
                name=resolved.name,
                directory=str(resolved),
                branch=entry.get("branch"),
                managed=managed_root in resolved.parents,
            )
        )
    return infos


@router.delete("/workspace/worktrees")
async def remove_coding_workspace_worktree(
    body: WorktreeRemoveRequest,
) -> dict[str, bool]:
    try:
        source = Path(team_manager.validate_workspace(body.source_workspace))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    _require_git_repo(source)
    directory = Path(body.directory).expanduser().resolve()
    root = _managed_root(source)
    if root not in directory.parents:
        raise HTTPException(
            status_code=403,
            detail="Only OpenAgentd-managed worktrees can be removed.",
        )
    entry = _entry_for_directory(source, directory)
    if entry is None:
        async with db_module.async_session_factory() as db:
            async with db.begin():
                await mark_coding_workspace_deleted(db, str(directory))
        return {"removed": True}

    removed = _run_git(source, "worktree", "remove", "--force", str(directory))
    if removed.returncode != 0:
        detail = (
            removed.stderr.strip()
            or removed.stdout.strip()
            or "Failed to remove git worktree."
        )
        raise HTTPException(status_code=500, detail=detail)

    branch = entry.get("branch")
    if branch and branch.startswith("openagentd/"):
        _run_git(source, "branch", "-D", branch)
    async with db_module.async_session_factory() as db:
        async with db.begin():
            await mark_coding_workspace_deleted(db, str(directory))
    return {"removed": True}


@router.patch("/workspace/worktrees", response_model=WorktreeInfo)
async def rename_coding_workspace_worktree(
    body: WorktreeRenameRequest,
) -> WorktreeInfo:
    directory = Path(body.directory).expanduser().resolve()
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Worktree title is required.")
    async with db_module.async_session_factory() as db:
        async with db.begin():
            row = await rename_coding_workspace(db, str(directory), name)
    return WorktreeInfo(
        name=row.name or directory.name,
        directory=row.path,
        managed=row.managed,
    )


@router.post("/workspace/worktrees", response_model=WorktreeCreateResponse)
async def create_coding_workspace_worktree(
    body: WorktreeCreateRequest,
) -> WorktreeCreateResponse:
    try:
        source = Path(team_manager.validate_workspace(body.source_workspace))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    _require_git_repo(source)
    name = _validate_name(body.name)
    branch = _validate_branch(source, body.branch, name=name, detached=body.detached)
    info = _candidate(source, name, branch)

    args = ["worktree", "add", "--no-checkout"]
    if info.branch:
        args.extend(["-b", info.branch, info.directory])
    else:
        args.extend(["--detach", info.directory, "HEAD"])
    created = _run_git(source, *args)
    if created.returncode != 0:
        detail = (
            created.stderr.strip()
            or created.stdout.strip()
            or "Failed to create git worktree."
        )
        raise HTTPException(status_code=500, detail=detail)

    populated = _run_git(Path(info.directory), "reset", "--hard")
    if populated.returncode != 0:
        _run_git(source, "worktree", "remove", "--force", info.directory)
        if info.branch:
            _run_git(source, "branch", "-D", info.branch)
        detail = (
            populated.stderr.strip()
            or populated.stdout.strip()
            or "Failed to populate worktree."
        )
        raise HTTPException(status_code=500, detail=detail)

    async with db_module.async_session_factory() as db:
        async with db.begin():
            await upsert_coding_workspace(
                db, path=str(source), kind="repo", hidden=False
            )
            await upsert_coding_workspace(
                db,
                path=info.directory,
                kind="worktree",
                source_path=str(source),
                name=info.name,
                managed=True,
                hidden=False,
            )

    return WorktreeCreateResponse(
        name=info.name,
        directory=info.directory,
        branch=info.branch,
        managed=True,
        source_workspace=str(source),
    )
