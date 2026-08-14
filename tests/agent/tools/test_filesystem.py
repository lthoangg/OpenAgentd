"""Tests for app/tools/builtin/filesystem — all filesystem tools."""

from __future__ import annotations

import importlib
from pathlib import Path
from unittest.mock import patch

import pytest

from app.agent.artifacts import session_artifact_dir
from app.agent.errors import ToolArgumentError, ToolExecutionError
from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.state import AgentState
from app.core.config import settings
from app.agent.tools.builtin.filesystem import (
    glob_files,
    grep_files,
    read_file,
)
from app.agent.tools.builtin.filesystem.grep import _grep_files
from app.agent.tools.builtin.filesystem.glob import _glob_files as _search_files


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def sandbox(tmp_path):
    sb = SandboxConfig(workspace=str(tmp_path))
    token = set_sandbox(sb)
    yield sb, tmp_path
    from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

    _sandbox_ctx.reset(token)


@pytest.fixture
def sandbox_workspace(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config = SandboxConfig(workspace=str(workspace))
    set_sandbox(config)
    yield workspace


@pytest.fixture
def workspace(tmp_path):
    """Workspace with sample files for grep/glob tests."""
    sb = SandboxConfig(workspace=str(tmp_path))
    set_sandbox(sb)
    (tmp_path / "hello.py").write_text("def hello():\n    print('hello')\n")
    (tmp_path / "world.py").write_text("def world():\n    return 42\n")
    (tmp_path / "readme.md").write_text("# Project\nThis is a readme.\n")
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "nested.py").write_text("import os\nprint(os.getcwd())\n")
    return tmp_path


# ---------------------------------------------------------------------------
# read_file — integration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_file(sandbox_workspace):
    (sandbox_workspace / "test.txt").write_text("hello world")

    read_content = await read_file.arun(path="test.txt")
    assert read_content == "1: hello world"


@pytest.mark.asyncio
async def test_read_file_not_found(sandbox_workspace):
    with pytest.raises(ToolExecutionError):
        await read_file.arun(path="missing.txt")


@pytest.mark.asyncio
async def test_read_directory_lists_children(sandbox_workspace):
    (sandbox_workspace / "subdir").mkdir()
    (sandbox_workspace / "subdir" / "inner").mkdir()
    (sandbox_workspace / "subdir" / "note.txt").write_text("hi")

    result = await read_file.arun(path="subdir")

    assert "[d] inner/" in result
    assert "[f] note.txt  (2 bytes)" in result


@pytest.mark.asyncio
async def test_read_directory_sorts_dirs_before_files(sandbox_workspace):
    (sandbox_workspace / "zeta").mkdir()
    (sandbox_workspace / "alpha.txt").write_text("a")

    result = await read_file.arun(path=".")

    assert result.index("[d] zeta/") < result.index("[f] alpha.txt")


@pytest.mark.asyncio
async def test_read_empty_directory(sandbox_workspace):
    (sandbox_workspace / "hollow").mkdir()

    result = await read_file.arun(path="hollow")

    assert result == "(empty directory)"


@pytest.mark.asyncio
async def test_read_directory_ignores_offset_and_limit(sandbox_workspace):
    (sandbox_workspace / "dir").mkdir()
    (sandbox_workspace / "dir" / "one.txt").write_text("1")

    result = await read_file.arun(path="dir", offset=5, limit=1)

    assert "[f] one.txt  (1 bytes)" in result


@pytest.mark.asyncio
async def test_read_file_truncation(sandbox_workspace, monkeypatch):
    read_file_module = importlib.import_module(
        "app.agent.tools.builtin.filesystem.read"
    )
    monkeypatch.setattr(read_file_module, "_MAX_READ_BYTES", 5)
    (sandbox_workspace / "big.txt").write_text("ABCDEFGHIJ")
    result = await read_file.arun(path="big.txt")
    assert result == "1: ABCDE"


@pytest.mark.asyncio
async def test_read_file_caps_large_text_for_context(sandbox_workspace, monkeypatch):
    read_file_module = importlib.import_module(
        "app.agent.tools.builtin.filesystem.read"
    )
    monkeypatch.setattr(read_file_module, "_MAX_CONTEXT_CHARS", 10)
    (sandbox_workspace / "material-icons.json").write_text("A" * 50)

    result = await read_file.arun(path="material-icons.json")

    assert result.startswith("1: " + "A" * 7)
    assert "read output truncated for LLM context" in result
    assert "Use offset and limit" in result
    assert len(result) < 250


