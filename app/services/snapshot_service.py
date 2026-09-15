"""Out-of-tree Git-based workspace snapshots for session undo/redo."""

from __future__ import annotations

import asyncio
import os
import shutil
from collections.abc import Sequence
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

#: Ref prefix holding one reachability anchor per retained snapshot tree.
_SNAPSHOT_REF_PREFIX = "refs/openagentd/snapshots"

#: Sessions whose snapshot repo has already been offered a seed once.
_seed_attempted: set[str] = set()

#: Size-cap enforcement rounds before giving up on an unsatisfiable cap.
_SIZE_CAP_ROUNDS = 12


def seed_objects_enabled() -> bool:
    """Whether snapshot repos may borrow the workspace repo's object store."""
    raw = os.getenv("SNAPSHOT_SEED_OBJECTS")
    if raw is None:
        return True
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _lock(session_id: str) -> asyncio.Lock:
    lock = _locks.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _locks[session_id] = lock
    return lock


def snapshot_dir(session_id: str) -> Path:
    """Return the on-disk ``GIT_DIR`` for this session's snapshot repo."""
    # Git runs from the workspace, not the process's original working directory.
    return Path(settings.OPENAGENTD_STATE_DIR).resolve() / "snapshot" / session_id


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


def _gitdir_only(gitdir: Path) -> list[str]:
    """``--git-dir`` prefix for commands that never touch the worktree."""
    return ["--git-dir", str(gitdir)]


def _snapshot_ref(tree: str) -> str:
    return f"{_SNAPSHOT_REF_PREFIX}/{tree}"


async def _repack(gitdir: Path) -> None:
    """Delta-compress reachable local objects, borrowing none from alternates.

    ``--local`` keeps the pack to objects this repo owns; without it git would
    copy the borrowed workspace objects into the snapshot repo and undo the
    seeding. Unreachable objects are never intentionally added to a pack, so
    loose snapshots that predate the reachability refs stay where they are.
    """
    code, _, err = await _git(
        *_CORE_FLAGS,
        *_gitdir_only(gitdir),
        "repack",
        "-a",
        "-d",
        "-q",
        "-l",
    )
    if code != 0:
        logger.warning(
            "snapshot_repack_failed gitdir={} stderr={}",
            gitdir,
            err.decode(errors="replace"),
        )


async def _prune_loose(gitdir: Path) -> None:
    """Drop loose objects that neither a ref nor the index reaches anymore."""
    code, _, err = await _git(*_gitdir_only(gitdir), "prune", "--expire=now")
    if code != 0:
        logger.warning(
            "snapshot_prune_failed gitdir={} stderr={}",
            gitdir,
            err.decode(errors="replace"),
        )


async def _clean_temp_packs(gitdir: Path) -> None:
    """Remove pack temporaries a crashed git may have left behind."""
    pack_dir = gitdir / "objects" / "pack"

    def _sweep() -> None:
        for entry in pack_dir.glob("tmp_pack_*"):
            try:
                entry.unlink()
            except OSError:
                continue

    await asyncio.to_thread(_sweep)


async def _maintain_repo(gitdir: Path) -> None:
    """Pack reachable snapshot objects without ever pruning.

    A pre-existing repo keeps its snapshots alive only through the index and
    the message rows, so pruning here would destroy snapshots that predate the
    reachability refs. Reclamation belongs to :func:`prune`, which re-anchors
    every retained snapshot before it runs.
    """
    await _repack(gitdir)
    await _clean_temp_packs(gitdir)


async def _ensure_ref(gitdir: Path, tree: str) -> None:
    """Keep *tree* reachable so repack and prune cannot collect it."""
    if not tree:
        return
    ref = _snapshot_ref(tree)
    code, _, _ = await _git(
        *_gitdir_only(gitdir), "rev-parse", "--verify", "--quiet", ref
    )
    if code == 0:
        return
    code, out, err = await _git(
        *_gitdir_only(gitdir), "commit-tree", tree, "-m", "snapshot"
    )
    if code != 0:
        logger.warning(
            "snapshot_ref_commit_failed gitdir={} tree={} stderr={}",
            gitdir,
            tree,
            err.decode(errors="replace"),
        )
        return
    commit = out.decode(errors="replace").strip()
    if not commit:
        return
    code, _, err = await _git(*_gitdir_only(gitdir), "update-ref", ref, commit)
    if code != 0:
        logger.warning(
            "snapshot_ref_update_failed gitdir={} tree={} stderr={}",
            gitdir,
            tree,
            err.decode(errors="replace"),
        )


