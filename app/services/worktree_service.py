"""Git worktree operations and lifecycle management for coding workspaces."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import subprocess
from typing import Literal
from dataclasses import dataclass
from pathlib import Path

from app.core.config import settings
import app.core.db as db_module
from app.services.coding_workspace_service import (
    mark_coding_workspace_deleted,
    rename_coding_workspace,
    upsert_coding_workspace,
)
from app.services import team_manager

_WORKTREE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")


class WorktreeError(Exception):
    """Base exception for worktree operations."""


class NonGitWorkspaceError(WorktreeError):
    """Raised when a workspace is not a valid git repository."""


class InvalidWorktreeNameError(WorktreeError):
    """Raised when a worktree name format is invalid."""


class InvalidBranchNameError(WorktreeError):
    """Raised when a branch name format is invalid."""


class WorktreePathError(WorktreeError):
    """Raised when a worktree path is invalid or outside allowed roots."""


class WorktreeNameConflictError(WorktreeError):
    """Raised when a unique candidate name cannot be allocated."""


class UnmanagedWorktreeError(WorktreeError):
    """Raised when attempting to operate on an unmanaged worktree."""


class GitCommandError(WorktreeError):
    """Raised when a git command fails."""


@dataclass(slots=True)
class WorktreeInfo:
    name: str
    directory: str
    branch: str | None = None
    managed: bool = False


@dataclass(slots=True)
class WorktreeCreateResult:
    name: str
    directory: str
    branch: str | None
    managed: bool
    source_workspace: str


@dataclass(slots=True)
class MergeResult:
    status: Literal[
        "merged",
        "conflict",
        "dirty_source",
        "dirty_worktree",
        "nothing_to_merge",
        "error",
    ]
    detail: str
    source_branch: str | None = None
    conflicting_paths: list[str] | None = None


async def run_git(
    workspace: Path | str, *args: str
) -> subprocess.CompletedProcess[str]:
    """Execute a git command asynchronously off the event loop."""
    target_dir = Path(workspace)

    def _invoke() -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(target_dir), *args],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )

    try:
        return await asyncio.to_thread(_invoke)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GitCommandError(f"git failed: {exc}") from exc


async def require_git_repo(workspace: Path | str) -> None:
    """Ensure the target workspace is a git repository."""
    result = await run_git(workspace, "rev-parse", "--is-inside-work-tree")
    if result.returncode != 0 or result.stdout.strip() != "true":
        raise NonGitWorkspaceError("Worktrees are only supported for git projects.")


def slugify(value: str) -> str:
    """Convert a human-readable title into a safe slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return slug[:80].strip("-")


def validate_name(value: str | None) -> str:
    """Validate and normalize a worktree name."""
    name = slugify(value or "") or "session"
    if not _WORKTREE_NAME_RE.fullmatch(name):
        raise InvalidWorktreeNameError(
            "Worktree name may only contain letters, numbers, '.', '_' and '-'."
        )
    return name


async def validate_branch(
    source: Path | str, value: str | None, *, name: str, detached: bool
) -> str | None:
    """Validate and format a branch name for a new worktree."""
    if detached:
        return None
    branch = value.strip() if value else f"openagentd/{name}"
    if not branch or branch.startswith("-"):
        raise InvalidBranchNameError("Invalid branch name.")
    result = await run_git(source, "check-ref-format", "--branch", branch)
    if result.returncode != 0:
        raise InvalidBranchNameError("Invalid branch name.")
    return branch


def worktree_root(source: Path | str, *, create: bool = True) -> Path:
    """Return the managed root directory for worktrees of the given source repo."""
    source_path = Path(source)
    key = hashlib.sha1(str(source_path).encode("utf-8")).hexdigest()[:10]
    root = (
        Path(settings.OPENAGENTD_DATA_DIR) / "worktrees" / f"{source_path.name}-{key}"
    )
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def managed_root(source: Path | str, *, create: bool = True) -> Path:
    """Alias for worktree_root."""
    return worktree_root(source, create=create)


