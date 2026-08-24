"""Uploads, workspace media proxy, and flat workspace file listing.

Two endpoints, one root (see :mod:`app.core.paths`):

- ``GET /api/team/{sid}/uploads/{filename}`` →
  ``{OPENAGENTD_WORKSPACE_DIR}/{sid}/uploads/{filename}``
  User-uploaded attachments. Flat namespace (UUID-named by the uploader).

- ``GET /api/team/{sid}/media/{path}`` → ``{OPENAGENTD_WORKSPACE_DIR}/{sid}/{path}``
  Agent workspace output (files written by the write/shell tools). Nested
  paths allowed. Target of bare markdown image refs rendered by the
  assistant: ``![alt](chart.png)`` → ``/api/team/{sid}/media/chart.png``.

``GET /api/team/{sid}/files`` provides a flat recursive listing of the
agent workspace — powers the "Artifacts" panel in the web UI.
"""

from __future__ import annotations

import asyncio
import difflib
import mimetypes
import os
import re
import stat
import subprocess
import uuid
from pathlib import Path

from app.agent.tools.builtin.filesystem._ignore import (
    NOISE_DIR_NAMES,
    is_gitignored as _shared_is_gitignored,
    load_gitignore_rules as _shared_load_gitignore_rules,
    matches_gitignore_pattern as _shared_matches_gitignore_pattern,
)

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from app.api.schemas.team import (
    CodingWorkspaceFilesResponse,
    WorkspaceFileInfo,
    WorkspaceFilesResponse,
    GitCommit,
    WorkspaceGitHistoryResponse,
    WorkspaceCommitDiffResponse,
    CodingWorkspaceGitDiffResponse,
    CodingWorkspaceStatusResponse,
    CodingWorkspaceStatusDirty,
    CodingWorkspaceStatusHead,
    DiscardWorkspaceFileRequest,
    DiscardWorkspaceFileResponse,
    GitUndoRequest,
    GitUndoResponse,
    GitRevertRequest,
    GitRevertResponse,
)
from app.core.db import async_session_factory
from app.core.paths import session_workspace_dir
from app.models.chat import ChatSession
from app.services import team_manager

router = APIRouter()


# ── Path-safety helpers ───────────────────────────────────────────────────────


def _safe_resolve(root: Path, rel: str) -> Path:
    """Resolve ``rel`` under ``root`` with traversal protection.

    Raises ``HTTPException(400)`` on traversal attempts (``..``, absolute
    paths, symlink escapes) and on empty paths.  Raises ``HTTPException(404)``
    when the resolved target does not exist or is not a regular file.
    """
    if not rel or rel.strip() == "":
        raise HTTPException(status_code=400, detail="Empty media path.")

    # Reject absolute paths and Windows drive letters early.
    candidate = Path(rel)
    if candidate.is_absolute() or (len(rel) >= 2 and rel[1] == ":"):
        raise HTTPException(status_code=400, detail="Absolute media paths rejected.")

    try:
        resolved = (root / candidate).resolve(strict=False)
        root_resolved = root.resolve(strict=False)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=400, detail="Invalid media path.")

    # Containment check — fails on ``..`` escapes and symlinks pointing outside.
    try:
        resolved.relative_to(root_resolved)
    except ValueError:
        raise HTTPException(status_code=400, detail="Media path escapes session root.")

    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail="Media file not found.")

    return resolved


# The stdlib table maps ``.ts``/``.mts`` to ``video/mp2t`` (MPEG transport
# stream), so TypeScript sources were reported as video and the UI rendered
# them in a <video> player instead of the text viewer. In an agent workspace
# these extensions are always source code.
_MIME_OVERRIDES: dict[str, str] = {
    ".ts": "text/typescript",
    ".mts": "text/typescript",
    ".cts": "text/typescript",
    ".tsx": "text/typescript",
}


def _guess_mime(path: Path) -> str:
    override = _MIME_OVERRIDES.get(path.suffix.lower())
    if override is not None:
        return override
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


async def _session_row(session_id: str) -> ChatSession | None:
    """Best-effort load of the chat session row for path resolution."""
    try:
        async with async_session_factory() as db:
            return await db.get(ChatSession, uuid.UUID(session_id))
    except Exception:
        return None


async def _session_workspace(session_id: str) -> Path:
    """Resolve the validated workspace persisted on a coding session."""
    row = await _session_row(session_id)
    if row is None or not row.workspace:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session_workspace_dir(session_id, row.workspace)


# ── Routes ────────────────────────────────────────────────────────────────────