async def _list_snapshot_refs(gitdir: Path) -> dict[str, str]:
    """Map each anchored tree hash to the ref name holding it."""
    code, out, _ = await _git(
        *_gitdir_only(gitdir),
        "for-each-ref",
        "--format=%(refname)",
        _SNAPSHOT_REF_PREFIX,
    )
    if code != 0:
        return {}
    refs: dict[str, str] = {}
    for line in out.decode(errors="replace").splitlines():
        name = line.strip()
        tree = name.rsplit("/", 1)[-1]
        if tree:
            refs[tree] = name
    return refs


async def _present_trees(gitdir: Path, trees: Sequence[str]) -> set[str]:
    """Subset of *trees* still resolvable locally or through an alternate."""
    if not trees:
        return set()
    stdin = ("\n".join(trees) + "\n").encode()
    code, out, _ = await _git(
        *_gitdir_only(gitdir),
        "cat-file",
        "--batch-check=%(objectname)",
        stdin=stdin,
    )
    if code != 0:
        # Unresolvable batch: assume every candidate survives, so a transient
        # failure never drops a reachable snapshot.
        return set(trees)
    present: set[str] = set()
    for line in out.decode(errors="replace").splitlines():
        value = line.strip()
        if value and not value.endswith("missing"):
            present.add(value)
    return present


async def _local_size_bytes(gitdir: Path) -> int:
    """Bytes this repo owns (loose objects plus packs; alternates excluded)."""
    code, out, _ = await _git(*_gitdir_only(gitdir), "count-objects", "-v")
    if code != 0:
        return 0
    total_kib = 0
    for line in out.decode(errors="replace").splitlines():
        key, _, value = line.partition(":")
        if key.strip() not in {"size", "size-pack"}:
            continue
        try:
            total_kib += int(value.strip())
        except ValueError:
            continue
    return total_kib * 1024


async def local_size_bytes(session_id: str) -> int:
    """Local object-store bytes for this session's snapshot repo."""
    gitdir = snapshot_dir(session_id)
    if not (gitdir / "HEAD").exists():
        return 0
    return await _local_size_bytes(gitdir)