@pytest.mark.asyncio
async def test_read_file_latin1_fallback(sandbox_workspace):
    (sandbox_workspace / "latin.bin").write_bytes(b"\xff\xfe")
    result = await read_file.arun(path="latin.bin")
    assert result == "1: \xff\xfe"


@pytest.mark.asyncio
async def test_read_file_pagination(sandbox_workspace):
    lines = "\n".join(f"line{i}" for i in range(1, 11))
    (sandbox_workspace / "paged.txt").write_text(lines)
    result = await read_file.arun(path="paged.txt", offset=2, limit=3)
    assert result.startswith("[2-4/10]")
    assert "2: line2" in result
    assert "4: line4" in result
    assert "line5" not in result


@pytest.mark.asyncio
async def test_read_file_numbers_every_line(sandbox_workspace):
    """Line numbers let the model cite locations and drive the lsp tool.

    `patch` strips a leading `N: ` from hunk context, so copying numbered
    output into an envelope still applies cleanly.
    """
    (sandbox_workspace / "plain.txt").write_text("line1\nline2\nline3")

    result = await read_file.arun(path="plain.txt")

    assert result == "1: line1\n2: line2\n3: line3"


@pytest.mark.asyncio
async def test_read_file_numbering_continues_from_offset(sandbox_workspace):
    """Offsets are 1-indexed so callers can pass line numbers from grep."""
    (sandbox_workspace / "paged.txt").write_text("alpha\nbeta\ngamma\ndelta\n")

    result = await read_file.arun(path="paged.txt", offset=3, limit=1)

    assert result == "[3-3/4]\n3: gamma\n"


@pytest.mark.asyncio
async def test_read_file_truncates_absurdly_long_lines(sandbox_workspace):
    """One minified line must not consume the whole context budget."""
    from app.agent.tools.builtin.filesystem.read import _MAX_LINE_CHARS

    (sandbox_workspace / "min.js").write_text("x" * (_MAX_LINE_CHARS + 500))

    result = await read_file.arun(path="min.js")

    assert "line truncated" in result
    assert len(result) < _MAX_LINE_CHARS + 200


@pytest.mark.asyncio
async def test_read_file_keeps_short_lines_intact(sandbox_workspace):
    (sandbox_workspace / "short.txt").write_text("fine\n")

    result = await read_file.arun(path="short.txt")

    assert result == "1: fine\n"


@pytest.mark.asyncio
async def test_read_directory_not_found(sandbox_workspace):
    with pytest.raises(ToolExecutionError):
        await read_file.arun(path="nonexistent_dir")


# ---------------------------------------------------------------------------
# glob (filename-only mode, replaces search_files) — integration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_glob_name_match(sandbox_workspace):
    (sandbox_workspace / "subdir").mkdir()
    (sandbox_workspace / "test1.py").write_text("p1")
    (sandbox_workspace / "subdir" / "test2.py").write_text("p2")
    (sandbox_workspace / "other.txt").write_text("t1")

    result = await glob_files.arun(pattern="*.py", match="name")
    assert "test1.py" in result
    assert "test2.py" in result
    assert "other.txt" not in result


@pytest.mark.asyncio
async def test_glob_name_match_no_match(sandbox_workspace):
    (sandbox_workspace / "other.txt").write_text("hello")
    result = await glob_files.arun(pattern="*.py", match="name")
    assert "No files matching" in result


@pytest.mark.asyncio
async def test_glob_miss_points_at_matching_directory(sandbox_workspace):
    """A pattern matching a directory dead-ended: this tool reports files only.

    Production telemetry showed `components/ToolCall*` returning a bare miss
    twice in a row while `components/ToolCall/` existed, so the miss now names
    the directory and the pattern that would list it.
    """
    nested = sandbox_workspace / "components" / "ToolCall"
    nested.mkdir(parents=True)
    (nested / "display.tsx").write_text("x")

    result = await glob_files.arun(pattern="components/ToolCall*")

    assert "No files matching" in result
    assert "components/ToolCall" in result
    assert "components/ToolCall/**" in result


@pytest.mark.asyncio
async def test_glob_miss_without_matching_directory_stays_terse(sandbox_workspace):
    (sandbox_workspace / "other.txt").write_text("hello")
    result = await glob_files.arun(pattern="nothing/here*")
    assert result.startswith("No files matching")
    assert "use" not in result


