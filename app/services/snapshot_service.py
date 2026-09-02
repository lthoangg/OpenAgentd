"""Out-of-tree Git-based workspace snapshots for session undo/redo."""

from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger

from app.core.config import settings


@dataclass(slots=True)
class RestoreResult:
    """Outcome of a :func:`restore` call."""

    ok: bool
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)

    @property
    def changed_paths(self) -> list[str]:
        """Flat union of every path the restore touched."""
        return [*self.added, *self.modified, *self.removed]


_MAX_FILE_SIZE = 2 * 1024 * 1024

_CORE_FLAGS: tuple[str, ...] = (
    "--no-optional-locks",
    "-c",
    "core.longpaths=true",
    "-c",
    "core.symlinks=true",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotepath=false",
)

_locks: dict[str, asyncio.Lock] = {}
_last_hashes: dict[tuple[str, Path], str] = {}
_track_counts: dict[str, int] = {}
_MAINTENANCE_INTERVAL = 16


def _lock(session_id: str) -> asyncio.Lock:
    lock = _locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[session_id] = lock
    return lock


def snapshot_dir(session_id: str) -> Path:
    """Return the on-disk ``GIT_DIR`` for this session's snapshot repo."""
    return Path(settings.OPENAGENTD_STATE_DIR) / "snapshot" / session_id


def is_available() -> bool:
    """Return True when the ``git`` binary is on PATH."""
    return shutil.which("git") is not None


async def _git(
    *args: str,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    stdin: bytes | None = None,
) -> tuple[int, bytes, bytes]:
    """Run ``git`` and return ``(exit_code, stdout, stderr)``.

    Never raises — all failures are surfaced as a non-zero exit code so the
    caller can decide whether to warn or recover.
    """
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    try:
        proc = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=str(cwd) if cwd else None,
            env=merged_env,
            stdin=asyncio.subprocess.PIPE if stdin is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(stdin)
        return proc.returncode or 0, out, err
    except (OSError, asyncio.CancelledError) as exc:
        logger.warning("snapshot_git_spawn_failed args={} error={}", args, exc)
        return 1, b"", str(exc).encode()


def _gitdir_args(gitdir: Path, worktree: Path) -> list[str]:
    """Standard ``--git-dir / --work-tree`` prefix for ``_git`` calls."""
    return ["--git-dir", str(gitdir), "--work-tree", str(worktree)]


async def _maintain_repo(gitdir: Path, worktree: Path) -> None:
    """Pack snapshot objects and prune unreachable intermediate trees."""
    await _git(
        "--git-dir",
        str(gitdir),
        "gc",
        "--auto",
        "--prune=now",
        cwd=worktree,
    )


async def _init_repo(gitdir: Path, worktree: Path) -> bool:
    """Initialise the out-of-tree git repo if needed. Idempotent."""
    gitdir.mkdir(parents=True, exist_ok=True)
    head_file = gitdir / "HEAD"
    if head_file.exists():
        return True

    code, _, err = await _git(
        "init",
        env={"GIT_DIR": str(gitdir), "GIT_WORK_TREE": str(worktree)},
    )
    if code != 0:
        logger.warning(
            "snapshot_init_failed gitdir={} stderr={}",
            gitdir,
            err.decode(errors="replace"),
        )
        return False

    for key, value in (
        ("core.autocrlf", "false"),
        ("core.longpaths", "true"),
        ("core.symlinks", "true"),
        ("core.fsmonitor", "false"),
        ("user.email", "snapshot@openagentd.local"),
        ("user.name", "openagentd-snapshot"),
    ):
        await _git("--git-dir", str(gitdir), "config", key, value)

    logger.info("snapshot_initialised session_gitdir={}", gitdir)
    return True


