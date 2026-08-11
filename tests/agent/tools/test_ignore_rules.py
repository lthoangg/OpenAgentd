"""Tests for the shared gitignore matcher behind grep, glob, and the API listing.

The matcher used to be a thin ``fnmatch`` wrapper, which gets two things wrong
in opposite directions:

  - ``fnmatch``'s ``*`` happily crosses ``/``, so ``docs/*.tmp`` swallowed
    ``docs/guide/deep/notes.tmp`` — files git shows became invisible to grep,
    glob, and the file picker.
  - directory-only patterns were anchored to the root, so ``build/`` never
    matched ``web/build/`` — files git ignores were searched anyway.

Reference semantics: ``gitignore(5)``. Verified against real ``git
check-ignore`` behaviour.
"""

from __future__ import annotations

import pytest

from app.agent.tools.builtin.filesystem._ignore import (
    is_gitignored,
    load_gitignore_rules,
    matches_gitignore_pattern,
)


class TestWildcardsDoNotCrossSlash:
    @pytest.mark.parametrize(
        "pattern,rel,expected",
        [
            # A single ``*`` stops at a path separator.
            ("docs/*.tmp", "docs/scratch.tmp", True),
            ("docs/*.tmp", "docs/guide/deep/notes.tmp", False),
            ("docs/*", "docs/readme.md", True),
            # Verified with `git check-ignore`: `docs/*` matches the *directory*
            # `docs/guide`, and ignoring a directory ignores everything under
            # it — so the nested file is ignored even though `*` never crossed a
            # slash. Contrast with `docs/*.tmp` above, which cannot match
            # `docs/guide` and therefore leaves the deep file visible.
            ("docs/*", "docs/guide/readme.md", True),
            # ``?`` is equally confined to one component.
            ("src/?.py", "src/a.py", True),
            ("src/?.py", "src/a/b.py", False),
            # ``**`` is the only wildcard that spans directories.
            ("docs/**/*.tmp", "docs/guide/deep/notes.tmp", True),
            ("**/logs", "a/b/logs", True),
            ("logs/**", "logs/a/b/c.txt", True),
        ],
    )
    def test_wildcard_scope(self, pattern: str, rel: str, expected: bool):
        assert matches_gitignore_pattern(pattern, rel, is_dir=False) is expected


class TestPatternAnchoring:
    def test_basename_pattern_matches_at_any_depth(self):
        assert matches_gitignore_pattern("*.log", "deep/nested/app.log", is_dir=False)

    def test_slash_pattern_is_anchored_to_the_root(self):
        assert matches_gitignore_pattern("src/app.py", "src/app.py", is_dir=False)
        assert not matches_gitignore_pattern(
            "src/app.py", "vendor/src/app.py", is_dir=False
        )

    def test_leading_slash_anchors_to_the_root(self):
        assert matches_gitignore_pattern("/build", "build", is_dir=True)
        assert not matches_gitignore_pattern("/build", "web/build", is_dir=True)

    def test_directory_only_pattern_matches_at_any_depth(self):
        """``build/`` is unanchored — git ignores ``web/build/`` too."""
        assert matches_gitignore_pattern("build/", "build", is_dir=True)
        assert matches_gitignore_pattern("build/", "web/build", is_dir=True)
        assert matches_gitignore_pattern("build/", "web/build/out.js", is_dir=False)

    def test_directory_only_pattern_never_matches_a_file_of_that_name(self):
        assert not matches_gitignore_pattern("build/", "build", is_dir=False)


class TestNegation:
    def test_last_matching_rule_wins(self, tmp_path):
        (tmp_path / ".gitignore").write_text(
            "*.log\n!keep.log\n",
            encoding="utf-8",
        )
        rules = load_gitignore_rules(tmp_path)
        assert is_gitignored("app.log", is_dir=False, rules=rules)
        assert not is_gitignored("keep.log", is_dir=False, rules=rules)

    def test_reinclusion_of_a_subdirectory(self, tmp_path):
        (tmp_path / ".gitignore").write_text(
            ".openagentd/*\n!.openagentd/skills/\n",
            encoding="utf-8",
        )
        rules = load_gitignore_rules(tmp_path)
        assert is_gitignored(".openagentd/data", is_dir=True, rules=rules)
        assert not is_gitignored(".openagentd/skills", is_dir=True, rules=rules)


class TestRuleLoading:
    def test_comments_and_blank_lines_are_ignored(self, tmp_path):
        (tmp_path / ".gitignore").write_text(
            "\n# a comment\n\n*.log\n",
            encoding="utf-8",
        )
        assert load_gitignore_rules(tmp_path) == [("*.log", False)]

    def test_missing_file_yields_no_rules(self, tmp_path):
        assert load_gitignore_rules(tmp_path) == []

    def test_escaped_bang_is_not_a_negation(self, tmp_path):
        r"""``\!important.txt`` ignores a file literally named ``!important.txt``."""
        (tmp_path / ".gitignore").write_text("\\!important.txt\n", encoding="utf-8")
        rules = load_gitignore_rules(tmp_path)
        assert rules == [("!important.txt", False)]
        assert is_gitignored("!important.txt", is_dir=False, rules=rules)