# ---------------------------------------------------------------------------
# Sandbox path validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_allows_active_session_artifact_path_only(sandbox_workspace):
    from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

    session_id = "session-read-artifact"
    token = set_sandbox(
        SandboxConfig(workspace=str(sandbox_workspace), session_id=session_id)
    )
    try:
        artifact = (
            session_artifact_dir(session_id) / ".tool_results" / "lead" / "call.txt"
        )
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_text("artifact content", encoding="utf-8")
        other = (
            session_artifact_dir("other-session")
            / ".tool_results"
            / "lead"
            / "call.txt"
        )
        other.parent.mkdir(parents=True, exist_ok=True)
        other.write_text("other content", encoding="utf-8")

        state = AgentState(messages=[], metadata={"session_id": session_id})

        assert (
            await read_file.arun(
                path=str(artifact.resolve()), _injected={"_state": state}
            )
            == "1: artifact content"
        )
        with pytest.raises(ToolExecutionError):
            await read_file.arun(path=str(other.resolve()), _injected={"_state": state})
    finally:
        _sandbox_ctx.reset(token)


@pytest.mark.asyncio
async def test_read_rejects_data_dir_outside_active_session(sandbox_workspace):
    from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

    token = set_sandbox(SandboxConfig(workspace=str(sandbox_workspace), session_id="s"))
    try:
        data_file = session_artifact_dir("s").parent.parent / "openagentd.db"
        data_file.parent.mkdir(parents=True, exist_ok=True)
        data_file.write_text("db bytes", encoding="utf-8")

        with pytest.raises(ToolExecutionError):
            await read_file.arun(path=str(data_file.resolve()))
    finally:
        _sandbox_ctx.reset(token)


@pytest.mark.asyncio
async def test_read_allows_log_paths(sandbox_workspace):
    from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

    token = set_sandbox(SandboxConfig(workspace=str(sandbox_workspace), session_id="s"))
    try:
        # Test-owned filename under the logs allowlist — avoids the live
        # ``app.log`` sink the running logger appends to.
        log_path = (
            Path(settings.OPENAGENTD_STATE_DIR) / "logs" / "app" / "read-test.log"
        )
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("log content", encoding="utf-8")

        assert await read_file.arun(path=str(log_path.resolve())) == "1: log content"
    finally:
        _sandbox_ctx.reset(token)


@pytest.mark.asyncio
async def test_sandbox_validation(sandbox_workspace, tmp_path):
    """Denylist model: paths under denied roots are rejected.

    Under the current sandbox (commit ``b9ed918``), arbitrary out-of-workspace
    paths are *allowed* unless they fall under ``OPENAGENTD_DATA_DIR`` /
    ``STATE_DIR`` / ``CACHE_DIR`` or match a deny-pattern.  This test
    exercises the denied-root branch by pointing the sandbox at a temp
    directory and trying to write into it.
    """
    denied = tmp_path / "denied_root"
    denied.mkdir()
    set_sandbox(
        SandboxConfig(
            workspace=str(sandbox_workspace),
            denied_roots=[denied],
            denied_patterns=[],
        )
    )

    # Reading a non-existent relative path still fails (FileNotFoundError
    # → ToolExecutionError) — verifies the tool surface still raises.
    with pytest.raises(ToolExecutionError):
        await read_file.arun(path="missing.txt")

    # Reading inside a denied root is rejected by the sandbox itself.
    with pytest.raises(ToolExecutionError):
        await read_file.arun(path=str(denied / "secret.txt"))


# ---------------------------------------------------------------------------
# _search_files: internal unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_glob_name_not_a_directory_raises(sandbox):
    sb, tmp_path = sandbox
    f = tmp_path / "not_a_dir.txt"
    f.write_text("content")
    with pytest.raises(NotADirectoryError, match="Not a directory"):
        await _search_files("*.txt", directory="not_a_dir.txt", match="name")


@pytest.mark.asyncio
async def test_glob_name_non_recursive_via_path_match(sandbox):
    sb, tmp_path = sandbox
    (tmp_path / "root.py").write_text("# root")
    subdir = tmp_path / "sub"
    subdir.mkdir()
    (subdir / "nested.py").write_text("# nested")

    # match='path' with no ** only matches in the root dir (non-recursive)
    result = await _search_files("*.py", directory=".", match="path")
    assert "root.py" in result
    assert "nested.py" not in result


@pytest.mark.asyncio
async def test_glob_name_no_match(sandbox):
    sb, tmp_path = sandbox
    (tmp_path / "only.txt").write_text("text")
    result = await _search_files("*.py", directory=".", match="name")
    assert "No files matching" in result