async def _enforce_size_cap(
    gitdir: Path,
    ordered: list[str],
    max_bytes: int,
    protected: set[str],
) -> list[str]:
    """Drop the oldest unprotected snapshots until the repo fits *max_bytes*."""
    remaining = list(ordered)
    for _ in range(_SIZE_CAP_ROUNDS):
        size = await _local_size_bytes(gitdir)
        if size <= max_bytes:
            return remaining
        droppable = [tree for tree in remaining if tree not in protected]
        if not droppable:
            logger.warning(
                "snapshot_size_cap_exceeded gitdir={} size={} cap={}",
                gitdir,
                size,
                max_bytes,
            )
            return remaining
        per_snapshot = max(1, size // max(1, len(remaining)))
        drop_count = min(len(droppable), max(1, (size - max_bytes) // per_snapshot + 1))
        for tree in droppable[:drop_count]:
            await _git(*_gitdir_only(gitdir), "update-ref", "-d", _snapshot_ref(tree))
            remaining.remove(tree)
        await _repack(gitdir)
        await _prune_loose(gitdir)
    return remaining


async def prune(
    session_id: str,
    keep: Sequence[str],
    *,
    max_bytes: int | None = None,
    protected: Sequence[str] = (),
) -> None:
    """Reclaim snapshot objects the session no longer references.

    Every hash in *keep* is made reachable first, so the repack/prune pass can
    only release objects no retained snapshot needs. With *max_bytes* set, the
    oldest snapshots outside *protected* are dropped until this session's
    local object store fits.
    """
    if not is_available():
        return
    gitdir = snapshot_dir(session_id)
    if not (gitdir / "HEAD").exists():
        return
    candidates = [tree for tree in dict.fromkeys(keep) if tree]
    present = await _present_trees(gitdir, candidates)
    # A snapshot the size cap dropped earlier is gone, not re-provisioned:
    # re-anchoring it every sweep would repack the same data forever.
    ordered = [tree for tree in candidates if tree in present]
    protected_set = {tree for tree in protected if tree}
    async with _lock(session_id):
        existing = await _list_snapshot_refs(gitdir)
        wanted = set(ordered)
        for tree in ordered:
            if tree not in existing:
                await _ensure_ref(gitdir, tree)
        for tree, ref in existing.items():
            if tree not in wanted:
                await _git(*_gitdir_only(gitdir), "update-ref", "-d", ref)
        await _repack(gitdir)
        await _prune_loose(gitdir)
        if max_bytes is not None:
            await _enforce_size_cap(gitdir, ordered, max_bytes, protected_set)
        await _clean_temp_packs(gitdir)


def _read_alternates(objects_dir: Path) -> list[Path]:
    """Alternate object dirs the source repo itself borrows from."""
    try:
        raw = (objects_dir / "info" / "alternates").read_text(errors="replace")
    except OSError:
        return []
    resolved: list[Path] = []
    for line in raw.splitlines():
        entry = line.strip()
        if not entry or entry.startswith("#"):
            continue
        candidate = Path(entry)
        if not candidate.is_absolute():
            candidate = (objects_dir / candidate).resolve()
        resolved.append(candidate)
    return resolved


def _alternate_object_dirs(source_objects: Path) -> list[str]:
    """Absolute object dirs to borrow, following the source's own chain."""
    result: list[str] = []
    for candidate in (source_objects, *_read_alternates(source_objects)):
        if not candidate.is_dir():
            continue
        text = str(candidate)
        if text not in result:
            result.append(text)
    return result


async def _seed_objects(gitdir: Path, worktree: Path, *, copy_index: bool) -> bool:
    """Borrow the workspace repo's already-hashed objects.

    Committed content is content-addressed, so pointing this repo's object
    store at the workspace's ``objects`` directory stops snapshots from
    storing a second copy of the same tree. Best effort: any failure leaves
    the repo self-contained, which is the behavior without seeding.
    """
    if not seed_objects_enabled():
        return False
    code, out, _ = await _git(
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        cwd=worktree,
    )
    if code != 0:
        return False
    common_dir = out.decode(errors="replace").strip()
    if not common_dir:
        return False
    source_objects = Path(common_dir) / "objects"
    alternates = _alternate_object_dirs(source_objects)
    if not alternates:
        return False
    info_dir = gitdir / "objects" / "info"
    await asyncio.to_thread(info_dir.mkdir, parents=True, exist_ok=True)
    await asyncio.to_thread(
        (info_dir / "alternates").write_text,
        "\n".join(alternates) + "\n",
    )
    if copy_index:
        source_index = Path(common_dir) / "index"
        if source_index.is_file():
            try:
                await asyncio.to_thread(shutil.copyfile, source_index, gitdir / "index")
            except OSError as exc:
                logger.debug(
                    "snapshot_seed_index_failed gitdir={} error={}", gitdir, exc
                )
    logger.info(
        "snapshot_seeded_objects gitdir={} alternates={}", gitdir, len(alternates)
    )
    return True


async def _ensure_seed(gitdir: Path, worktree: Path, *, copy_index: bool) -> None:
    """Seed a repo's object store once, tolerating any failure."""
    key = str(gitdir)
    if key in _seed_attempted:
        return
    _seed_attempted.add(key)
    try:
        await _seed_objects(gitdir, worktree, copy_index=copy_index)
    except OSError as exc:
        logger.debug("snapshot_seed_failed gitdir={} error={}", gitdir, exc)


async def _init_repo(gitdir: Path, worktree: Path) -> bool:
    """Initialise the out-of-tree git repo if needed. Idempotent."""
    gitdir.mkdir(parents=True, exist_ok=True)
    head_file = gitdir / "HEAD"
    if head_file.exists():
        await _ensure_seed(gitdir, worktree, copy_index=False)
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

    await _ensure_seed(gitdir, worktree, copy_index=True)
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
        await _ensure_ref(gitdir, snapshot_hash)
        _last_hashes[cache_key] = snapshot_hash
        _track_counts[session_id] = _track_counts.get(session_id, 0) + 1
        if _track_counts[session_id] % _MAINTENANCE_INTERVAL == 0:
            await _maintain_repo(gitdir)
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
            _seed_attempted.discard(str(gitdir))
    _locks.pop(session_id, None)
