"""REST API endpoints for persistent Markdown memory management."""

from __future__ import annotations

from typing import Literal
from fastapi import APIRouter, Header, HTTPException, Query, Response, status
from loguru import logger

from app.api.schemas.memory import (
    MemoryFileResponse,
    MemoryFindingItem,
    MemoryLintReport,
    MemoryPageSummary,
    MemorySearchResponse,
    MemorySearchResult,
    MemoryTreeResponse,
    MemoryWriteRequest,
)
from app.core.chat_workspace import is_chat_workspace
from app.services.memory import get_memory_manager
from app.services.memory.models import MemoryScope
from app.services.memory.store import (
    MemoryContainmentError,
    MemoryPageNotFoundError,
    MemoryPayloadTooLargeError,
    MemoryPreconditionFailedError,
    MemoryPreconditionRequiredError,
    MemoryScopeAuthorizationError,
    delete_page,
    global_memory_root,
    list_pages,
    read_page,
    resolve_memory_scopes,
    workspace_memory_root,
    write_page,
)

router = APIRouter(prefix="/memory", tags=["memory"])


def _resolve_target_scope(scope_name: str, workspace: str | None) -> MemoryScope:
    if scope_name == "global":
        return MemoryScope(kind="global", root=global_memory_root())
    if scope_name == "workspace":
        if not workspace:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Workspace query parameter is required for workspace scope.",
            )
        if is_chat_workspace(workspace):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Workspace memory is forbidden in Chat mode.",
            )
        try:
            ws_root = workspace_memory_root(workspace)
            return MemoryScope(kind="workspace", root=ws_root)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid workspace: {exc}",
            )
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Invalid scope: {scope_name}. Must be 'global' or 'workspace'.",
    )


def _handle_memory_error(exc: Exception) -> None:
    if isinstance(exc, MemoryPreconditionRequiredError):
        raise HTTPException(
            status_code=status.HTTP_428_PRECONDITION_REQUIRED, detail=str(exc)
        )
    if isinstance(exc, MemoryPreconditionFailedError):
        raise HTTPException(
            status_code=status.HTTP_412_PRECONDITION_FAILED, detail=str(exc)
        )
    if isinstance(exc, MemoryPageNotFoundError):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    if isinstance(exc, MemoryPayloadTooLargeError):
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(exc)
        )
    if isinstance(exc, MemoryScopeAuthorizationError):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc))
    if isinstance(exc, (MemoryContainmentError, ValueError)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    logger.error("unhandled_memory_error error={}", exc)
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)
    )


@router.get("/tree", response_model=MemoryTreeResponse)
async def get_tree(
    scope: Literal["global", "workspace"] = Query("global"),
    workspace: str | None = Query(None),
) -> MemoryTreeResponse:
    """Reconcile scope and list memory pages with lightweight metadata."""
    target_scope = _resolve_target_scope(scope, workspace)
    manager = get_memory_manager()
    try:
        await manager.reconcile(target_scope)
        raw_pages = await list_pages(target_scope)
        pages = [
            MemoryPageSummary(
                path=p["path"],
                title=p["title"],
                type=p["type"],
                scope=p["scope"],
            )
            for p in raw_pages
        ]
        return MemoryTreeResponse(pages=pages)
    except Exception as exc:
        _handle_memory_error(exc)
        return MemoryTreeResponse(pages=[])


@router.get("/file", response_model=MemoryFileResponse)
async def get_file(
    path: str = Query(
        ...,
        description="Scope-relative POSIX path to memory file (e.g. 'topics/auth.md')",
    ),
    scope: Literal["global", "workspace"] = Query("global"),
    workspace: str | None = Query(None),
    response: Response = Response(),
) -> MemoryFileResponse:
    """Read authoritative memory page from disk and return content with ETag header."""
    target_scope = _resolve_target_scope(scope, workspace)
    try:
        page = await read_page(target_scope, path)
        if response is not None:
            response.headers["ETag"] = page.etag
        return MemoryFileResponse(
            path=page.path,
            content=page.content,
            etag=page.etag,
            scope=target_scope.kind,
            frontmatter=page.frontmatter.model_dump() if page.frontmatter else None,
        )
    except Exception as exc:
        _handle_memory_error(exc)
        raise  # Should not be reached


@router.put("/file", response_model=MemoryFileResponse)
async def put_file(
    payload: MemoryWriteRequest,
    path: str = Query(..., description="Scope-relative POSIX path to memory file"),
    scope: Literal["global", "workspace"] = Query("global"),
    workspace: str | None = Query(None),
    if_match: str | None = Header(None),
    response: Response = Response(),
) -> MemoryFileResponse:
    """Atomically write a memory page under path lock with If-Match precondition."""
    target_scope = _resolve_target_scope(scope, workspace)
    try:
        page, _is_no_op = await write_page(
            target_scope, path, payload.content, if_match=if_match
        )
        if response is not None:
            response.headers["ETag"] = page.etag
        return MemoryFileResponse(
            path=page.path,
            content=page.content,
            etag=page.etag,
            scope=target_scope.kind,
            frontmatter=page.frontmatter.model_dump() if page.frontmatter else None,
        )
    except Exception as exc:
        _handle_memory_error(exc)
        raise


@router.delete("/file")
async def delete_file(
    path: str = Query(..., description="Scope-relative POSIX path to memory file"),
    scope: Literal["global", "workspace"] = Query("global"),
    workspace: str | None = Query(None),
    if_match: str | None = Header(None),
) -> dict[str, str]:
    """Delete a memory page under path lock with If-Match precondition."""
    target_scope = _resolve_target_scope(scope, workspace)
    try:
        await delete_page(target_scope, path, if_match=if_match)
        return {"status": "deleted", "path": path}
    except Exception as exc:
        _handle_memory_error(exc)
        raise


@router.get("/search", response_model=MemorySearchResponse)
async def search_files(
    query: str = Query(..., min_length=1),
    workspace: str | None = Query(None),
) -> MemorySearchResponse:
    """Deterministic search across active memory scopes."""
    global_scope, workspace_scope = resolve_memory_scopes(workspace)
    scopes = [global_scope]
    if workspace_scope is not None:
        scopes.append(workspace_scope)
    manager = get_memory_manager()
    results = await manager.search(scopes, query)
    return MemorySearchResponse(
        results=[
            MemorySearchResult(
                scope="workspace" if r["scope"] == "workspace" else "global",
                path=r["path"],
                title=r["title"],
            )
            for r in results
        ]
    )


@router.post("/lint", response_model=MemoryLintReport)
async def lint_files(
    workspace: str | None = Query(None),
) -> MemoryLintReport:
    """Run deterministic linter across active memory scopes."""
    global_scope, workspace_scope = resolve_memory_scopes(workspace)
    manager = get_memory_manager()
    findings = list(await manager.lint(global_scope))
    if workspace_scope is not None:
        findings.extend(await manager.lint(workspace_scope, global_scope=global_scope))
    return MemoryLintReport(
        findings=[
            MemoryFindingItem(
                code=f.code,
                path=f.path,
                message=f.message,
            )
            for f in findings
        ]
    )