@router.get("/{session_id}/uploads/{filename}")
async def get_uploaded_file(session_id: str, filename: str) -> FileResponse:
    """Serve a user-uploaded attachment from the session's uploads dir.

    Flat namespace — ``filename`` must not contain path separators.
    """
    # Reject anything that looks like a path — uploads are flat.
    if "/" in filename or "\\" in filename or filename in ("", ".", ".."):
        raise HTTPException(status_code=400, detail="Invalid upload filename.")

    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id.")

    workspace = await _session_workspace(session_id)
    resolved = _safe_resolve(workspace / "uploads", filename)
    return FileResponse(
        path=str(resolved),
        media_type=_guess_mime(resolved),
        filename=resolved.name,
    )


@router.get("/{session_id}/media/{file_path:path}")
async def get_workspace_media(
    session_id: str,
    file_path: str,
    download: bool = Query(default=False),
) -> FileResponse:
    """Serve a file from the session's agent workspace.

    Supports nested subpaths (e.g. ``output/chart.png``).  Path traversal is
    rejected; symlink escapes outside the workspace root are rejected via
    containment check on the resolved path.
    """
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id.")

    # Workspace state is authoritative — when the session is in a reverted
    # tail, :mod:`app.services.snapshot_service` has already restored the
    # filesystem to the boundary's snapshot, so files that should be
    # hidden simply do not exist on disk and ``_safe_resolve`` 404s.
    resolved = _safe_resolve(await _session_workspace(session_id), file_path)

    return FileResponse(
        path=str(resolved),
        media_type=_guess_mime(resolved),
        filename=resolved.name,
        content_disposition_type="attachment" if download else "inline",
    )


# ── Workspace file listing ────────────────────────────────────────────────────
#
# Flat recursive listing of the agent workspace.
# Design choices:
#   - Flat list (not tree) — the UI groups by directory, keeps payload simple.
#   - Regular files only (no dirs, no symlinks leaving the root).
#   - Paths are relative (POSIX separators) — safe to pass back to ``/media/``.
#   - Size cap on the walk to avoid pathological workspaces blowing up the
#     response.  Beyond the cap we truncate and flag it.
#   - Which files are *visible* comes from git whenever the workspace is the
#     top level of a work tree (see ``_git_listed_paths``); the os.walk +
#     root-``.gitignore`` heuristic below is the fallback for plain folders
#     such as agent session workspaces.

# Ceiling on entries returned. Truncation is silent to the user, so it doubles
# as a "files are missing from the picker" bug: at 2_000 a 9k-file repo hid 78%
# of itself. Sourcing the list from ``git ls-files`` made enumeration cheap
# enough to raise it — measured on a 9k-file repo: 124ms and ~590KB of JSON at
# 5_000 entries, for one response shared by every consumer (artifacts tree,
# coding tree, @-mention picker, command palette).
_MAX_FILES_LISTED = 5_000

_MAX_GIT_DIFF_CHARS = 512 * 1024
_MAX_UNTRACKED_DIFF_BYTES = 256 * 1024


def _load_gitignore_rules(root: Path) -> list[tuple[str, bool]]:
    return _shared_load_gitignore_rules(root)


def _matches_gitignore_pattern(pattern: str, rel: str, *, is_dir: bool) -> bool:
    return _shared_matches_gitignore_pattern(pattern, rel, is_dir=is_dir)


def _is_gitignored(rel: str, *, is_dir: bool, rules: list[tuple[str, bool]]) -> bool:
    return _shared_is_gitignored(rel, is_dir=is_dir, rules=rules)


@router.get("/{session_id}/files")
async def list_workspace_files(session_id: str) -> WorkspaceFilesResponse:
    """List every file under the session's agent workspace, recursively.

    Returns an empty list when the workspace directory does not yet exist
    (fresh session — no tool has written anything).  Dot-prefixed entries are
    included (except ``.git/``) so ``.github/`` or ``.env.example`` can be
    tagged; symlinks pointing outside the workspace root are skipped.
    """
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id.")

    # No boundary filtering needed — snapshot_service has restored the
    # workspace to the reverted-boundary state, so the on-disk file set
    # already reflects what should be visible.
    #
    # ``_list_workspace_files`` is a synchronous, potentially slow walk
    # (os.walk + per-file stat/resolve over the whole tree). Offload it to
    # a worker thread so a large workspace can't block the event loop and
    # stall every other concurrent request.
    root = await _session_workspace(session_id)
    return await asyncio.to_thread(_list_workspace_files, root, session_id)


