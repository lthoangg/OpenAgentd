"""Filesystem storage, path containment, and concurrency control for memory pages."""

from __future__ import annotations

import asyncio
import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml
from loguru import logger

from app.core.chat_workspace import is_chat_workspace
from app.core.config import settings
from app.core.path_locks import path_lock
from app.services.memory.models import (
    MemoryFrontmatter,
    MemoryPage,
    MemoryScope,
)

MAX_MEMORY_PAGE_BYTES = 256 * 1024  # 256 KiB


class MemoryError(Exception):
    """Base exception for memory subsystem errors."""


class MemoryPreconditionRequiredError(MemoryError):
    """HTTP 428 Precondition Required (If-Match missing on existing file update/delete)."""


class MemoryPreconditionFailedError(MemoryError):
    """HTTP 412 Precondition Failed (ETag mismatch)."""


class MemoryPageNotFoundError(MemoryError):
    """HTTP 404 Memory page not found."""


class MemoryPayloadTooLargeError(MemoryError):
    """HTTP 413 Memory page exceeds 256 KiB limit."""


class MemoryScopeAuthorizationError(MemoryError):
    """HTTP 403 Forbidden cross-workspace memory access."""


class MemoryContainmentError(MemoryError):
    """HTTP 400 Path traversal or symlink violation."""


def compute_etag(raw_bytes: bytes) -> str:
    """Return a quoted strong ETag for the given raw file bytes."""
    digest = hashlib.sha256(raw_bytes).hexdigest()
    return f'"{digest}"'


def global_memory_root() -> Path:
    """Canonical global memory root: {OPENAGENTD_CONFIG_DIR}/memory/."""
    config_dir = Path(settings.OPENAGENTD_CONFIG_DIR).resolve()
    return (config_dir / "memory").resolve()


def workspace_memory_root(workspace: str | Path) -> Path:
    """Canonical workspace memory root: {validated_workspace}/.openagentd/memory/."""
    from app.services import agent_manager

    validated = agent_manager.validate_workspace(str(workspace))
    return (Path(validated).resolve() / ".openagentd" / "memory").resolve()


def resolve_memory_scopes(
    workspace: str | Path | None,
    *,
    is_chat: bool | None = None,
) -> tuple[MemoryScope, MemoryScope | None]:
    """Resolve the active Global scope and optional Workspace scope.

    Chat workspaces (e.g. user home directory) strictly resolve Global scope only.
    """
    global_scope = MemoryScope(kind="global", root=global_memory_root())

    if workspace is None:
        return global_scope, None

    ws_path = Path(workspace).resolve()
    chat_mode = is_chat if is_chat is not None else is_chat_workspace(ws_path)
    if chat_mode:
        return global_scope, None

    try:
        ws_root = workspace_memory_root(ws_path)
        workspace_scope = MemoryScope(kind="workspace", root=ws_root)
        return global_scope, workspace_scope
    except Exception as exc:
        logger.warning(
            "workspace_memory_root_resolution_failed ws={} error={}", workspace, exc
        )
        return global_scope, None


def assert_no_memory_symlinks(path: Path) -> None:
    """Inspect raw lexical path components with lstat; reject if any symlink exists."""
    parts = path.parts
    if not parts:
        return
    current = Path(parts[0])
    for part in parts[1:]:
        current = current / part
        try:
            os.lstat(current)
            if os.path.islink(current):
                raise MemoryContainmentError(
                    f"Symlinks are strictly forbidden inside memory paths: {current}"
                )
        except FileNotFoundError:
            # Path component does not exist yet (normal when creating new file/subdirs)
            pass