@pytest.mark.asyncio
async def test_glob_name_limits_to_200_results(sandbox):
    sb, tmp_path = sandbox
    for i in range(205):
        (tmp_path / f"file_{i:03d}.py").write_text("# content")
    result = await _search_files("*.py", directory=".", match="name")
    assert len(result.strip().splitlines()) == 200


# ---------------------------------------------------------------------------
# grep_files — integration
# ---------------------------------------------------------------------------


class TestGrepFiles:
    async def test_grep_finds_matches(self, workspace):
        result = await grep_files.arun(pattern="def ", directory=".")
        assert "hello.py" in result
        assert "world.py" in result

    async def test_grep_with_include_filter(self, workspace):
        result = await grep_files.arun(pattern="print", directory=".", include="*.py")
        assert "hello.py" in result
        assert "nested.py" in result
        assert "readme.md" not in result

    async def test_grep_no_matches(self, workspace):
        result = await grep_files.arun(pattern="ZZZZNOTFOUND", directory=".")
        assert "No matches" in result

    async def test_grep_invalid_regex(self, workspace):
        with pytest.raises(ToolArgumentError):
            await grep_files.arun(pattern="[invalid", directory=".")

    async def test_grep_target_single_file(self, workspace):
        (workspace / "single.py").write_text("def my_func():\n    pass\n")
        result = await grep_files.arun(pattern="my_func", directory="single.py")
        assert "single.py:1: def my_func():" in result

    async def test_grep_nonexistent_target(self, workspace):
        with pytest.raises(ToolExecutionError):
            await grep_files.arun(pattern="test", directory="nonexistent.py")

    async def test_grep_max_results(self, workspace):
        result = await grep_files.arun(pattern=".", directory=".", max_results=2)
        assert len(result.strip().split("\n")) == 2

    async def test_grep_searches_dot_directories_except_vcs_and_caches(self, workspace):
        """Dot-prefixed does not mean uninteresting.

        Blanket-skipping every dot entry made ``.github/workflows``,
        ``.openagentd/skills`` and ``.eslintrc.json`` unsearchable — the agent
        could not find files the user was asking about. Only VCS internals and
        generated caches are skipped now; ``.gitignore`` decides the rest.
        """
        github = workspace / ".github" / "workflows"
        github.mkdir(parents=True)
        (github / "ci.yml").write_text("run: MARKER\n")
        (workspace / ".eslintrc.json").write_text('{"rules": "MARKER"}\n')
        git_dir = workspace / ".git"
        git_dir.mkdir()
        (git_dir / "COMMIT_EDITMSG").write_text("MARKER\n")

        result = await grep_files.arun(pattern="MARKER", directory=".")
        assert "ci.yml" in result
        assert ".eslintrc.json" in result
        assert "COMMIT_EDITMSG" not in result

    async def test_grep_never_reads_sandbox_denied_files(self, tmp_path):
        """Dot files are searchable now, so the sandbox denylist — not the dot
        prefix — is what keeps ``.env`` secrets out of grep output."""
        from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

        sb = SandboxConfig(
            workspace=str(tmp_path), denied_patterns=["**/.env", "**/.env.*"]
        )
        token = set_sandbox(sb)
        try:
            (tmp_path / ".env").write_text("API_KEY=super-secret\n")
            (tmp_path / ".env.local").write_text("API_KEY=also-secret\n")
            (tmp_path / "config.py").write_text("API_KEY = os.environ['API_KEY']\n")

            result = await grep_files.arun(pattern="API_KEY", directory=".")
            assert "config.py" in result
            assert "super-secret" not in result
            assert "also-secret" not in result
            hit_files = {line.split(":", 1)[0] for line in result.splitlines()}
            assert not any(path.endswith((".env", ".env.local")) for path in hit_files)
        finally:
            _sandbox_ctx.reset(token)

    async def test_grep_does_not_leak_denied_files_through_a_symlink(self, tmp_path):
        """A symlink with an innocuous name must not smuggle ``.env`` contents
        into the transcript — the denylist follows the link."""
        from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

        sb = SandboxConfig(workspace=str(tmp_path), denied_patterns=["**/.env"])
        token = set_sandbox(sb)
        try:
            (tmp_path / ".env").write_text("API_KEY=super-secret\n")
            try:
                (tmp_path / "notes.txt").symlink_to(tmp_path / ".env")
            except (OSError, NotImplementedError):
                pytest.skip("symlink creation not supported on this platform")

            result = await grep_files.arun(pattern="API_KEY", directory=".")
            assert "super-secret" not in result
        finally:
            _sandbox_ctx.reset(token)

    async def test_grep_searches_build_output_unless_gitignored(self, workspace):
        """``dist/``/``build/`` hold real content often enough that pruning them
        outright hid tracked files; ``.gitignore`` is the authority."""
        (workspace / "dist").mkdir()
        (workspace / "dist" / "app.js").write_text("var MARKER = 1\n")
        (workspace / "build").mkdir()
        (workspace / "build" / "Dockerfile").write_text("# MARKER\n")

        result = await grep_files.arun(pattern="MARKER", directory=".")
        assert "app.js" in result
        assert "Dockerfile" in result

    async def test_grep_skips_gitignored_build_output(self, workspace):
        (workspace / ".gitignore").write_text("dist/\n", encoding="utf-8")
        (workspace / "dist").mkdir()
        (workspace / "dist" / "app.js").write_text("var MARKER = 1\n")

        result = await grep_files.arun(pattern="MARKER", directory=".")
        assert "No matches" in result

    async def test_grep_finds_nested_files_a_single_star_cannot_match(self, workspace):
        """``docs/*.tmp`` ignores one level; the matcher used to let ``*`` cross
        ``/`` and swallow the whole subtree."""
        (workspace / ".gitignore").write_text("docs/*.tmp\n", encoding="utf-8")
        deep = workspace / "docs" / "guide" / "deep"
        deep.mkdir(parents=True)
        (deep / "notes.tmp").write_text("MARKER\n")
        (workspace / "docs" / "scratch.tmp").write_text("MARKER\n")

        result = await grep_files.arun(pattern="MARKER", directory=".")
        assert "notes.tmp" in result
        assert "scratch.tmp" not in result

    async def test_grep_respects_gitignore_and_common_generated_dirs(self, workspace):
        (workspace / ".gitignore").write_text("ignored.py\n", encoding="utf-8")
        (workspace / "ignored.py").write_text("SECRET_KEY = 'ignored'\n")

        node_modules = workspace / "node_modules"
        node_modules.mkdir()
        (node_modules / "dep.py").write_text("SECRET_KEY = 'dep'\n")

        pycache = workspace / "__pycache__"
        pycache.mkdir()
        (pycache / "cache.py").write_text("SECRET_KEY = 'cache'\n")

        ruff_cache = workspace / ".ruff_cache"
        ruff_cache.mkdir()
        (ruff_cache / "cache.py").write_text("SECRET_KEY = 'ruff'\n")

        pytest_cache = workspace / ".pytest_cache"
        pytest_cache.mkdir()
        (pytest_cache / "cache.py").write_text("SECRET_KEY = 'pytest'\n")

        result = await grep_files.arun(pattern="SECRET_KEY", directory=".")
        assert "No matches" in result
        assert "ruff" not in result
        assert ".pytest_cache" not in result