def _list_workspace_files(root: Path, session_id: str) -> WorkspaceFilesResponse:
    if not root.exists() or not root.is_dir():
        return WorkspaceFilesResponse(session_id=session_id, files=[], truncated=False)

    files: list[WorkspaceFileInfo] = []
    truncated = _collect_files(root, root, files)
    return WorkspaceFilesResponse(
        session_id=session_id, files=files, truncated=truncated
    )


def _collect_files(root: Path, base: Path, out: list[WorkspaceFileInfo]) -> bool:
    """Append the visible files under ``base`` to ``out``, relative to ``root``.

    Prefers git's own answer for what is visible and falls back to the walk
    heuristic. Returns ``True`` when the ``_MAX_FILES_LISTED`` cap was hit.
    """
    listed = _git_listed_paths(base)
    if listed is None:
        return _walk_files(root, base, out)
    return _stat_listed_paths(root, base, listed, out)


def _git_stdout(cwd: Path, *args: str, timeout: float = 10.0) -> str | None:
    """Synchronous ``git`` runner for the threaded listing; None on any failure."""
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return str(result.stdout) if result.returncode == 0 else None


def _git_listed_paths(base: Path) -> list[str] | None:
    """Paths git shows in ``base``: tracked + untracked-but-not-ignored.

    ``None`` means "not answerable by git" — no git binary, not a work tree, or
    ``base`` is not the work tree's **top level** — and the caller falls back to
    the os.walk heuristic.

    The top-level check is not a nicety. Agent session workspaces live under the
    host repo's gitignored ``.openagentd/`` directory, where ``git ls-files``
    correctly reports *nothing*; using that answer would render every session
    workspace as empty.

    Delegating to git is what makes the listing match the user's editor: it
    honours nested ``.gitignore`` files, ``!`` re-includes, ``.git/info/exclude``
    and ``core.excludesFile``, and git's rule that ``*`` never crosses ``/`` —
    all things the fallback matcher gets wrong.
    """
    toplevel = _git_stdout(base, "rev-parse", "--show-toplevel")
    if toplevel is None:
        return None
    if os.path.realpath(toplevel.strip()) != os.path.realpath(base):
        return None

    tracked = _git_stdout(base, "ls-files", "-z", "--cached")
    untracked = _git_stdout(base, "ls-files", "-z", "--others", "--exclude-standard")
    if tracked is None or untracked is None:
        return None

    # Conflicted files appear once per merge stage in --cached, hence the dedupe.
    paths = {rel for rel in tracked.split("\0") if rel}
    # Untracked noise is dropped: a repo that forgot to ignore ``node_modules``
    # would otherwise flood the picker and burn the whole file cap. Tracked
    # files are never filtered — if it is committed, the user wants to see it.
    paths.update(
        rel for rel in untracked.split("\0") if rel and not _has_noise_component(rel)
    )
    return sorted(paths)


def _has_noise_component(rel: str) -> bool:
    """True when any *directory* component of ``rel`` is a dependency/cache dir."""
    return any(part in NOISE_DIR_NAMES for part in rel.rstrip("/").split("/")[:-1])


def _stat_listed_paths(
    root: Path, base: Path, listed: list[str], out: list[WorkspaceFileInfo]
) -> bool:
    """Turn git's path list into entries, recursing into nested repos.

    ``git ls-files`` reports a submodule as a single gitlink entry and an
    untracked nested repository as a bare ``dir/``; both stat as directories, so
    each is listed by asking *its* git the same question.
    """
    root_resolved = root.resolve(strict=False)
    for rel in listed:
        if len(out) >= _MAX_FILES_LISTED:
            return True
        entry = base / rel.rstrip("/")
        try:
            entry_stat = entry.lstat()
        except (OSError, ValueError):
            continue
        if stat.S_ISDIR(entry_stat.st_mode):
            if _collect_files(root, entry, out):
                return True
            continue
        info = _file_info(entry, root, root_resolved, entry_stat)
        if info is not None:
            out.append(info)
    # Every listed path was consumed — a cap hit is reported only when entries
    # were actually left out, so a workspace of exactly the cap size is exact.
    return False