def assert_authorized_memory_path(
    path: Path,
    active_workspace: str | Path | None = None,
    *,
    is_chat: bool = False,
) -> None:
    """Policy A check: memory paths must end with .md and belong only to Global or active Workspace."""
    if path.suffix.lower() != ".md":
        raise MemoryContainmentError(
            f"Memory files must have a .md extension: {path.name}"
        )

    assert_no_memory_symlinks(path)

    resolved = path.resolve()
    g_root = global_memory_root()
    if resolved.is_relative_to(g_root):
        return

    if is_chat or not active_workspace:
        raise MemoryScopeAuthorizationError(
            f"Workspace memory access is not authorized for path: {path}"
        )

    w_root = workspace_memory_root(active_workspace)
    if resolved.is_relative_to(w_root):
        return

    # Path is not under active workspace memory or global memory
    if (
        ".openagentd/memory" in path.as_posix()
        or ".openagentd\\memory" in path.as_posix()
    ):
        raise MemoryScopeAuthorizationError(
            f"Cross-workspace memory mutation is strictly forbidden: {path}"
        )


def parse_frontmatter(text: str) -> tuple[MemoryFrontmatter | None, str]:
    """Extract optional YAML frontmatter and body from Markdown text."""
    if not text.startswith("---"):
        return None, text
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return None, text
    end_idx = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx == -1:
        return None, text
    yaml_text = "".join(lines[1:end_idx])
    body = "".join(lines[end_idx + 1 :]).lstrip("\r\n")
    try:
        data = yaml.safe_load(yaml_text)
        if isinstance(data, dict):
            fm = MemoryFrontmatter.model_validate(data)
            return fm, body
    except Exception:
        pass
    return None, text


def _resolve_scope_file(scope: MemoryScope, relative_path: str) -> Path:
    """Resolve relative path inside scope root, ensuring strict containment."""
    norm = Path(relative_path)
    if norm.is_absolute() or ".." in norm.parts:
        raise MemoryContainmentError(f"Path traversal detected: {relative_path}")
    target = scope.root / norm
    assert_no_memory_symlinks(target)
    resolved = target.resolve()
    if not resolved.is_relative_to(scope.root):
        raise MemoryContainmentError(f"Path escapes memory root: {relative_path}")
    if resolved.suffix.lower() != ".md":
        raise MemoryContainmentError(f"Memory page must be a .md file: {relative_path}")
    return resolved


def _read_page_sync(target: Path, relative_path: str) -> MemoryPage:
    if not target.is_file():
        raise MemoryPageNotFoundError(f"Memory page not found: {relative_path}")
    raw_bytes = target.read_bytes()
    etag = compute_etag(raw_bytes)
    content = raw_bytes.decode("utf-8", errors="replace")
    frontmatter, _ = parse_frontmatter(content)
    return MemoryPage(
        path=relative_path.replace("\\", "/"),
        content=content,
        frontmatter=frontmatter,
        etag=etag,
    )


async def read_page(scope: MemoryScope, relative_path: str) -> MemoryPage:
    """Read an authoritative memory page off the event loop."""
    target = _resolve_scope_file(scope, relative_path)
    return await asyncio.to_thread(_read_page_sync, target, relative_path)


def _write_atomic_sync(target: Path, raw_bytes: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=str(target.parent),
        prefix=".tmp_mem_",
        delete=False,
    ) as tf:
        tmp_name = tf.name
        tf.write(raw_bytes)
    os.replace(tmp_name, target)


