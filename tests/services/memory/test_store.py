from __future__ import annotations

from pathlib import Path

import pytest

from app.services.memory.store import (
    MAX_MEMORY_PAGE_BYTES,
    MemoryContainmentError,
    MemoryPageNotFoundError,
    MemoryPayloadTooLargeError,
    MemoryPreconditionFailedError,
    MemoryPreconditionRequiredError,
    assert_authorized_memory_path,
    assert_no_memory_symlinks,
    delete_page,
    read_page,
    resolve_memory_scopes,
    write_page,
)


@pytest.fixture
def scopes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_CONFIG_DIR", str(config_dir)
    )
    ws_dir = tmp_path / "workspace"
    ws_dir.mkdir()
    global_scope, ws_scope = resolve_memory_scopes(str(ws_dir), is_chat=False)
    assert ws_scope is not None
    return global_scope, ws_scope, ws_dir


@pytest.mark.asyncio
async def test_write_and_read_page(scopes):
    g_scope, ws_scope, _ = scopes
    page, is_no_op = await write_page(
        ws_scope,
        "auth.md",
        "---\ntitle: Authentication\n---\nUse HMAC-SHA256 tokens.",
    )
    assert not is_no_op
    assert page.path == "auth.md"
    assert page.frontmatter is not None
    assert page.frontmatter.title == "Authentication"
    assert page.etag.startswith('"') and page.etag.endswith('"')

    read = await read_page(ws_scope, "auth.md")
    assert read.content == page.content
    assert read.etag == page.etag


@pytest.mark.asyncio
async def test_no_op_write(scopes):
    _, ws_scope, _ = scopes
    content = "---\ntitle: DB\n---\nSQLite database."
    page1, is_no_op1 = await write_page(ws_scope, "db.md", content)
    assert not is_no_op1

    # Writing identical content with valid If-Match returns is_no_op=True
    page2, is_no_op2 = await write_page(ws_scope, "db.md", content, if_match=page1.etag)
    assert is_no_op2
    assert page2.etag == page1.etag


@pytest.mark.asyncio
async def test_etag_preconditions(scopes):
    _, ws_scope, _ = scopes
    content = "Initial content"
    page1, _ = await write_page(ws_scope, "test.md", content)

    # Missing If-Match on existing file -> 428
    with pytest.raises(MemoryPreconditionRequiredError):
        await write_page(ws_scope, "test.md", "New content", if_match=None)

    # Stale If-Match -> 412
    with pytest.raises(MemoryPreconditionFailedError):
        await write_page(ws_scope, "test.md", "New content", if_match='"wrong-etag"')

    # Correct If-Match -> succeeds
    page2, is_no_op = await write_page(
        ws_scope, "test.md", "Updated content", if_match=page1.etag
    )
    assert not is_no_op
    assert page2.etag != page1.etag


@pytest.mark.asyncio
async def test_delete_page_preconditions(scopes):
    _, ws_scope, _ = scopes
    page, _ = await write_page(ws_scope, "to_delete.md", "Delete me")

    # Missing If-Match -> 428
    with pytest.raises(MemoryPreconditionRequiredError):
        await delete_page(ws_scope, "to_delete.md", if_match=None)

    # Mismatched If-Match -> 412
    with pytest.raises(MemoryPreconditionFailedError):
        await delete_page(ws_scope, "to_delete.md", if_match='"wrong"')

    # Correct If-Match -> deleted
    await delete_page(ws_scope, "to_delete.md", if_match=page.etag)
    with pytest.raises(MemoryPageNotFoundError):
        await read_page(ws_scope, "to_delete.md")


@pytest.mark.asyncio
async def test_oversized_page_rejected(scopes):
    _, ws_scope, _ = scopes
    giant_content = "a" * (MAX_MEMORY_PAGE_BYTES + 10)
    with pytest.raises(MemoryPayloadTooLargeError):
        await write_page(ws_scope, "giant.md", giant_content)


@pytest.mark.asyncio
async def test_path_containment_and_symlinks(scopes):
    _, ws_scope, ws_dir = scopes
    # Traversal rejected
    with pytest.raises(MemoryContainmentError):
        await read_page(ws_scope, "../outside.md")

    with pytest.raises(MemoryContainmentError):
        await write_page(ws_scope, "foo.txt", "not md")

    # Symlink rejected
    outside_file = ws_dir / "secret.md"
    outside_file.write_text("secret")
    symlink_file = ws_scope.root / "sym.md"
    ws_scope.root.mkdir(parents=True, exist_ok=True)
    symlink_file.symlink_to(outside_file)

    with pytest.raises(MemoryContainmentError):
        assert_no_memory_symlinks(symlink_file)


@pytest.mark.asyncio
async def test_chat_workspace_isolation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    home_dir = tmp_path / "home"
    home_dir.mkdir()
    monkeypatch.setattr(
        "app.core.config.settings.OPENAGENTD_CONFIG_DIR", str(tmp_path / "config")
    )
    g_scope, ws_scope = resolve_memory_scopes(str(home_dir), is_chat=True)
    assert g_scope.kind == "global"
    assert ws_scope is None

    # assert_authorized_memory_path in chat rejects workspace paths
    fake_ws_path = home_dir / ".openagentd" / "memory" / "note.md"
    with pytest.raises(Exception):
        assert_authorized_memory_path(
            fake_ws_path, active_workspace=str(home_dir), is_chat=True
        )