def _file_info(
    entry: Path, root: Path, root_resolved: Path, entry_stat: os.stat_result
) -> WorkspaceFileInfo | None:
    """Build one listing entry, or ``None`` for anything that must not be shown.

    Symlinks are followed only while they stay inside the workspace root — a
    link pointing outside must not leak the external file's metadata.
    """
    if stat.S_ISLNK(entry_stat.st_mode):
        try:
            resolved = entry.resolve(strict=False)
            resolved.relative_to(root_resolved)
            if not resolved.is_file():
                return None
            entry_stat = resolved.stat()
        except (OSError, ValueError):
            return None
    elif not stat.S_ISREG(entry_stat.st_mode):
        return None
    try:
        rel = entry.relative_to(root).as_posix()
    except ValueError:
        return None
    return WorkspaceFileInfo(
        path=rel,
        name=entry.name,
        size=entry_stat.st_size,
        mtime=entry_stat.st_mtime,
        mime=_guess_mime(entry),
    )


def _walk_files(root: Path, base: Path, out: list[WorkspaceFileInfo]) -> bool:
    """os.walk fallback for folders git cannot answer for (plain workspaces).

    Honours only ``base``'s own ``.gitignore`` via the shared fnmatch matcher —
    an approximation, which is exactly why the git path above is preferred.
    """
    root_resolved = root.resolve(strict=False)
    gitignore_rules = _load_gitignore_rules(base)
    truncated = False

    # InputBar @-mention picker policy:
    #   - Skip the generated trees in ``NOISE_DIR_NAMES`` (``.git/``, caches,
    #     dependencies) — huge and never worth referencing from a composer.
    #   - Otherwise allow dot-prefixed entries (``.openagentd/``, ``.github/``,
    #     ``.env.example``, …) and defer the actual filtering to ``.gitignore``.
    #     This matches what users see in their editor and honours the project's
    #     ``!`` re-include rules (e.g. ``.openagentd/commands/`` is tracked even
    #     though ``.openagentd/*`` is ignored).
    for dirpath, dirnames, filenames in os.walk(base):
        current = Path(dirpath)
        try:
            # os.walk does not follow directory symlinks, so checking each
            # walked directory once establishes containment for its regular
            # entries without resolving every file path.
            current_resolved = (
                root_resolved if current == root else current.resolve(strict=False)
            )
            current_resolved.relative_to(root_resolved)
        except (OSError, ValueError):
            dirnames.clear()
            continue
        dirnames[:] = sorted(
            name
            for name in dirnames
            if name not in NOISE_DIR_NAMES
            and not _is_gitignored(
                (current / name).relative_to(base).as_posix(),
                is_dir=True,
                rules=gitignore_rules,
            )
        )

        for filename in sorted(filenames):
            if len(out) >= _MAX_FILES_LISTED:
                truncated = True
                break
            entry = current / filename
            if _is_gitignored(
                entry.relative_to(base).as_posix(), is_dir=False, rules=gitignore_rules
            ):
                continue
            try:
                entry_stat = entry.lstat()
            except (OSError, ValueError):
                continue
            info = _file_info(entry, root, root_resolved, entry_stat)
            if info is not None:
                out.append(info)
        if truncated:
            break

    return truncated


@router.get("/workspace/files/read")
async def read_coding_workspace_file(
    workspace: str, path: str, download: bool = False
) -> FileResponse:
    """Serve the raw bytes of a single file from the coding workspace.

    ``path`` is the POSIX-relative path returned by ``/workspace/files/list``
    (e.g. ``src/main.py`` or ``output/chart.png``).  Path traversal is
    rejected via containment check on the resolved path — the same guard
    used by the session media proxy.
    """
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    root = Path(resolved).resolve(strict=False)
    target = (root / path).resolve(strict=False)
    try:
        target.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path escapes workspace root.")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")

    # Workspace source files are edited by the agent between reads. Browsers
    # otherwise apply heuristic freshness (no Cache-Control) or trust a
    # stat-based ETag (mtime + size) that can collide across quick edits,
    # both of which can serve pre-edit bytes back to the coding panel even
    # though the file changed on disk — force revalidation on every request.
    return FileResponse(
        path=str(target),
        media_type=_guess_mime(target),
        filename=target.name if download else None,
        headers={"Cache-Control": "no-store"},
    )


@router.get("/workspace/files/list")
async def list_coding_workspace_files(workspace: str) -> CodingWorkspaceFilesResponse:
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    # Coding workspaces can be large repos — offload the synchronous walk
    # to a thread so it doesn't block the event loop (see list_workspace_files).
    listing = await asyncio.to_thread(
        _list_workspace_files, Path(resolved), "workspace"
    )
    return CodingWorkspaceFilesResponse(
        workspace=resolved,
        files=listing.files,
        truncated=listing.truncated,
    )