async def write_page(
    scope: MemoryScope,
    relative_path: str,
    content: str,
    if_match: str | None = None,
) -> tuple[MemoryPage, bool]:
    """Write a memory page atomically under path lock with ETag validation.

    Returns (page, is_no_op).
    """
    target = _resolve_scope_file(scope, relative_path)
    raw_bytes = content.encode("utf-8")
    if len(raw_bytes) > MAX_MEMORY_PAGE_BYTES:
        raise MemoryPayloadTooLargeError(
            f"Page size ({len(raw_bytes)} bytes) exceeds limit ({MAX_MEMORY_PAGE_BYTES} bytes)"
        )

    async with path_lock(target):
        exists = target.is_file()
        if exists:
            if if_match is None:
                raise MemoryPreconditionRequiredError(
                    "If-Match header is required to update an existing memory page."
                )
            current_bytes = await asyncio.to_thread(target.read_bytes)
            current_etag = compute_etag(current_bytes)
            if if_match.strip() != current_etag:
                raise MemoryPreconditionFailedError(
                    f"ETag mismatch: current {current_etag}, provided {if_match}"
                )
            if current_bytes == raw_bytes:
                # No-op write: reconcile external changes without blindly invalidating
                try:
                    from app.services.memory.manager import get_memory_manager

                    await get_memory_manager().reconcile(scope)
                except Exception as exc:
                    logger.warning("memory_noop_reconcile_failed error={}", exc)
                frontmatter, _ = parse_frontmatter(content)
                page = MemoryPage(
                    path=relative_path.replace("\\", "/"),
                    content=content,
                    frontmatter=frontmatter,
                    etag=current_etag,
                )
                return page, True

            # Pre-commit recheck
            recheck_bytes = await asyncio.to_thread(target.read_bytes)
            recheck_etag = compute_etag(recheck_bytes)
            if recheck_etag != current_etag:
                raise MemoryPreconditionFailedError(
                    "Target file was modified before commit."
                )

        await asyncio.to_thread(_write_atomic_sync, target, raw_bytes)
        try:
            from app.services.memory.manager import get_memory_manager

            get_memory_manager().invalidate(scope.scope_key)
        except Exception as exc:
            logger.warning("memory_write_invalidate_failed error={}", exc)
        new_etag = compute_etag(raw_bytes)
        frontmatter, _ = parse_frontmatter(content)
        page = MemoryPage(
            path=relative_path.replace("\\", "/"),
            content=content,
            frontmatter=frontmatter,
            etag=new_etag,
        )
        return page, False


async def delete_page(
    scope: MemoryScope,
    relative_path: str,
    if_match: str | None = None,
) -> None:
    """Delete a memory page under path lock with ETag validation."""
    target = _resolve_scope_file(scope, relative_path)
    async with path_lock(target):
        if not target.is_file():
            raise MemoryPageNotFoundError(f"Memory page not found: {relative_path}")
        if if_match is None:
            raise MemoryPreconditionRequiredError(
                "If-Match header is required to delete an existing memory page."
            )
        current_bytes = await asyncio.to_thread(target.read_bytes)
        current_etag = compute_etag(current_bytes)
        if if_match.strip() != current_etag:
            raise MemoryPreconditionFailedError(
                f"ETag mismatch: current {current_etag}, provided {if_match}"
            )
        await asyncio.to_thread(target.unlink)
        try:
            from app.services.memory.manager import get_memory_manager

            get_memory_manager().invalidate(scope.scope_key)
        except Exception as exc:
            logger.warning("memory_delete_invalidate_failed error={}", exc)


def _list_pages_sync(scope: MemoryScope) -> list[dict[str, Any]]:
    if not scope.root.is_dir():
        return []
    results: list[dict[str, Any]] = []
    for path in sorted(
        scope.root.rglob("*.md"), key=lambda p: p.relative_to(scope.root).as_posix()
    ):
        if not path.is_file():
            continue
        rel = path.relative_to(scope.root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        rel_posix = rel.as_posix()
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
            fm, _ = parse_frontmatter(raw)
            title = fm.title if (fm and fm.title) else ""
            if not title:
                for line in raw.splitlines():
                    sline = line.strip()
                    if sline.startswith("# "):
                        title = sline[2:].strip()
                        break
                    if sline.startswith("## "):
                        title = sline[3:].strip()
                        break
            if not title:
                title = path.stem
            results.append(
                {
                    "path": rel_posix,
                    "title": title,
                    "type": fm.type if fm else "general",
                    "scope": scope.kind,
                }
            )
        except OSError:
            continue
    return results


async def list_pages(scope: MemoryScope) -> list[dict[str, Any]]:
    """List memory page summaries for scope off the event loop."""
    return await asyncio.to_thread(_list_pages_sync, scope)
