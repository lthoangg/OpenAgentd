"""Contract test for the glob tool's path matching.

``glob(match="path")`` used to delegate traversal to ``Path.glob``, which cannot
prune: it enumerated ``node_modules``, ``.venv`` and ``.git`` in full and threw
the results away afterwards (~3s at this repo's root). Traversal is now a pruned
``os.walk`` with ``PurePath.full_match`` doing the matching.

That is a rewrite of a documented tool contract, so this module pins the
semantics that must not drift: which patterns match which files, for every glob
feature the tool advertises. Expectations were captured from ``Path.glob`` before
the rewrite — see ``EXPECTED`` — so a regression shows up as a diff against
pathlib's own behaviour rather than against a hand-written guess.
"""

from __future__ import annotations

import pytest

from app.agent.sandbox import SandboxConfig, set_sandbox, _sandbox_ctx
from app.agent.errors import ToolExecutionError
from app.agent.tools.builtin.filesystem import glob_files

# Tree layout used by every case below.
_TREE = (
    "a.py",
    "README.md",
    "src/b.py",
    "src/.e.py",
    "src/deep/c.py",
    "src/deep/notes.txt",
    "src/nested/deeper/d.py",
    ".hidden/h.py",
    "pkg/mod.pyi",
)

# pattern -> sorted relative paths, as produced by ``Path.glob`` + the tool's
# own filters before the traversal rewrite.
EXPECTED: dict[str, list[str]] = {
    "**/*.py": [
        "a.py",
        "src/b.py",
        "src/deep/c.py",
        "src/nested/deeper/d.py",
        # Dot entries are searchable but ranked last.
        ".hidden/h.py",
        "src/.e.py",
    ],
    "*.py": ["a.py"],
    "src/*.py": ["src/b.py", "src/.e.py"],
    "src/**/*.py": ["src/b.py", "src/deep/c.py", "src/nested/deeper/d.py", "src/.e.py"],
    "src/*/*.py": ["src/deep/c.py"],
    "**/*.txt": ["src/deep/notes.txt"],
    "?.py": ["a.py"],
    "[ab].py": ["a.py"],
    "**/*.py[i]": ["pkg/mod.pyi"],
    "src/deep/*": ["src/deep/c.py", "src/deep/notes.txt"],
    # A trailing slash matches directories only, and the tool returns files.
    # ``PurePath`` normalises the slash away, so ``**/`` silently became ``**``
    # and matched every file in the tree until this was handled explicitly.
    "src/": [],
    "**/": [],
    "*.rs": [],
}


@pytest.fixture
def tree(tmp_path):
    for rel in _TREE:
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x")
    token = set_sandbox(SandboxConfig(workspace=str(tmp_path), denied_patterns=[]))
    yield tmp_path
    _sandbox_ctx.reset(token)


def _results(output: str) -> list[str]:
    if output.startswith("No files matching"):
        return []
    return output.splitlines()


@pytest.mark.asyncio
@pytest.mark.parametrize("pattern", list(EXPECTED))
async def test_path_matching_matches_the_documented_contract(pattern, tree):
    result = await glob_files.arun(pattern=pattern, directory=".")
    assert _results(result) == EXPECTED[pattern]


@pytest.mark.asyncio
async def test_ordinary_paths_are_ranked_before_dot_paths(tree):
    """Ranking, not raw alphabetical order — a dot directory must never crowd
    ordinary results out of ``max_results``."""
    result = await glob_files.arun(pattern="**/*.py", directory=".", max_results=4)
    assert _results(result) == [
        "a.py",
        "src/b.py",
        "src/deep/c.py",
        "src/nested/deeper/d.py",
    ]


@pytest.mark.asyncio
async def test_name_mode_matches_basenames_at_any_depth(tree):
    result = await glob_files.arun(pattern="*.py", directory=".", match="name")
    assert _results(result) == [
        "a.py",
        "src/b.py",
        "src/deep/c.py",
        "src/nested/deeper/d.py",
        ".hidden/h.py",
        "src/.e.py",
    ]


@pytest.mark.asyncio
async def test_matching_is_case_sensitive(tree):
    """``Path.glob`` on a case-insensitive filesystem matched ``A.PY`` against
    ``a.py`` and echoed the *pattern* back as the hit — reporting a filename
    that does not exist. Matching real entries makes glob agree with grep's
    ``include`` filter and behave the same on every platform.
    """
    assert _results(await glob_files.arun(pattern="A.PY", directory=".")) == []
    assert _results(await glob_files.arun(pattern="a.py", directory=".")) == ["a.py"]


@pytest.mark.asyncio
async def test_parent_traversal_patterns_are_rejected(tree):
    """``../`` in a *pattern* used to enumerate outside the search root and
    report paths like ``../outside/secrets.txt``. Point ``directory`` elsewhere
    instead — that argument is validated by the sandbox.
    """
    outside = tree.parent / "outside"
    outside.mkdir(exist_ok=True)
    (outside / "secrets.txt").write_text("SECRET")

    with pytest.raises(ToolExecutionError, match="directory"):
        await glob_files.arun(pattern="../outside/*", directory=".")


@pytest.mark.asyncio
async def test_absolute_patterns_are_rejected(tree):
    with pytest.raises(ToolExecutionError, match="relative"):
        await glob_files.arun(pattern=str(tree / "*.py"), directory=".")


@pytest.mark.asyncio
async def test_noise_and_gitignored_trees_are_never_walked(tree, monkeypatch):
    """The point of the rewrite: pruning happens during traversal, not after."""
    (tree / ".gitignore").write_text("build/\n", encoding="utf-8")
    for rel in ("node_modules/pkg/index.js", "build/out.js", ".git/hooks/pre-commit"):
        path = tree / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x")

    walked: list[str] = []
    real_walk = __import__("os").walk

    def spy(top, *args, **kwargs):
        for root, dirs, files in real_walk(top, *args, **kwargs):
            walked.append(root)
            yield root, dirs, files

    monkeypatch.setattr("app.agent.tools.builtin.filesystem.glob.os.walk", spy)

    await glob_files.arun(pattern="**/*", directory=".")

    assert not any("node_modules" in path for path in walked)
    assert not any("/build" in path for path in walked)
    assert not any("/.git" in path.rstrip("/") for path in walked)
    assert any(path.endswith("src") for path in walked)