@router.get("/workspace/git-diff/view")
async def get_coding_workspace_git_diff(
    workspace: str,
    paths: list[str] | None = Query(None),
) -> CodingWorkspaceGitDiffResponse:
    """Return the workspace's git diff, optionally scoped to ``paths``.

    Without ``paths`` the diff covers the entire repo (``git diff -- .``) —
    the legacy whole-repo behaviour. With ``paths`` we run
    ``git diff -- a b c`` and filter the untracked scan to those entries
    too, yielding the diff hunks for just those files. Per-file scoped
    diffs are ~5–20ms vs ~100–800ms for the whole-repo path; the SSE
    cache bridge uses them to splice live tool_end changes into the
    cached diff without paying the full refresh cost.
    """
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    root = Path(resolved)
    if not (root / ".git").exists():
        return CodingWorkspaceGitDiffResponse(
            workspace=resolved, is_git_repo=False, diff=""
        )

    # Normalise + validate paths: drop empties, reject absolute or
    # parent-traversal paths so the scoped call can't leak diffs from
    # outside the workspace.
    scoped: list[str] = []
    if paths:
        for raw in paths:
            if not raw:
                continue
            normal = os.path.normpath(raw)
            if normal.startswith("..") or os.path.isabs(normal):
                raise HTTPException(
                    status_code=422,
                    detail=f"invalid path in scoped diff: {raw}",
                )
            scoped.append(normal)
    # ``git diff -- .`` covers the whole tree; ``git diff -- a b c``
    # restricts to those pathspecs (which can be files or directories).
    diff_paths = scoped if scoped else ["."]

    # We want changes to show whether or not they've been staged. Plain
    # ``git diff`` only reports working-tree-vs-index (unstaged) changes, so a
    # file disappears from the panel the moment it's ``git add``-ed.
    # ``git diff HEAD`` instead reports working-tree-vs-HEAD, i.e. the combined
    # staged + unstaged changes for every tracked file in a single diff with no
    # duplicate per-file sections. When there is no HEAD yet (a repo with zero
    # commits) ``git diff HEAD`` fails, so we fall back to a plain ``git diff``.
    has_head = await _run_git(resolved, "rev-parse", "--verify", "HEAD") is not None
    diff_args = ["diff", "HEAD"] if has_head else ["diff"]

    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["git", "-C", resolved, *diff_args, "--", *diff_paths],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=500, detail=f"git diff failed: {exc}") from exc

    if result.returncode != 0:
        raise HTTPException(
            status_code=500, detail=result.stderr.strip() or "git diff failed"
        )
    untracked_out = await _run_git(
        resolved, "ls-files", "--others", "--exclude-standard"
    )
    untracked = untracked_out.splitlines() if untracked_out is not None else []
    # When scoped, only synthesise untracked diffs for paths the caller
    # asked about — otherwise the response would carry diff hunks for
    # files the SSE bridge has no reason to splice.
    if scoped:
        scoped_set = set(scoped)
        untracked = [u for u in untracked if u in scoped_set]
    tracked_diff = str(result.stdout)
    # to_thread: reads up to 256KB per untracked file and runs difflib on
    # each — measured ~100ms inline for 30 ~200KB files, scaling linearly
    # with untracked-file count. Keep it off the event loop like every
    # other blocking call in this route.
    full_diff = tracked_diff + await asyncio.to_thread(_untracked_diff, root, untracked)
    truncated = len(full_diff) > _MAX_GIT_DIFF_CHARS
    diff = full_diff[:_MAX_GIT_DIFF_CHARS]
    return CodingWorkspaceGitDiffResponse(
        workspace=resolved,
        is_git_repo=True,
        diff=diff,
        untracked=untracked,
        truncated=truncated,
    )


def _untracked_diff(root: Path, paths: list[str]) -> str:
    chunks: list[str] = []
    for path in paths:
        file_path = root / path
        try:
            if (
                not file_path.is_file()
                or file_path.stat().st_size > _MAX_UNTRACKED_DIFF_BYTES
            ):
                chunks.append(
                    f"\ndiff --git a/{path} b/{path}\n"
                    "new file mode 100644\n"
                    f"Binary or large file not shown: {path}\n"
                )
                continue
            lines = file_path.read_text(encoding="utf-8").splitlines(keepends=True)
        except (OSError, UnicodeDecodeError):
            chunks.append(
                f"\ndiff --git a/{path} b/{path}\n"
                "new file mode 100644\n"
                f"Binary or unreadable file not shown: {path}\n"
            )
            continue

        body = "".join(
            difflib.unified_diff(
                [],
                lines,
                fromfile="/dev/null",
                tofile=f"b/{path}",
            )
        )
        chunks.append(f"\ndiff --git a/{path} b/{path}\nnew file mode 100644\n{body}")
    return "".join(chunks)