# ---------------------------------------------------------------------------
# _grep_files: internal unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_grep_files_skips_binary_files(sandbox):
    sb, tmp_path = sandbox
    (tmp_path / "binary.py").write_bytes(b"\xff\xfe invalid utf-8")
    (tmp_path / "good.py").write_text("hello world")
    result = await _grep_files("hello", directory=".")
    assert "good.py" in result
    assert "binary.py" not in result


@pytest.mark.asyncio
async def test_grep_files_skips_oserror_on_read(sandbox):
    sb, tmp_path = sandbox
    (tmp_path / "good.py").write_text("target_pattern")
    (tmp_path / "bad.py").write_text("should be skipped")

    real_read_text = Path.read_text

    def patched_read_text(self, encoding="utf-8"):
        if self.name != "good.py":
            raise OSError("permission denied")
        return real_read_text(self, encoding=encoding)

    with patch.object(Path, "read_text", patched_read_text):
        result = await _grep_files("target_pattern", directory=".")
    assert "good.py" in result


# ---------------------------------------------------------------------------
# glob_files — integration
# ---------------------------------------------------------------------------


class TestGlobFiles:
    async def test_glob_finds_py_files(self, workspace):
        result = await glob_files.arun(pattern="**/*.py", directory=".")
        assert "hello.py" in result
        assert "world.py" in result
        assert "nested.py" in result

    async def test_glob_finds_md_files(self, workspace):
        result = await glob_files.arun(pattern="*.md", directory=".")
        assert "readme.md" in result
        assert ".py" not in result

    async def test_glob_no_matches(self, workspace):
        result = await glob_files.arun(pattern="*.xyz", directory=".")
        assert "No files matching" in result

    async def test_glob_not_a_directory(self, workspace):
        with pytest.raises(ToolExecutionError):
            await glob_files.arun(pattern="*", directory="hello.py")

    async def test_glob_matches_dot_directories_except_vcs_and_caches(self, workspace):
        """Same policy as grep: only VCS internals and caches are hidden."""
        github = workspace / ".github" / "workflows"
        github.mkdir(parents=True)
        (github / "ci.yml").write_text("jobs: {}")
        git_dir = workspace / ".git"
        git_dir.mkdir()
        (git_dir / "config.yml").write_text("x")

        result = await glob_files.arun(pattern="**/*.yml", directory=".")
        assert "ci.yml" in result
        assert ".git/config.yml" not in result

    async def test_glob_ranks_dot_paths_after_ordinary_ones(self, workspace):
        """Dot directories are searchable, but they must not eat the result cap.

        Sorting purely alphabetically put `.openagentd/skills/...` ahead of
        `app/...` in this repo, so `**/*.py` returned tooling instead of source.
        """
        (workspace / ".openagentd" / "skills").mkdir(parents=True)
        (workspace / ".openagentd" / "skills" / "helper.py").write_text("x")
        (workspace / "app").mkdir()
        (workspace / "app" / "main.py").write_text("x")

        result = await glob_files.arun(pattern="**/*.py", directory=".")
        lines = result.splitlines()
        assert any("helper.py" in line for line in lines)
        first_dot = next(i for i, line in enumerate(lines) if line.startswith("."))
        last_plain = max(i for i, line in enumerate(lines) if not line.startswith("."))
        assert last_plain < first_dot

    async def test_glob_matches_dotfiles_by_name(self, workspace):
        (workspace / ".eslintrc.json").write_text("{}")
        result = await glob_files.arun(
            pattern=".eslintrc.json", directory=".", match="name"
        )
        assert ".eslintrc.json" in result

    async def test_glob_never_lists_sandbox_denied_files(self, tmp_path):
        from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

        sb = SandboxConfig(workspace=str(tmp_path), denied_patterns=["**/.env"])
        token = set_sandbox(sb)
        try:
            (tmp_path / ".env").write_text("API_KEY=secret\n")
            (tmp_path / "app.py").write_text("x")
            result = await glob_files.arun(pattern="*", directory=".")
            assert "app.py" in result
            assert ".env" not in result
        finally:
            _sandbox_ctx.reset(token)

    async def test_glob_matches_build_output_unless_gitignored(self, workspace):
        (workspace / "dist").mkdir()
        (workspace / "dist" / "app.js").write_text("x")
        result = await glob_files.arun(pattern="**/*.js", directory=".")
        assert "app.js" in result

    async def test_glob_skips_gitignored_build_output(self, workspace):
        (workspace / ".gitignore").write_text("dist/\n", encoding="utf-8")
        (workspace / "dist").mkdir()
        (workspace / "dist" / "app.js").write_text("x")
        result = await glob_files.arun(pattern="**/*.js", directory=".")
        assert "No files matching" in result

    async def test_glob_max_results(self, workspace):
        for i in range(10):
            (workspace / f"file_{i}.txt").write_text(f"content {i}")
        result = await glob_files.arun(pattern="*.txt", directory=".", max_results=3)
        assert len(result.strip().split("\n")) == 3

    async def test_glob_respects_gitignore_and_common_generated_dirs(self, workspace):
        (workspace / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        (workspace / "ignored.txt").write_text("ignored")

        node_modules = workspace / "node_modules"
        node_modules.mkdir()
        (node_modules / "dep.txt").write_text("dep")

        pycache = workspace / "__pycache__"
        pycache.mkdir()
        (pycache / "cache.txt").write_text("cache")

        ruff_cache = workspace / ".ruff_cache"
        ruff_cache.mkdir()
        (ruff_cache / "cache.txt").write_text("ruff")

        pytest_cache = workspace / ".pytest_cache"
        pytest_cache.mkdir()
        (pytest_cache / "cache.txt").write_text("pytest")

        result = await glob_files.arun(pattern="**/*.txt", directory=".")
        assert "ignored.txt" not in result
        assert "dep.txt" not in result
        assert "cache.txt" not in result
        assert "ruff" not in result
        assert ".pytest_cache" not in result