async def candidate(source: Path | str, name: str, branch: str | None) -> WorktreeInfo:
    """Find an available candidate directory and branch name for a new worktree."""
    source_path = Path(source)
    root = worktree_root(source_path)
    for attempt in range(27):
        suffix = "" if attempt == 0 else f"-{attempt}"
        candidate_name = f"{name}{suffix}"
        directory = (root / candidate_name).resolve()
        if directory.parent != root:
            raise WorktreePathError("Invalid worktree path.")
        if directory.exists():
            continue
        candidate_branch = f"{branch}{suffix}" if branch and attempt > 0 else branch
        if candidate_branch:
            result = await run_git(
                source_path,
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
    raise WorktreeNameConflictError("Failed to generate a unique worktree name.")


def parse_worktree_list(text: str) -> list[dict[str, str]]:
    """Parse porcelain output from `git worktree list --porcelain`."""
    entries: list[dict[str, str]] = []
    for line in text.splitlines():
        if line.startswith("worktree "):
            entries.append({"directory": line.removeprefix("worktree ").strip()})
        elif line.startswith("branch ") and entries:
            entries[-1]["branch"] = (
                line.removeprefix("branch ").strip().removeprefix("refs/heads/")
            )
    return entries


async def list_worktree_entries(source: Path | str) -> list[dict[str, str]]:
    """List all worktrees registered with git for the source repository."""
    result = await run_git(source, "worktree", "list", "--porcelain")
    if result.returncode != 0:
        detail = (
            result.stderr.strip()
            or result.stdout.strip()
            or "Failed to read git worktrees."
        )
        raise GitCommandError(detail)
    return parse_worktree_list(result.stdout)


def canonical(path: str | Path) -> str:
    """Resolve canonical real path."""
    return os.path.realpath(Path(path).expanduser().resolve())


async def entry_for_directory(
    source: Path | str, directory: Path | str
) -> dict[str, str] | None:
    """Find the worktree entry matching a target directory."""
    target = canonical(directory)
    for entry in await list_worktree_entries(source):
        entry_dir = entry.get("directory")
        if entry_dir and canonical(entry_dir) == target:
            return entry
    return None


async def find_managed_worktree_source(directory: Path | str) -> str | None:
    """Verify if directory is an OpenAgentd-managed worktree and return its source repo path."""
    resolved = Path(directory).expanduser().resolve()
    data_root = (Path(settings.OPENAGENTD_DATA_DIR) / "worktrees").resolve()
    if data_root not in resolved.parents:
        return None
    result = await run_git(resolved, "rev-parse", "--show-toplevel")
    if result.returncode != 0 or Path(result.stdout.strip()).resolve() != resolved:
        return None
    common_dir = await run_git(
        resolved, "rev-parse", "--path-format=absolute", "--git-common-dir"
    )
    if common_dir.returncode != 0:
        return None
    common_path = Path(common_dir.stdout.strip()).resolve()
    source = common_path.parent if common_path.name == ".git" else common_path
    if source == resolved:
        return None
    expected_root = worktree_root(source, create=False)
    if expected_root not in resolved.parents:
        return None
    return str(source)


async def current_managed_worktree_branch(directory: Path | str) -> str | None:
    """Return the checked-out branch for a validated managed worktree."""
    if await find_managed_worktree_source(directory) is None:
        return None
    result = await run_git(directory, "symbolic-ref", "--quiet", "--short", "HEAD")
    return result.stdout.strip() if result.returncode == 0 else None


async def source_repository(workspace: Path | str) -> Path:
    """Resolve a primary checkout or linked worktree to its source repository."""
    await require_git_repo(workspace)
    common_dir = await run_git(
        workspace, "rev-parse", "--path-format=absolute", "--git-common-dir"
    )
    if common_dir.returncode != 0:
        raise GitCommandError("Failed to determine the source repository.")
    common_path = Path(common_dir.stdout.strip()).resolve()
    return common_path.parent if common_path.name == ".git" else common_path


async def list_worktrees(source_workspace: str | Path) -> list[WorktreeInfo]:
    """List non-primary worktrees for the source repository."""
    source = Path(team_manager.validate_workspace(str(source_workspace)))
    await require_git_repo(source)

    source_real = os.path.realpath(source)
    root = managed_root(source)
    infos: list[WorktreeInfo] = []
    for entry in await list_worktree_entries(source):
        directory = entry.get("directory")
        if not directory or os.path.realpath(directory) == source_real:
            continue
        resolved = Path(directory).resolve()
        infos.append(
            WorktreeInfo(
                name=resolved.name,
                directory=str(resolved),
                branch=entry.get("branch"),
                managed=root in resolved.parents,
            )
        )
    return infos


async def create_worktree(
    *,
    source_workspace: str | Path,
    name: str | None = None,
    branch: str | None = None,
    detached: bool = False,
    db_factory: db_module.DbFactory | None = None,
) -> WorktreeCreateResult:
    """Create an OpenAgentd-managed worktree and register it in the database."""
    workspace = Path(team_manager.validate_workspace(str(source_workspace)))
    source = await source_repository(workspace)

    valid_name = validate_name(name)
    valid_branch = await validate_branch(
        source, branch, name=valid_name, detached=detached
    )
    info = await candidate(source, valid_name, valid_branch)

    args = ["worktree", "add", "--no-checkout"]
    if info.branch:
        args.extend(["-b", info.branch, info.directory])
    else:
        args.extend(["--detach", info.directory, "HEAD"])
    created = await run_git(source, *args)
    if created.returncode != 0:
        detail = (
            created.stderr.strip()
            or created.stdout.strip()
            or "Failed to create git worktree."
        )
        raise GitCommandError(detail)

    populated = await run_git(Path(info.directory), "reset", "--hard")
    if populated.returncode != 0:
        await run_git(source, "worktree", "remove", "--force", info.directory)
        if info.branch:
            await run_git(source, "branch", "-D", info.branch)
        detail = (
            populated.stderr.strip()
            or populated.stdout.strip()
            or "Failed to populate worktree."
        )
        raise GitCommandError(detail)

    db_maker = db_factory or db_module.async_session_factory
    async with db_maker() as db:
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

    return WorktreeCreateResult(
        name=info.name,
        directory=info.directory,
        branch=info.branch,
        managed=True,
        source_workspace=str(source),
    )


async def remove_worktree(
    source_workspace: str | Path,
    directory: str | Path,
    db_factory: db_module.DbFactory | None = None,
    *,
    delete_branch: bool = False,
) -> bool:
    """Remove an OpenAgentd-managed worktree and the branch created for it."""
    workspace = Path(team_manager.validate_workspace(str(source_workspace)))
    source = await source_repository(workspace)

    target_dir = Path(directory).expanduser().resolve()
    root = managed_root(source)
    if root not in target_dir.parents:
        raise UnmanagedWorktreeError(
            "Only OpenAgentd-managed worktrees can be removed."
        )

    entry = await entry_for_directory(source, target_dir)
    db_maker = db_factory or db_module.async_session_factory
    if entry is None:
        async with db_maker() as db:
            async with db.begin():
                await mark_coding_workspace_deleted(db, str(target_dir))
        return True

    removed = await run_git(source, "worktree", "remove", "--force", str(target_dir))
    if removed.returncode != 0:
        detail = (
            removed.stderr.strip()
            or removed.stdout.strip()
            or "Failed to remove git worktree."
        )
        raise GitCommandError(detail)

    branch = entry.get("branch")
    if branch and (branch.startswith("openagentd/") or delete_branch):
        await run_git(source, "branch", "-D", branch)

    async with db_maker() as db:
        async with db.begin():
            await mark_coding_workspace_deleted(db, str(target_dir))
    return True


async def rename_worktree(
    directory: str | Path,
    name: str,
    db_factory: db_module.DbFactory | None = None,
) -> WorktreeInfo:
    """Rename a worktree entry in the database."""
    target_dir = Path(directory).expanduser().resolve()
    clean_name = name.strip()
    if not clean_name:
        raise InvalidWorktreeNameError("Worktree title is required.")

    db_maker = db_factory or db_module.async_session_factory
    async with db_maker() as db:
        async with db.begin():
            row = await rename_coding_workspace(db, str(target_dir), clean_name)
    return WorktreeInfo(
        name=row.name or target_dir.name,
        directory=row.path,
        managed=row.managed,
    )


async def merge_worktree_to_source(
    *,
    worktree: str | Path,
    delete_on_success: bool = True,
    db_factory: db_module.DbFactory | None = None,
) -> MergeResult:
    """Merge a managed worktree's branch back into its source repository."""
    worktree_path = Path(worktree).expanduser().resolve()
    source = await find_managed_worktree_source(worktree_path)
    if not source:
        return MergeResult(
            status="error",
            detail="Not an OpenAgentd-managed worktree directory.",
        )

    source_path = Path(source)

    # 1. Check dirty worktree
    wt_status = await run_git(worktree_path, "status", "--porcelain")
    if wt_status.returncode != 0:
        return MergeResult(
            status="error", detail=f"Git status failed in worktree: {wt_status.stderr}"
        )
    if wt_status.stdout.strip():
        return MergeResult(
            status="dirty_worktree",
            detail="Worktree has uncommitted changes. Please commit or stash them before merging.",
        )

    # 2. Check dirty source
    src_status = await run_git(source_path, "status", "--porcelain")
    if src_status.returncode != 0:
        return MergeResult(
            status="error", detail=f"Git status failed in source: {src_status.stderr}"
        )
    if src_status.stdout.strip():
        return MergeResult(
            status="dirty_source",
            detail="Source repository has uncommitted changes. Please stash or commit them in the main workspace first.",
        )

    # 3. Check branches
    wt_branch_res = await run_git(worktree_path, "rev-parse", "--abbrev-ref", "HEAD")
    src_branch_res = await run_git(source_path, "rev-parse", "--abbrev-ref", "HEAD")
    if wt_branch_res.returncode != 0 or src_branch_res.returncode != 0:
        return MergeResult(status="error", detail="Failed to determine git branches.")
    wt_branch = wt_branch_res.stdout.strip()
    src_branch = src_branch_res.stdout.strip()
    if wt_branch == "HEAD":
        return MergeResult(
            status="error",
            detail="Detached worktrees cannot be merged automatically.",
            source_branch=src_branch,
        )

    mb_res = await run_git(source_path, "merge-base", src_branch, wt_branch)
    wt_rev_res = await run_git(source_path, "rev-parse", wt_branch)
    if mb_res.returncode != 0 or wt_rev_res.returncode != 0:
        return MergeResult(status="error", detail="Failed to calculate merge-base.")
    if mb_res.stdout.strip() == wt_rev_res.stdout.strip():
        return MergeResult(
            status="nothing_to_merge",
            detail="No new commits to merge.",
            source_branch=src_branch,
        )

    # 4. Perform merge in source repository
    merge_res = await run_git(source_path, "merge", "--no-ff", wt_branch)
    if merge_res.returncode != 0:
        await run_git(source_path, "merge", "--abort")
        conflicting_paths = [
            line.strip()
            for line in (merge_res.stdout + "\n" + merge_res.stderr).splitlines()
            if "CONFLICT" in line
        ]
        return MergeResult(
            status="conflict",
            detail="Merge conflict detected. Merge was cleanly aborted; no changes were applied to the main workspace.",
            source_branch=src_branch,
            conflicting_paths=conflicting_paths or None,
        )

    if delete_on_success:
        try:
            await remove_worktree(
                source_workspace=source_path,
                directory=worktree_path,
                db_factory=db_factory,
                delete_branch=True,
            )
        except WorktreeError as exc:
            return MergeResult(
                status="merged",
                detail=(
                    f"Successfully merged branch '{wt_branch}' into '{src_branch}', "
                    f"but worktree cleanup failed: {exc}"
                ),
                source_branch=src_branch,
            )

    return MergeResult(
        status="merged",
        detail=f"Successfully merged branch '{wt_branch}' into '{src_branch}'.",
        source_branch=src_branch,
    )
