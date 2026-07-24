from __future__ import annotations

import pytest

from app.agent.errors import ToolExecutionError
from app.agent.sandbox import SandboxConfig, set_sandbox
from app.agent.tools.builtin.filesystem import patch_file
from app.agent.tools.builtin.filesystem.patch import PatchArgs, _parse_patch


@pytest.fixture
def sandbox_workspace(tmp_path):
    config = SandboxConfig(workspace=str(tmp_path))
    token = set_sandbox(config)
    yield tmp_path
    from app.agent.sandbox import _sandbox_ctx

    _sandbox_ctx.reset(token)


@pytest.mark.asyncio
async def test_patch_add_update_delete(sandbox_workspace):
    (sandbox_workspace / "modify.txt").write_text("line1\nline2\n", encoding="utf-8")
    (sandbox_workspace / "delete.txt").write_text("obsolete\n", encoding="utf-8")

    result = await patch_file.arun(
        patch_text="""*** Begin Patch
*** Add File: nested/new.txt
+created
*** Update File: modify.txt
@@
-line2
+changed
*** Delete File: delete.txt
*** End Patch"""
    )

    assert "Patch applied successfully" in result
    assert '"path":"modify.txt"' in result
    assert '"old_start":2' in result
    assert (sandbox_workspace / "nested" / "new.txt").read_text(
        encoding="utf-8"
    ) == "created\n"
    assert (sandbox_workspace / "modify.txt").read_text(
        encoding="utf-8"
    ) == "line1\nchanged\n"
    assert not (sandbox_workspace / "delete.txt").exists()


@pytest.mark.asyncio
async def test_patch_reports_old_and_new_start_after_prior_line_delta(
    sandbox_workspace,
):
    (sandbox_workspace / "modify.txt").write_text(
        "line1\nline2\nline3\nline4\n",
        encoding="utf-8",
    )

    result = await patch_file.arun(
        patch_text="""*** Begin Patch
*** Update File: modify.txt
@@
-line1
+line1
+inserted
@@
-line4
+changed
*** End Patch"""
    )

    assert '{"old_start":1,"new_start":1}' in result
    assert '{"old_start":4,"new_start":5}' in result
    assert (sandbox_workspace / "modify.txt").read_text(encoding="utf-8") == (
        "line1\ninserted\nline2\nline3\nchanged\n"
    )


@pytest.mark.asyncio
async def test_patch_moves_file(sandbox_workspace):
    source = sandbox_workspace / "old" / "name.txt"
    source.parent.mkdir()
    source.write_text("old content\n", encoding="utf-8")

    await patch_file.arun(
        patch_text="""*** Begin Patch
*** Update File: old/name.txt
*** Move to: renamed/name.txt
@@
-old content
+new content
*** End Patch"""
    )

    assert not source.exists()
    assert (sandbox_workspace / "renamed" / "name.txt").read_text(
        encoding="utf-8"
    ) == "new content\n"


@pytest.mark.asyncio
async def test_patch_preflight_failure_has_no_side_effects(sandbox_workspace):
    patch_text = """*** Begin Patch
*** Add File: created.txt
+hello
*** Update File: missing.txt
@@
-old
+new
*** End Patch"""

    with pytest.raises(ToolExecutionError):
        await patch_file.arun(patch_text=patch_text)

    assert not (sandbox_workspace / "created.txt").exists()


@pytest.mark.asyncio
async def test_patch_rejects_ambiguous_update(sandbox_workspace):
    target = sandbox_workspace / "repeat.txt"
    target.write_text("same\nsame\n", encoding="utf-8")

    with pytest.raises(ToolExecutionError):
        await patch_file.arun(
            patch_text="""*** Begin Patch
*** Update File: repeat.txt
@@
-same
+changed
*** End Patch"""
        )

    assert target.read_text(encoding="utf-8") == "same\nsame\n"


# ── schema description ────────────────────────────────────────────────────────