async def _run_git(cwd: str, *args: str, timeout: float = 5.0) -> str | None:
    """Run a git command, returning stdout on success or None on any failure."""
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["git", "-C", cwd, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    # ``text=True`` above guarantees a str
    return str(result.stdout)


def _parse_porcelain_v2(stdout: str) -> tuple[str | None, dict[str, int]]:
    """Parse ``git status --porcelain=v2 --branch`` output.

    Returns ``(branch, counts)`` where ``counts`` has keys ``staged``,
    ``unstaged``, ``untracked``. ``branch`` is ``None`` for detached HEAD.
    """
    branch: str | None = None
    staged = unstaged = untracked = 0
    for line in stdout.splitlines():
        if line.startswith("# branch.head "):
            head = line[len("# branch.head ") :].strip()
            branch = None if head == "(detached)" else head
        elif line.startswith(("1 ", "2 ")):
            # XY status code in field 2 (e.g. "M.", ".M", "MM")
            parts = line.split(" ", 2)
            if len(parts) >= 2 and len(parts[1]) == 2:
                if parts[1][0] != ".":
                    staged += 1
                if parts[1][1] != ".":
                    unstaged += 1
        elif line.startswith("? "):
            untracked += 1
    return branch, {"staged": staged, "unstaged": unstaged, "untracked": untracked}


@router.get("/workspace/status")
async def get_coding_workspace_status(
    workspace: str,
) -> CodingWorkspaceStatusResponse:
    """Lightweight workspace overview for the coding-mode empty state.

    Returns workspace path + name (always), and git metadata (branch, dirty
    counts, last commit) when the folder is a git repo. Failures degrade
    gracefully — missing git / dirty parse errors yield ``is_git_repo: false``
    rather than 500.
    """
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    root = Path(resolved)
    name = root.name or resolved

    if not (root / ".git").exists():
        return CodingWorkspaceStatusResponse(
            workspace=resolved, name=name, is_git_repo=False
        )

    status_out = await _run_git(resolved, "status", "--porcelain=v2", "--branch")
    if status_out is None:
        return CodingWorkspaceStatusResponse(
            workspace=resolved, name=name, is_git_repo=False
        )
    branch, counts = _parse_porcelain_v2(status_out)

    head: dict | None = None
    log_out = await _run_git(resolved, "log", "-1", "--format=%h%x00%s%x00%ct")
    if log_out:
        parts = log_out.rstrip("\n").split("\x00")
        if len(parts) == 3:
            try:
                head = {
                    "sha": parts[0],
                    "subject": parts[1],
                    "timestamp": int(parts[2]),
                }
            except ValueError:
                head = None

    dirty_model = CodingWorkspaceStatusDirty(**counts) if counts else None
    head_model = CodingWorkspaceStatusHead(**head) if head else None

    # Count local/remote divergence from tracking branch (@{u}) or fallback origin branch.
    commits_ahead: int | None = None
    commits_behind: int | None = None
    upstream: str | None = None

    upstream_ref: str | None = "@{u}"
    ahead_out = await _run_git(
        resolved, "rev-list", "--count", "HEAD", f"^{upstream_ref}"
    )

    if ahead_out is None:
        # @{u} failed (e.g. no tracking branch configured for a newly created branch like branch-A).
        # Fallback to candidate origin references: origin/<branch>, origin/HEAD, origin/main, origin/master, main, master.
        candidates: list[str] = []
        if branch:
            candidates.append(f"origin/{branch}")
        candidates.extend(
            ["origin/HEAD", "origin/main", "origin/master", "main", "master"]
        )

        upstream_ref = None
        for candidate in candidates:
            # Skip comparing local branch against itself when no remote origin exists
            if branch and candidate == branch:
                continue
            if await _run_git(resolved, "rev-parse", "--verify", candidate) is not None:
                upstream_ref = candidate
                ahead_out = await _run_git(
                    resolved, "rev-list", "--count", "HEAD", f"^{upstream_ref}"
                )
                if ahead_out is not None:
                    break

    if upstream_ref and ahead_out is not None:
        stripped = ahead_out.strip()
        if stripped.isdigit():
            commits_ahead = int(stripped)

        behind_out = await _run_git(
            resolved, "rev-list", "--count", upstream_ref, "^HEAD"
        )
        if behind_out is not None:
            behind_stripped = behind_out.strip()
            if behind_stripped.isdigit():
                commits_behind = int(behind_stripped)

        if upstream_ref == "@{u}":
            abbrev = await _run_git(resolved, "rev-parse", "--abbrev-ref", "@{u}")
            upstream = abbrev.strip() if abbrev else "@{u}"
        else:
            upstream = upstream_ref

    return CodingWorkspaceStatusResponse(
        workspace=resolved,
        name=name,
        is_git_repo=True,
        branch=branch,
        dirty=dirty_model,
        head=head_model,
        commits_ahead=commits_ahead,
        commits_behind=commits_behind,
        upstream=upstream,
    )


@router.get("/workspace/git/history")
async def get_coding_workspace_git_history(
    workspace: str,
    limit: int = Query(50, ge=1, le=500),
    cursor: str | None = Query(None),
    all_branches: bool = Query(False, alias="all"),
) -> WorkspaceGitHistoryResponse:
    """Retrieve the recent git commits and textual branch graph for a workspace."""
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if cursor and not re.match(r"^[a-fA-F0-9]{4,64}$", cursor):
        raise HTTPException(status_code=422, detail="Invalid cursor SHA format.")

    root = Path(resolved)
    if not (root / ".git").exists():
        return WorkspaceGitHistoryResponse(
            workspace=resolved,
            is_git_repo=False,
            commits=[],
            next_cursor=None,
            graph="",
        )

    # 1. Fetch structured commits (limit + 1 to detect next page).
    #    Fields: sha, short_sha, author_name, author_email, timestamp, subject,
    #            body, refs — separated by NUL (\x00).  Each *record* ends with
    #    the ASCII Record Separator (\x1e) so that multi-line body text doesn't
    #    break parsing.
    log_args = ["log"]
    if cursor:
        log_args.extend([cursor, "--skip=1"])
    log_args.extend(
        [
            "-n",
            str(limit + 1),
            "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%d%x1e",
        ]
    )
    if all_branches:
        # ``--all`` walks every ref under refs/, which includes refs/stash —
        # exclude it so stash entries never show up as commits.
        log_args.extend(["--exclude=refs/stash", "--all"])

    commits_out = await _run_git(resolved, *log_args)
    commits = []
    if commits_out:
        # Split records on \x1e (each record ends with it, so the last split
        # element will be an empty string — skip it).
        for record in commits_out.split("\x1e"):
            record = record.strip("\n")
            if not record:
                continue
            parts = record.split("\x00")
            if len(parts) < 6:
                continue
            try:
                timestamp = int(parts[4])
            except ValueError:
                timestamp = 0

            body_raw = parts[6].strip() if len(parts) > 6 else ""
            refs = (
                parts[7].strip(" ()\n") if len(parts) > 7 and parts[7].strip() else None
            )
            commits.append(
                GitCommit(
                    sha=parts[0],
                    short_sha=parts[1],
                    author_name=parts[2],
                    author_email=parts[3],
                    timestamp=timestamp,
                    subject=parts[5],
                    body=body_raw or None,
                    refs=refs,
                )
            )

    # 2. Determine next_cursor and slice
    next_cursor = None
    if len(commits) > limit:
        next_cursor = commits[limit].sha
        commits = commits[:limit]

    # 3. Fetch git log graph
    graph_args = [
        "log",
        "--graph",
        "--oneline",
        "--decorate",
        "--color=never",
        "-n",
        str(limit),
    ]
    if all_branches:
        graph_args.extend(["--exclude=refs/stash", "--all"])

    graph_out = await _run_git(resolved, *graph_args)
    graph = graph_out if graph_out else ""

    return WorkspaceGitHistoryResponse(
        workspace=resolved,
        is_git_repo=True,
        commits=commits,
        next_cursor=next_cursor,
        graph=graph,
    )


@router.post("/workspace/git/discard")
async def discard_coding_workspace_file(
    body: DiscardWorkspaceFileRequest,
) -> DiscardWorkspaceFileResponse:
    """Discard changes for a single file in the workspace.

    - Modified / deleted (tracked): ``git checkout -- <path>``
    - Added / untracked: delete the file from disk

    The caller supplies ``{"workspace": "...", "path": "...", "status": "M"|"D"|"A"}``.
    """
    workspace: str = body.workspace
    rel_path: str = body.path
    status: str = body.status

    if not workspace or not rel_path:
        raise HTTPException(status_code=400, detail="workspace and path are required.")

    try:
        resolved_workspace = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    root = Path(resolved_workspace)
    if not (root / ".git").exists():
        raise HTTPException(status_code=400, detail="Not a git repository.")

    # Traversal guard — reuse the existing helper (without the existence check
    # so deleted-file restore works even when the file is already gone).
    candidate = Path(rel_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise HTTPException(status_code=400, detail="Invalid file path.")
    try:
        abs_path = (root / candidate).resolve(strict=False)
        abs_root = root.resolve(strict=False)
        abs_path.relative_to(abs_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path escapes workspace root.")

    if status == "A":
        # Added / untracked — just delete the file; there is no previous
        # version to restore.
        try:
            abs_path.unlink(missing_ok=True)
        except OSError as exc:
            raise HTTPException(
                status_code=500, detail=f"Could not delete file: {exc}"
            ) from exc
    else:
        # Modified or deleted — restore from the index.
        result = await asyncio.to_thread(
            subprocess.run,
            ["git", "-C", resolved_workspace, "checkout", "--", rel_path],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=f"git checkout failed: {result.stderr.strip()}",
            )

    return DiscardWorkspaceFileResponse(
        workspace=workspace, path=rel_path, status=status
    )


@router.get("/workspace/git/commit-diff")
async def get_coding_workspace_commit_diff(
    workspace: str,
    sha: str,
) -> WorkspaceCommitDiffResponse:
    """Retrieve the diff of a specific commit in the workspace, matching git diff format."""
    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if not re.match(r"^[a-fA-F0-9]{4,64}$", sha):
        raise HTTPException(status_code=422, detail="Invalid commit SHA format.")

    root = Path(resolved)
    if not (root / ".git").exists():
        raise HTTPException(status_code=400, detail="Not a git repository.")

    # Get the diff of the commit without the commit message header, matching git diff output
    diff_out = await _run_git(resolved, "show", "--no-notes", "--pretty=format:", sha)
    if diff_out is None:
        raise HTTPException(
            status_code=404, detail="Commit not found or failed to retrieve diff."
        )

    return WorkspaceCommitDiffResponse(
        sha=sha,
        diff=diff_out,
    )


@router.post("/workspace/git/undo")
async def undo_coding_workspace_last_commit(
    body: GitUndoRequest,
) -> GitUndoResponse:
    """Undo the last commit in the workspace (soft reset).

    Preserves changes in the working tree and index.
    """
    workspace = body.workspace
    if not workspace:
        raise HTTPException(status_code=400, detail="workspace is required.")

    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    root = Path(resolved)
    if not (root / ".git").exists():
        raise HTTPException(status_code=400, detail="Not a git repository.")

    # Check if HEAD exists
    has_head = await _run_git(resolved, "rev-parse", "--verify", "HEAD") is not None
    if not has_head:
        raise HTTPException(status_code=400, detail="No commits to undo.")

    # Check if HEAD~1 exists
    has_parent = await _run_git(resolved, "rev-parse", "--verify", "HEAD~1") is not None
    if has_parent:
        args = ["reset", "--soft", "HEAD~1"]
    else:
        # Only one commit, undo initial commit by deleting the ref
        args = ["update-ref", "-d", "HEAD"]

    result = await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", resolved, *args],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"git reset failed: {result.stderr.strip() or result.stdout.strip()}",
        )

    return GitUndoResponse(workspace=workspace, success=True)


@router.post("/workspace/git/revert")
async def revert_coding_workspace_commit(
    body: GitRevertRequest,
) -> GitRevertResponse:
    """Revert a specific commit in the workspace.

    Creates a new commit reverting the changes of the specified commit.
    """
    workspace = body.workspace
    sha = body.sha

    if not workspace or not sha:
        raise HTTPException(status_code=400, detail="workspace and sha are required.")

    if not re.match(r"^[a-fA-F0-9]{4,64}$", sha):
        raise HTTPException(status_code=422, detail="Invalid commit SHA format.")

    try:
        resolved = team_manager.validate_workspace(workspace)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    root = Path(resolved)
    if not (root / ".git").exists():
        raise HTTPException(status_code=400, detail="Not a git repository.")

    # Run git revert. We use --no-edit to avoid launching an editor.
    result = await asyncio.to_thread(
        subprocess.run,
        ["git", "-C", resolved, "revert", "--no-edit", sha],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    if result.returncode != 0:
        # Revert failed (possibly conflicts). Abort the revert to keep workspace clean.
        await asyncio.to_thread(
            subprocess.run,
            ["git", "-C", resolved, "revert", "--abort"],
            capture_output=False,
            check=False,
        )
        raise HTTPException(
            status_code=400,
            detail=f"Revert failed (likely due to conflicts):\n{result.stderr.strip() or result.stdout.strip()}",
        )

    return GitRevertResponse(workspace=workspace, sha=sha, success=True)
