"""Tests for edit_file tool and replace_content fuzzy matchers."""

from __future__ import annotations

import pytest

from app.agent.denied_paths import (
    DeniedPathsConfig as SandboxConfig,
    set_denied_paths as set_sandbox,
)
from app.agent.tools.builtin.filesystem.edit import (
    _edit_file,
    _levenshtein,
    replace_content,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def sandbox(tmp_path):
    sb = SandboxConfig(workspace=str(tmp_path))
    token = set_sandbox(sb)
    yield sb, tmp_path
    from app.agent.denied_paths import _denied_paths_ctx as _sandbox_ctx

    _sandbox_ctx.reset(token)


# ---------------------------------------------------------------------------
# replace_content — unit tests for each matcher
# ---------------------------------------------------------------------------


class TestLevenshtein:
    def test_empty_a(self):
        assert _levenshtein("", "abc") == 3

    def test_empty_b(self):
        assert _levenshtein("abc", "") == 3

    def test_equal(self):
        assert _levenshtein("foo", "foo") == 0

    def test_one_edit(self):
        assert _levenshtein("cat", "bat") == 1

    def test_insertions(self):
        assert _levenshtein("ab", "axb") == 1


class TestExactMatch:
    def test_simple_replace(self):
        result = replace_content("hello world", "world", "there")
        assert result == "hello there"

    def test_multiline_exact(self):
        content = "line1\nline2\nline3"
        result = replace_content(content, "line2\nline3", "new2\nnew3")
        assert result == "line1\nnew2\nnew3"

    def test_identical_still_replaces(self):
        # Me replace_content itself allows identical — _edit_file guards it
        result = replace_content("foo bar", "foo", "foo")
        assert result == "foo bar"

    def test_not_found_raises(self):
        with pytest.raises(ValueError, match="Could not find"):
            replace_content("hello", "xyz", "abc")

    def test_replace_all(self):
        result = replace_content("a b a b a", "a", "x", replace_all=True)
        assert result == "x b x b x"

    def test_multiple_matches_no_replace_all_raises(self):
        with pytest.raises(ValueError, match="multiple matches"):
            replace_content("foo foo", "foo", "bar")


class TestLineTrimmedMatch:
    def test_extra_leading_whitespace(self):
        content = "    def foo():\n        pass\n"
        result = replace_content(
            content, "def foo():\n    pass", "def bar():\n    return 1"
        )
        assert "def bar()" in result

    def test_trailing_whitespace_ignored(self):
        content = "hello   \nworld"
        result = replace_content(content, "hello\nworld", "bye\nearth")
        assert result == "bye\nearth"

    def test_trailing_empty_line_stripped(self):
        # Me line 57 — trailing empty in find_lines is stripped before matching
        content = "alpha\nbeta\n"
        result = replace_content(content, "alpha\nbeta\n", "x\ny\n")
        assert "x\ny" in result

    def test_line_trimmed_with_mixed_indent(self):
        # Me trailing empty stripped — then whitespace normalized across lines (line 56-57)
        content = "  start  \n    middle\n  end  \n"
        result = replace_content(content, "start\n  middle\nend", "a\nb\nc")
        assert "a\nb\nc" in result

    def test_line_trimmed_single_line_with_trailing_empty(self):
        # Me even single line can have trailing empty flag — skip that case (line 56)
        content = "hello\n"
        result = replace_content(content, "hello", "hi")
        assert result == "hi\n"


class TestBlockAnchorMatch:
    def test_single_candidate(self):
        content = "def foo():\n    x = 1\n    return x\n"
        result = replace_content(
            content,
            "def foo():\n    x = 1\n    return x",
            "def foo():\n    x = 2\n    return x",
        )
        assert "x = 2" in result

    def test_multiple_candidates_picks_best(self):
        # Me two blocks with same first/last line — best middle similarity wins (lines 96-119)
        content = (
            "def foo():\n    a = 1\n    return a\ndef foo():\n    b = 9\n    return a\n"
        )
        result = replace_content(
            content,
            "def foo():\n    a = 1\n    return a",
            "def foo():\n    a = 100\n    return a",
        )
        assert "a = 100" in result

    def test_multiple_candidates_no_middle_lines(self):
        # Me two 2-line blocks — no middle to compare, sim=1.0 picks first
        content = "start\nend\nstart\nend\n"
        result = replace_content(
            content,
            "start\nX\nend",
            "start\nY\nend",
        )
        # Me at least one replacement happened
        assert "Y" in result

    def test_block_anchor_trailing_empty_stripped(self):
        # Me trailing empty line in find_lines stripped before anchor search (line 75)
        content = "begin\n    middle\nend\n"
        result = replace_content(content, "begin\n    middle\nend\n", "a\nb\nc\n")
        assert "a\nb\nc" in result

    def test_no_candidates_falls_through(self):
        # Me block anchor finds nothing — falls through to other matchers (line 87)
        content = "line1\nline2\nline3\n"
        result = replace_content(content, "line1\nline2\nline3", "a\nb\nc")
        assert result == "a\nb\nc\n"

    def test_fewer_than_3_lines_skipped(self):
        # Me block anchor requires >= 3 lines — short find falls through to exact
        content = "foo\nbar"
        result = replace_content(content, "foo\nbar", "x\ny")
        assert result == "x\ny"

    def test_multiple_candidates_low_similarity_skipped(self):
        # Me similarity < 0.3 threshold — skips the match (line 112)
        # Me with best_sim < 0.3, block_anchor doesn't yield — falls to next matcher
        content = "X\n    aaa\nY\nX\n    bbb\nY\n"
        # Me line_trimmed will catch this since it compares stripped lines
        result = replace_content(content, "X\n    aaa\nY", "Z\n    CCC\nZ")
        assert "Z" in result

    def test_block_anchor_no_match_at_all(self):
        # Me block anchor doesn't find matching candidates — falls through
        content = "start\nmiddle1\nend\n"
        # Me line_trimmed will handle this
        result = replace_content(content, "start\nmiddle1\nend", "a\nb\nc")
        assert "a\nb\nc" in result

    def test_block_anchor_all_low_similarity_falls_through(self):
        # Me all candidates score < 0.3 — line 112 rejects all, falls through
        content = "A\n    xxx\nB\nA\n    yyy\nB\nA\n    zzz\nB\n"
        # Me line_trimmed will handle this
        result = replace_content(content, "A\n    xxx\nB", "N\n    CCC\nN")
        assert "N" in result


class TestWhitespaceNormalized:
    def test_collapsed_spaces(self):
        content = "x  =  1"
        result = replace_content(content, "x = 1", "x = 2")
        assert "2" in result


class TestIndentationFlexible:
    def test_indented_block(self):
        content = "if True:\n    x = 1\n    y = 2\n"
        # Me search without outer indentation
        result = replace_content(
            content, "    x = 1\n    y = 2", "    x = 10\n    y = 20"
        )
        assert "x = 10" in result
        assert "y = 20" in result


class TestTrimmedBoundary:
    def test_block_match_with_surrounding_whitespace(self):
        # Me find has surrounding spaces — trimmed boundary matches the stripped block (lines 155-160)
        content = "  alpha  \n  beta  \n"
        # Me use a find with same content but surrounded by spaces — trimmed match
        result = replace_content(content, "  alpha  \n  beta  ", "x\ny")
        assert "x\ny" in result

    def test_no_strip_if_already_trimmed(self):
        # Me if find == find.strip() trimmed_boundary is skipped — exact handles it
        content = "hello world"
        result = replace_content(content, "hello", "hi")
        assert result == "hi world"

    def test_trimmed_simple_whitespace_line(self):
        # Me trimmed_boundary finds simple string with surrounding whitespace (line 153-154)
        content = "  simple  "
        result = replace_content(content, "  simple  ", "done")
        assert result == "done"

    def test_trimmed_multiline_with_blank_lines(self):
        # Me trimmed boundary matches multiline block with leading/trailing blank lines (line 159)
        content = "\n  data  \n\n"
        result = replace_content(content, "\n  data  \n", "x")
        assert "x" in result


class TestMultiOccurrence:
    def test_replace_all_via_replace_content(self):
        # Me multi_occurrence with replace_all — exercises line 184
        content = "go\ngo\ngo\n"
        result = replace_content(content, "go", "stop", replace_all=True)
        assert result == "stop\nstop\nstop\n"

    def test_multi_occurrence_not_found_continues(self):
        # Me multi_occurrence yields find, but content.find(search) returns -1 (line 184)
        # Me this only happens if matchers yield something not in content — rare edge case
        content = "foo\nbar\n"
        result = replace_content(content, "foo", "baz", replace_all=True)
        assert result == "baz\nbar\n"

    def test_multi_occurrence_same_search_multiple_times(self):
        # Me multi_occurrence can yield find multiple times for same occurrence (line 168-169)
        content = "x\nx\n"
        result = replace_content(content, "x", "y", replace_all=True)
        assert result == "y\ny\n"

    def test_multi_occurrence_replace_all_first_match(self):
        # Me when replace_all=True, returns immediately (line 187)
        content = "pattern\npattern\n"
        result = replace_content(content, "pattern", "replaced", replace_all=True)
        assert result == "replaced\nreplaced\n"


class TestMultiOccurrenceReplaceAll:
    def test_replace_all_via_multi_occurrence(self):
        # Me multi_occurrence matcher handles replace_all when exact fires first
        content = "cat\ncat\ncat\n"
        result = replace_content(content, "cat", "dog", replace_all=True)
        assert result == "dog\ndog\ndog\n"


class TestReplaceAll:
    def test_replace_all_multiple(self):
        content = "cat\ndog\ncat\n"
        result = replace_content(content, "cat", "bird", replace_all=True)
        assert result.count("bird") == 2
        assert "cat" not in result


class TestEdgeCasesForCoverage:
    def test_line_trimmed_with_find_ending_empty_line(self):
        # Me line 56-57: find_lines ends with empty string (trailing newline)
        # Me this happens when find has final \n: split creates ['...', '']
        content = "one\ntwo\nthree\n"
        # Me find with trailing newline — split creates ['one', 'two', 'three', '']
        result = replace_content(content, "two\nthree\n", "TWO\nTHREE\n")
        assert "TWO" in result

    def test_block_anchor_with_find_ending_empty_line(self):
        # Me line 75-76: _block_anchor also strips trailing empty from find_lines
        content = "start\nmid1\nmid2\nend\n"
        # Me find with trailing newline
        result = replace_content(content, "start\nmid1\nmid2\nend\n", "a\nb\nc\nd\n")
        assert "a\nb\nc\nd" in result

    def test_trimmed_boundary_block_matching_case(self):
        # Me line 159: block.strip() == trimmed matching
        content = "  \n  data  \n  \n"
        # Me find with surrounding whitespace — triggers trimmed_boundary (line 159)
        result = replace_content(content, "  data  ", "result")
        assert "result" in result

    def test_trimmed_boundary_inline_matching(self):
        # Me line 153-154: trimmed string found directly in content
        content = "prefix   data   suffix"
        result = replace_content(content, "   data   ", "X")
        assert "X" in result

    def test_exact_match_single_occurrence(self):
        # Me line 189-190: idx == last_idx check when only one match
        content = "unique_string"
        result = replace_content(content, "unique_string", "replaced")
        assert result == "replaced"

    def test_multiple_matches_detection(self):
        # Me line 189-190: rfind != find means multiple matches — raises
        with pytest.raises(ValueError, match="multiple matches"):
            replace_content("dup dup", "dup", "x")


# ---------------------------------------------------------------------------
# _edit_file tool — integration via sandbox
# ---------------------------------------------------------------------------


class TestEditFileTool:
    async def test_basic_edit(self, sandbox):
        _, tmp_path = sandbox
        f = tmp_path / "sample.txt"
        f.write_text("hello world\n")
        result = await _edit_file("sample.txt", "world", "python")
        assert (
            '@@ openagentd-diff-meta {"path":"sample.txt","old_start":1,"new_start":1}'
            in result
        )
        assert "Edit applied successfully" in result
        assert f"Resolved path: {f}" in result
        assert f.read_text() == "hello python\n"

    async def test_reports_actual_start_line(self, sandbox):
        _, tmp_path = sandbox
        f = tmp_path / "sample.txt"
        f.write_text("a\nb\nhello world\n", encoding="utf-8")
        result = await _edit_file("sample.txt", "world", "python")
        assert '"old_start":3' in result
        assert '"new_start":3' in result

    async def test_file_not_found(self, sandbox):
        with pytest.raises(FileNotFoundError):
            await _edit_file("missing.txt", "x", "y")

    async def test_path_is_directory(self, sandbox):
        _, tmp_path = sandbox
        (tmp_path / "subdir").mkdir()
        with pytest.raises(IsADirectoryError):
            await _edit_file("subdir", "x", "y")

    async def test_identical_strings_raises(self, sandbox):
        _, tmp_path = sandbox
        (tmp_path / "f.txt").write_text("hello")
        with pytest.raises(ValueError, match="identical"):
            await _edit_file("f.txt", "hello", "hello")

    async def test_identical_strings_arun_raises(self, sandbox):
        from app.agent.errors import ToolArgumentError
        from app.agent.tools.builtin.filesystem import edit_file

        with pytest.raises(ToolArgumentError, match="identical"):
            await edit_file.arun(path="f.txt", old_string="hello", new_string="hello")

    async def test_multiline_edit(self, sandbox):
        _, tmp_path = sandbox
        f = tmp_path / "code.py"
        f.write_text("def foo():\n    return 1\n")
        await _edit_file("code.py", "return 1", "return 42")
        assert "return 42" in f.read_text()

    async def test_replace_all_flag(self, sandbox):
        _, tmp_path = sandbox
        f = tmp_path / "rep.txt"
        f.write_text("cat\ncat\ncat\n")
        await _edit_file("rep.txt", "cat", "dog", replace_all=True)
        assert f.read_text() == "dog\ndog\ndog\n"

    async def test_not_found_raises(self, sandbox):
        _, tmp_path = sandbox
        (tmp_path / "f.txt").write_text("hello")
        with pytest.raises(ValueError, match="Could not find"):
            await _edit_file("f.txt", "xyz", "abc")

    async def test_multiple_matches_raises(self, sandbox):
        _, tmp_path = sandbox
        (tmp_path / "f.txt").write_text("foo\nfoo\n")
        with pytest.raises(ValueError, match="multiple matches"):
            await _edit_file("f.txt", "foo", "bar")


# ---------------------------------------------------------------------------
# Targeted coverage tests — exercise specific uncovered matcher paths
#
# The matcher cascade means earlier matchers (exact, line_trimmed) often
# catch inputs before later matchers run. These tests use inputs that
# bypass earlier matchers to exercise the specific code paths.
# ---------------------------------------------------------------------------


class TestLineTrimmedTrailingEmptyStrip:
    """Cover line 57: find_lines[-1] == '' branch in _line_trimmed.

    Need: find NOT an exact substring (fails _exact), but find has a trailing
    newline and the lines match when stripped.
    """

    def test_trailing_newline_with_indent_mismatch(self):
        # Content has different indentation than find — not an exact match.
        # find ends with \n so find_lines[-1] == '' triggers line 57.
        content = "    alpha\n    beta\n"
        find = "alpha\nbeta\n"  # no indent, trailing \n
        result = replace_content(content, find, "x\ny\n")
        assert "x\ny" in result

    def test_trailing_newline_mixed_whitespace(self):
        # Content has trailing spaces on lines, find is clean with trailing \n
        content = "  foo  \n  bar  \n"
        find = "foo\nbar\n"  # stripped lines match, trailing \n
        result = replace_content(content, find, "a\nb\n")
        assert "a\nb" in result


class TestBlockAnchorTrailingEmptyAndNoCandidates:
    """Cover lines 75-76 (trailing empty strip) and line 87 (no candidates).

    _block_anchor requires >= 3 find_lines. Must bypass _exact and _line_trimmed.
    """

    def test_trailing_newline_stripped_in_block_anchor(self):
        # 4+ lines, trailing \n, not exact, different indentation so line_trimmed
        # matches first/last by strip. Content has extra lines between anchors.
        content = "  START\n  extra1\n  extra2\n  END\n"
        # find: different indent, trailing \n, middle lines differ from content
        # but first/last stripped match → block_anchor single candidate
        find = "START\nwrong1\nwrong2\nEND\n"
        # This should NOT match _exact (indent differs).
        # _line_trimmed: stripped lines don't all match (wrong1 != extra1).
        # _block_anchor: first=START, last=END, 1 candidate, yields the block.
        result = replace_content(content, find, "A\nB\nC\nD\n")
        assert "A\nB\nC\nD" in result

    def test_no_candidates_falls_through(self):
        # 3+ find_lines where first/last stripped don't match any content lines.
        # _block_anchor returns early at line 87.
        # Must still match via a later matcher.
        content = "  hello  \n  world  \n  done  \n"
        find = "hello\nworld\ndone"  # stripped lines match → _line_trimmed catches it
        result = replace_content(content, find, "a\nb\nc")
        assert "a\nb\nc" in result


class TestBlockAnchorMultipleCandidatesSimilarity:
    """Cover lines 97-119: multiple candidates with similarity scoring.

    Need: >= 3 find_lines, multiple blocks in content with same stripped
    first/last line, and find is NOT an exact substring and NOT a
    line_trimmed match (middle lines differ in both indent and content).
    """

    def test_picks_best_similarity_candidate(self):
        # Two blocks with same first/last. Middle lines differ.
        # Find's middle is close to block 2, not block 1.
        # Must NOT be exact match (add indent differences).
        content = (
            "  FUNC\n"
            "    aaaa\n"
            "    bbbb\n"
            "  RETURN\n"
            "  FUNC\n"
            "    cccc\n"
            "    dddd\n"
            "  RETURN\n"
        )
        # find: same anchors, middle close to block 2 (cccc/dddd)
        # different indent → not exact. Middle lines differ from both blocks
        # when compared via strip, so _line_trimmed won't match either block
        # fully (aaaa!=cccx, bbbb!=dddx).
        find = "FUNC\n  cccx\n  dddx\nRETURN"
        result = replace_content(content, find, "FUNC\n  NEW1\n  NEW2\nRETURN")
        # Should replace block 2 (closer similarity to cccx/dddx)
        assert "NEW1" in result
        assert "NEW2" in result

    def test_multiple_candidates_above_threshold(self):
        # Two blocks, find middle is somewhat close to block 1.
        content = (
            "BEGIN\n"
            "  alpha_val\n"
            "  beta_val\n"
            "END\n"
            "BEGIN\n"
            "  zzzzzzzzz\n"
            "  yyyyyyyyy\n"
            "END\n"
        )
        # find middle is close to alpha_val/beta_val (high similarity)
        find = "BEGIN\nalpha_vax\nbeta_vax\nEND"
        result = replace_content(content, find, "BEGIN\nR1\nR2\nEND")
        assert "R1" in result
        assert "R2" in result

    def test_all_candidates_below_threshold(self):
        # Two blocks, find middle is completely different from both.
        # Similarity < 0.3 for all candidates → block_anchor yields nothing.
        # Falls through to later matchers.
        content = "HDR\n  aaaaaaaaaa\nFTR\nHDR\n  bbbbbbbbbb\nFTR\n"
        # find middle is totally different, similarity will be very low
        find = "HDR\nzzzzzzzzzzzzzzzzzzzzzz\nFTR"
        # _block_anchor: two candidates, both score near 0 → rejected.
        # _whitespace_normalized or _indentation_flexible catches it? No —
        # the middle line differs entirely. This should raise not-found.
        with pytest.raises(ValueError, match="Could not find"):
            replace_content(content, find, "X\nY\nZ")

    def test_multiple_candidates_middle_empty(self):
        # Two blocks where find_lines has exactly 3 lines (first, one middle, last).
        # middle = min(3-2, block_len-2) = min(1, block_len-2).
        # Tests the similarity loop with minimal middle.
        content = "TAG\n  val_one\nENDTAG\nTAG\n  val_two\nENDTAG\n"
        find = "TAG\nval_onx\nENDTAG"  # close to block 1
        result = replace_content(content, find, "TAG\nREPLACED\nENDTAG")
        assert "REPLACED" in result


class TestTrimmedBoundaryPaths:
    """Cover lines 153-160: _trimmed_boundary inline and block matching.

    Must bypass: _exact, _line_trimmed, _block_anchor, _whitespace_normalized,
    _indentation_flexible. This is hard — most fuzzy cases are caught earlier.

    Key: find has leading/trailing whitespace (so trimmed != find, line 151 passes).
    The trimmed version exists in content (line 153-154), but the original find
    does NOT exist (fails _exact). And stripped lines must not match _line_trimmed.
    """

    def test_trimmed_inline_match(self):
        # find has multiline whitespace padding — not an exact substring of content.
        # Line count mismatch (3 find_lines vs 1 orig_line) bypasses _line_trimmed,
        # _block_anchor, _whitespace_normalized, and _indentation_flexible.
        # _trimmed_boundary: trimmed="MARKER" IS in content → line 153-154 yields it.
        content = "some MARKER here"
        find = "\n MARKER \n"
        result = replace_content(content, find, "REPLACED")
        assert "REPLACED" in result

    def test_trimmed_inline_replaces_correctly(self):
        # Verify the inline path (line 153-154) produces correct replacement.
        content = "before TARGET after"
        find = "\nTARGET\n"  # not exact, trimmed = "TARGET" is in content
        result = replace_content(content, find, "REPLACED")
        assert result == "before REPLACED after"