def test_patch_args_schema_description_contains_format_keywords():
    """patch_text field description must include all format keywords the LLM needs."""
    desc = PatchArgs.model_json_schema()["properties"]["patch_text"]["description"]
    for keyword in (
        "*** Begin Patch",
        "*** End Patch",
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
        "*** Move to:",
        "@@",
    ):
        assert keyword in desc, (
            f"Missing keyword in patch_text description: {keyword!r}"
        )


def test_patch_args_schema_example_is_valid():
    """The embedded example in _PATCH_TEXT_DESCRIPTION must parse without errors."""
    from app.agent.tools.builtin.filesystem.patch import _PATCH_TEXT_DESCRIPTION

    # Extract the example block (everything after 'Example:\n')
    example_marker = "Example:\n"
    idx = _PATCH_TEXT_DESCRIPTION.index(example_marker) + len(example_marker)
    example = _PATCH_TEXT_DESCRIPTION[idx:].strip()
    patches = _parse_patch(example)
    kinds = {p.kind for p in patches}
    assert "add" in kinds
    assert "update" in kinds
    assert "delete" in kinds


# ── parser edge cases ─────────────────────────────────────────────────────────


def test_parse_patch_rejects_missing_envelope():
    with pytest.raises(ValueError, match="Begin Patch"):
        _parse_patch("*** Add File: foo.txt\n+hello")


def test_parse_patch_rejects_unknown_star_header():
    """'*** Add <path>' without 'File:' must raise — not silently skip."""
    with pytest.raises(ValueError, match="file operation header"):
        _parse_patch("*** Begin Patch\n*** Add foo.txt\n+hello\n*** End Patch")


@pytest.mark.asyncio
async def test_patch_handles_markdown_code_fences(sandbox_workspace):
    patch_text = """```patch
*** Begin Patch
*** Add File: fenced.txt
+content in fence
*** End Patch
```"""
    result = await patch_file.arun(patch_text=patch_text)
    assert "Patch applied successfully" in result
    assert (sandbox_workspace / "fenced.txt").read_text(
        encoding="utf-8"
    ) == "content in fence\n"


@pytest.mark.asyncio
async def test_patch_handles_embedded_envelope_with_surrounding_text(sandbox_workspace):
    patch_text = """Here is the patch you requested:

*** Begin Patch
*** Add File: embedded.txt
+hello
*** End Patch

Hope this helps!"""
    result = await patch_file.arun(patch_text=patch_text)
    assert "Patch applied successfully" in result
    assert (sandbox_workspace / "embedded.txt").read_text(encoding="utf-8") == "hello\n"


@pytest.mark.asyncio
async def test_patch_handles_file_without_trailing_newline(sandbox_workspace):
    (sandbox_workspace / "no_newline.txt").write_bytes(b"line1\nline2")
    result = await patch_file.arun(
        patch_text="""*** Begin Patch
*** Update File: no_newline.txt
@@
-line2
+line2_updated
*** End Patch"""
    )
    assert "Patch applied successfully" in result
    assert (sandbox_workspace / "no_newline.txt").read_text(
        encoding="utf-8"
    ) == "line1\nline2_updated"


@pytest.mark.asyncio
async def test_patch_handles_trimmed_line_context_matching(sandbox_workspace):
    (sandbox_workspace / "spaces.txt").write_text(
        "def fn():   \n    return 42   \n", encoding="utf-8"
    )
    result = await patch_file.arun(
        patch_text="""*** Begin Patch
*** Update File: spaces.txt
@@
 def fn():
-    return 42
+    return 100
*** End Patch"""
    )
    assert "Patch applied successfully" in result
    assert (sandbox_workspace / "spaces.txt").read_text(
        encoding="utf-8"
    ) == "def fn():\n    return 100\n"


@pytest.mark.asyncio
async def test_patch_args_supports_parameter_aliases(sandbox_workspace):
    result = await patch_file.arun(
        patch="""*** Begin Patch
*** Add File: alias.txt
+alias content
*** End Patch"""
    )
    assert "Patch applied successfully" in result
    assert (sandbox_workspace / "alias.txt").read_text(
        encoding="utf-8"
    ) == "alias content\n"