async def _list_candidate_paths(gitdir: Path, worktree: Path) -> list[str]:
    """Return ``worktree``-relative paths to stage: modified + untracked."""
    args = _gitdir_args(gitdir, worktree)

    tracked_task = _git(
        *_CORE_FLAGS,
        *args,
        "diff-files",
        "--name-only",
        "-z",
        "--",
        ".",
        cwd=worktree,
    )
    untracked_task = _git(
        *_CORE_FLAGS,
        *args,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
        cwd=worktree,
    )
    (code_d, out_d, _), (code_o, out_o, _) = await asyncio.gather(
        tracked_task, untracked_task
    )

    if code_d != 0 or code_o != 0:
        return []

    tracked = [p for p in out_d.decode(errors="replace").split("\0") if p]
    untracked = [p for p in out_o.decode(errors="replace").split("\0") if p]

    def _filter() -> list[str]:
        # One stat per untracked file. A workspace with a large ignored-less
        # build tree can have thousands, so this walk stays off the loop.
        seen: set[str] = set()
        result: list[str] = []
        untracked_set = set(untracked)
        for path in (*tracked, *untracked):
            if path in seen:
                continue
            seen.add(path)
            if path in untracked_set:
                try:
                    size = (worktree / path).stat().st_size
                except OSError:
                    continue
                if size > _MAX_FILE_SIZE:
                    continue
            result.append(path)
        return result

    if not untracked:
        return list(dict.fromkeys(tracked))
    return await asyncio.to_thread(_filter)


async def _stage(gitdir: Path, worktree: Path, paths: list[str]) -> bool:
    """Stage the given worktree-relative paths into the snapshot index."""
    if not paths:
        return True
    stdin = ("\0".join(paths) + "\0").encode()
    code, _, err = await _git(
        *_CORE_FLAGS,
        *_gitdir_args(gitdir, worktree),
        "add",
        "--all",
        "--sparse",
        "--pathspec-from-file=-",
        "--pathspec-file-nul",
        cwd=worktree,
        stdin=stdin,
    )
    if code != 0:
        logger.warning("snapshot_stage_failed stderr={}", err.decode(errors="replace"))
        return False
    return True


async def track(session_id: str, workspace: Path) -> str | None:
    """Snapshot the workspace state and return its tree hash.

    Returns ``None`` when git is unavailable, the workspace does not exist,
    or any git invocation fails. Safe to call concurrently — locked
    per-session.
    """
    if not is_available():
        return None
    if not workspace.exists() or not workspace.is_dir():
        return None

    gitdir = snapshot_dir(session_id)
    cache_key = (session_id, workspace.resolve())
    async with _lock(session_id):
        if not await _init_repo(gitdir, workspace):
            return None

        paths = await _list_candidate_paths(gitdir, workspace)
        if paths:
            await _stage(gitdir, workspace, paths)
        elif snapshot_hash := _last_hashes.get(cache_key):
            return snapshot_hash

        code, out, err = await _git(
            *_CORE_FLAGS,
            *_gitdir_args(gitdir, workspace),
            "write-tree",
            cwd=workspace,
        )
        if code != 0:
            logger.warning(
                "snapshot_write_tree_failed session_id={} stderr={}",
                session_id,
                err.decode(errors="replace"),
            )
            return None
        snapshot_hash = out.decode().strip()
        if not snapshot_hash:
            return None
        _last_hashes[cache_key] = snapshot_hash
        _track_counts[session_id] = _track_counts.get(session_id, 0) + 1
        if _track_counts[session_id] % _MAINTENANCE_INTERVAL == 0:
            await _maintain_repo(gitdir, workspace)
        logger.debug(
            "snapshot_tracked session_id={} hash={}",
            session_id,
            snapshot_hash,
        )
        return snapshot_hash


