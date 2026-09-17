"""MemoryManager process-level singleton coordinating caching, single-flight compilation, and reconciliation."""

from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path

from loguru import logger

from app.services.memory.context import (
    compile_global_snapshot,
    compile_workspace_snapshot,
    compose_memory_context,
    search_memory,
)
from app.services.memory.lint import lint_memory_scope
from app.services.memory.models import (
    GlobalMemorySnapshot,
    LintFinding,
    MemoryContextSnapshot,
    MemoryScope,
    ScopeState,
    WorkspaceMemorySnapshot,
)
from app.services.memory.store import global_memory_root


def _get_scope_signature_sync(root: Path) -> tuple[tuple[str, int, int, int, int], ...]:
    """Compute deterministic full-scope signature across all .md files."""
    if not root.is_dir():
        return ()
    items: list[tuple[str, int, int, int, int]] = []
    for path in sorted(root.rglob("*.md"), key=lambda p: p.as_posix()):
        if path.is_file():
            rel_posix = path.relative_to(root).as_posix()
            try:
                st = os.lstat(path)
                items.append(
                    (
                        rel_posix,
                        st.st_size,
                        st.st_mtime_ns,
                        getattr(st, "st_ctime_ns", 0),
                        st.st_ino,
                    )
                )
            except OSError:
                continue
    return tuple(items)


class MemoryManager:
    """Process-level coordinator for memory scope snapshots, single-flight compilation, and reconciliation."""

    def __init__(self) -> None:
        self._scopes: dict[str, ScopeState] = {}

    def _get_state(self, scope_key: str) -> ScopeState:
        if scope_key not in self._scopes:
            self._scopes[scope_key] = ScopeState()
        return self._scopes[scope_key]

    def invalidate(self, scope_key: str) -> None:
        """Invalidate the cached snapshot for scope_key, bumping its epoch before clearing."""
        state = self._get_state(scope_key)
        state.epoch += 1
        state.snapshot = None
        logger.debug(
            "memory_scope_invalidated scope={} epoch={}", scope_key, state.epoch
        )

    def invalidate_by_path(self, path: Path) -> None:
        """Invalidate the memory scope containing the given path."""
        try:
            resolved = path.resolve()
            g_root = global_memory_root()
            if resolved.is_relative_to(g_root):
                self.invalidate("global")
                return
            # Check for workspace memory root: {ws}/.openagentd/memory/
            # Traverse parents to find .openagentd/memory
            for parent in (resolved, *resolved.parents):
                if parent.name == "memory" and parent.parent.name == ".openagentd":
                    canonical_root = parent.resolve()
                    self.invalidate(f"workspace:{canonical_root.as_posix()}")
                    return
        except Exception as exc:
            logger.warning(
                "memory_invalidate_by_path_failed path={} error={}", path, exc
            )

    async def get_global_snapshot(self, scope: MemoryScope) -> GlobalMemorySnapshot:
        """Return the compiled GlobalMemorySnapshot, single-flight compiled off-loop."""
        state = self._get_state(scope.scope_key)
        if isinstance(state.snapshot, GlobalMemorySnapshot):
            return state.snapshot

        async with state.compile_lock:
            if isinstance(state.snapshot, GlobalMemorySnapshot):
                return state.snapshot
            while True:
                start_epoch = state.epoch
                candidate = await asyncio.to_thread(compile_global_snapshot, scope)
                if state.epoch != start_epoch:
                    # A mutation occurred during compilation; retry
                    continue
                state.snapshot = candidate
                return candidate

    async def get_workspace_snapshot(
        self, scope: MemoryScope
    ) -> WorkspaceMemorySnapshot:
        """Return the compiled WorkspaceMemorySnapshot, single-flight compiled off-loop."""
        state = self._get_state(scope.scope_key)
        if isinstance(state.snapshot, WorkspaceMemorySnapshot):
            return state.snapshot

        async with state.compile_lock:
            if isinstance(state.snapshot, WorkspaceMemorySnapshot):
                return state.snapshot
            while True:
                start_epoch = state.epoch
                candidate = await asyncio.to_thread(compile_workspace_snapshot, scope)
                if state.epoch != start_epoch:
                    # A mutation occurred during compilation; retry
                    continue
                state.snapshot = candidate
                return candidate

    async def reconcile(
        self,
        scope: MemoryScope,
    ) -> GlobalMemorySnapshot | WorkspaceMemorySnapshot:
        """Reconcile disk changes under single-flight lock, retaining existing snapshot if content unchanged."""
        state = self._get_state(scope.scope_key)
        async with state.compile_lock:
            while True:
                start_epoch = state.epoch
                start_sig = await asyncio.to_thread(
                    _get_scope_signature_sync, scope.root
                )
                if scope.kind == "global":
                    candidate: (
                        GlobalMemorySnapshot | WorkspaceMemorySnapshot
                    ) = await asyncio.to_thread(compile_global_snapshot, scope)
                else:
                    candidate = await asyncio.to_thread(
                        compile_workspace_snapshot, scope
                    )
                end_sig = await asyncio.to_thread(_get_scope_signature_sync, scope.root)
                if state.epoch != start_epoch or end_sig != start_sig:
                    continue

                # Check if existing cached snapshot has identical content
                existing = state.snapshot
                if (
                    existing is not None
                    and isinstance(existing, type(candidate))
                    and candidate == existing
                ):
                    # Retain existing object identity to keep downstream sessions stable
                    return existing

                state.snapshot = candidate
                return candidate

    async def get_context(
        self,
        global_scope: MemoryScope,
        workspace_scope: MemoryScope | None,
        *,
        is_chat: bool,
    ) -> MemoryContextSnapshot:
        """Compose current memory context into an immutable MemoryContextSnapshot."""
        global_snap = await self.get_global_snapshot(global_scope)
        ws_snap = (
            await self.get_workspace_snapshot(workspace_scope)
            if workspace_scope
            else None
        )

        content = compose_memory_context(
            global_snap,
            ws_snap,
            is_chat=is_chat,
            global_root=global_scope.root,
            workspace_root=workspace_scope.root if workspace_scope else None,
        )
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        return MemoryContextSnapshot(
            global_snapshot=global_snap,
            workspace_snapshot=ws_snap,
            content=content,
            content_hash=content_hash,
        )

    async def search(
        self,
        scopes: list[MemoryScope],
        query: str,
    ) -> list[dict[str, str]]:
        """Execute deterministic search off the event loop."""
        return await asyncio.to_thread(search_memory, scopes, query)

    async def lint(
        self,
        scope: MemoryScope,
        global_scope: MemoryScope | None = None,
    ) -> list[LintFinding]:
        """Execute deterministic lint suite off the event loop."""
        return await asyncio.to_thread(lint_memory_scope, scope, global_scope)


_global_memory_manager: MemoryManager | None = None


def get_memory_manager() -> MemoryManager:
    """Return the process-level loop-local MemoryManager singleton."""
    global _global_memory_manager
    if _global_memory_manager is None:
        _global_memory_manager = MemoryManager()
    return _global_memory_manager


def reset_memory_manager() -> None:
    """Reset the singleton instance (used in tests for clean loop isolation)."""
    global _global_memory_manager
    _global_memory_manager = None