async def restore(
    session_id: str,
    workspace: Path,
    snapshot: str,
    *,
    skip_stage: bool = False,
) -> RestoreResult:
    """Restore the workspace to the given snapshot tree hash."""
    if not is_available():
        return RestoreResult(ok=False)
    if not snapshot:
        return RestoreResult(ok=False)

    gitdir = snapshot_dir(session_id)
    if not (gitdir / "HEAD").exists():
        logger.warning(
            "snapshot_restore_no_repo session_id={} hash={}", session_id, snapshot
        )
        return RestoreResult(ok=False)

    workspace.mkdir(parents=True, exist_ok=True)
    async with _lock(session_id):
        if not skip_stage:
            live_paths = await _list_candidate_paths(gitdir, workspace)
            if live_paths:
                await _stage(gitdir, workspace, live_paths)

        diff_code, diff_out, _ = await _git(
            *_CORE_FLAGS,
            *_gitdir_args(gitdir, workspace),
            "diff-index",
            "-R",
            "--cached",
            "--name-status",
            "-r",
            "-z",
            "--no-renames",
            snapshot,
            cwd=workspace,
        )
        if diff_code != 0:
            logger.warning(
                "snapshot_diff_index_failed session_id={} hash={}",
                session_id,
                snapshot,
            )
            return RestoreResult(ok=False)

        added: list[str] = []
        modified: list[str] = []
        to_delete: list[str] = []
        parts = diff_out.decode(errors="replace").split("\0")
        i = 0
        while i + 1 < len(parts):
            status = parts[i]
            path = parts[i + 1]
            i += 2
            if not status or not path:
                continue
            first = status[0]
            if first == "A":
                added.append(path)
            elif first in ("M", "T"):
                modified.append(path)
            elif first == "D":
                to_delete.append(path)
        to_checkout: list[str] = [*added, *modified]

        if to_checkout:
            temp_index = gitdir / f"restore-{os.getpid()}-{snapshot[:8]}.idx"
            temp_env = {"GIT_INDEX_FILE": str(temp_index)}
            try:
                code, _, err = await _git(
                    *_CORE_FLAGS,
                    *_gitdir_args(gitdir, workspace),
                    "read-tree",
                    snapshot,
                    cwd=workspace,
                    env=temp_env,
                )
                if code != 0:
                    logger.warning(
                        "snapshot_read_tree_failed session_id={} hash={} stderr={}",
                        session_id,
                        snapshot,
                        err.decode(errors="replace"),
                    )
                    return RestoreResult(ok=False)

                stdin = ("\0".join(to_checkout) + "\0").encode()
                code, _, err = await _git(
                    *_CORE_FLAGS,
                    *_gitdir_args(gitdir, workspace),
                    "checkout-index",
                    "-f",
                    "-z",
                    "--stdin",
                    cwd=workspace,
                    env=temp_env,
                    stdin=stdin,
                )
                if code != 0:
                    logger.warning(
                        "snapshot_checkout_failed session_id={} hash={} stderr={} count={}",
                        session_id,
                        snapshot,
                        err.decode(errors="replace"),
                        len(to_checkout),
                    )
                    return RestoreResult(ok=False)
            finally:
                try:
                    temp_index.unlink()
                except FileNotFoundError:
                    pass

        _delete_extras(workspace, set(to_delete))

        logger.debug(
            "snapshot_restored session_id={} hash={} checkout={} extras={}",
            session_id,
            snapshot,
            len(to_checkout),
            len(to_delete),
        )
        return RestoreResult(
            ok=True,
            added=added,
            modified=modified,
            removed=to_delete,
        )


def _delete_extras(workspace: Path, extras: set[str]) -> None:
    """Unlink files in ``extras`` and drop any now-empty directories."""
    workspace_root = workspace.resolve()
    parent_dirs: set[Path] = set()
    for rel in extras:
        relative_path = Path(rel)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            continue
        target = workspace_root / relative_path
        if not target.parent.resolve().is_relative_to(workspace_root):
            continue
        try:
            target.unlink()
        except OSError as exc:
            logger.debug("snapshot_extra_unlink_failed path={} error={}", target, exc)
        parent = target.parent
        while parent != workspace_root:
            parent_dirs.add(parent)
            parent = parent.parent
    for dirpath in sorted(parent_dirs, key=lambda path: len(path.parts), reverse=True):
        try:
            dirpath.rmdir()
        except OSError:
            continue


async def remove(session_id: str) -> None:
    """Delete the snapshot repo for this session.

    Called when a session is permanently deleted. Best-effort — ignores
    missing directories and surface-level OS errors.
    """
    gitdir = snapshot_dir(session_id)
    async with _lock(session_id):
        try:
            if gitdir.exists():
                await asyncio.to_thread(shutil.rmtree, gitdir, ignore_errors=True)
        finally:
            for cache_key in tuple(_last_hashes):
                if cache_key[0] == session_id:
                    del _last_hashes[cache_key]
            _track_counts.pop(session_id, None)
    _locks.pop(session_id, None)
