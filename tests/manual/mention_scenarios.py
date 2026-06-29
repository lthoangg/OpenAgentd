"""
Manual scenario tests for @mention file/folder context injection.
Run with: uv run python tests/manual/mention_scenarios.py

Covers build_mention_context_blocks end-to-end against a real temporary
filesystem so the full path-resolution, binary-detection, and block-format
logic is exercised without a running server.
"""

import asyncio
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import app.api.routes.team._helpers as _h

PASS = "✅ PASS"
FAIL = "❌ FAIL"
results: list[tuple[str, str]] = []


def check(label: str, got, expected):
    ok = got == expected
    sym = PASS if ok else FAIL
    results.append((sym, label))
    if ok:
        print(f"  {sym}  {label}")
    else:
        print(f"  {sym}  {label}")
        print(f"       got:      {got!r}")
        print(f"       expected: {expected!r}")


def check_true(label: str, value: bool):
    check(label, value, True)


async def build(root: Path, message: str, mentions: list[str]) -> list[str]:
    """Helper: call build_mention_context_blocks with a patched workspace root."""
    original = _h.session_workspace_dir
    _h.session_workspace_dir = lambda sid, ws: root
    try:
        return await _h.build_mention_context_blocks(
            message=message,
            team=MagicMock(),
            session_id="test-session",
            workspace=None,
            existing_total_bytes=0,
            mentions=mentions,
        )
    finally:
        _h.session_workspace_dir = original


async def run():
    # ── Scenario A: Common code file types ──────────────────────────────────
    print("\n── Scenario A: Code file extensions ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "api.ts").write_text("export const x = 1\n")
        (root / "main.py").write_text("print('hello')\n")
        (root / "config.yaml").write_text("key: value\n")
        (root / "styles.css").write_text("body { margin: 0; }\n")

        for ext_file in ["api.ts", "main.py", "config.yaml", "styles.css"]:
            blocks = await build(root, f"check @{ext_file} please", [ext_file])
            check_true(
                f"A: {ext_file} produces a context block",
                len(blocks) == 1,
            )
            check_true(
                f"A: {ext_file} block starts with [File:",
                blocks[0].startswith("[File:"),
            )

    # ── Scenario B: Directory mention (stored without trailing slash) ────────
    print("\n── Scenario B: Directory mention ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "src").mkdir()
        (root / "src" / "api.ts").write_text("export {}\n")
        (root / "src" / "index.ts").write_text("export * from './api'\n")

        # Frontend stores path without slash in mentions[]
        blocks = await build(root, "look at @src/ folder", ["src"])
        check_true("B1: dir mention (no slash) yields a block", len(blocks) == 1)
        check_true(
            "B2: block is a directory listing",
            blocks[0].startswith("[Directory: src/]"),
        )
        check_true("B3: listing contains child filenames", "api.ts" in blocks[0])

        # Frontend may also store with slash (e.g. after direct text edit)
        blocks2 = await build(root, "look at @src/ folder", ["src/"])
        check_true(
            "B4: dir mention (with slash) also yields a block", len(blocks2) == 1
        )
        check(
            "B5: both slash forms produce identical blocks",
            blocks[0],
            blocks2[0],
        )

    # ── Scenario C: Binary and image files ──────────────────────────────────
    print("\n── Scenario C: Binary / image files ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "binary.bin").write_bytes(b"\x00\x01\x02\x03\xff\xfe")
        (root / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50)
        (root / "report.pdf").write_bytes(b"%PDF-1.4" + b"\x00" * 50)

        bin_blocks = await build(root, "see @binary.bin", ["binary.bin"])
        check("C1: true binary (null bytes) is skipped", len(bin_blocks), 0)

        png_blocks = await build(root, "see @logo.png", ["logo.png"])
        check_true("C2: image file yields a hint block", len(png_blocks) == 1)
        check_true(
            "C3: image hint mentions 'read tool'",
            "read tool" in png_blocks[0],
        )

        pdf_blocks = await build(root, "see @report.pdf", ["report.pdf"])
        check_true("C4: pdf file yields a hint block", len(pdf_blocks) == 1)
        check_true(
            "C5: pdf hint mentions 'read tool'",
            "read tool" in pdf_blocks[0],
        )

    # ── Scenario D: Safety check — mention not in message text ──────────────
    print("\n── Scenario D: Safety check ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "secret.ts").write_text("const secret = 42\n")

        # mentions[] has the path but the message text does NOT contain @secret.ts
        blocks = await build(root, "nothing here", ["secret.ts"])
        check(
            "D1: path in mentions[] but not in message text is dropped",
            len(blocks),
            0,
        )

    # ── Scenario E: Non-existent path ───────────────────────────────────────
    print("\n── Scenario E: Non-existent path ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        blocks = await build(root, "check @ghost.ts please", ["ghost.ts"])
        check("E1: non-existent file yields no block", len(blocks), 0)

    # ── Scenario F: Line reference ───────────────────────────────────────────
    print("\n── Scenario F: Line reference (@file#L1-L3) ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "app.ts").write_text("line1\nline2\nline3\nline4\nline5\n")

        blocks = await build(root, "see @app.ts#L2-L3 please", ["app.ts#L2-L3"])
        check_true("F1: line-ref yields a block", len(blocks) == 1)
        check_true("F2: block contains only the sliced lines", "line2" in blocks[0])
        check_true(
            "F3: block does not contain lines outside range", "line4" not in blocks[0]
        )

    # ── Scenario G: Multiple mentions in one message ─────────────────────────
    print("\n── Scenario G: Multiple mentions ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "a.ts").write_text("const a = 1\n")
        (root / "b.ts").write_text("const b = 2\n")
        (root / "lib").mkdir()
        (root / "lib" / "c.ts").write_text("const c = 3\n")

        blocks = await build(
            root,
            "compare @a.ts and @b.ts inside @lib/",
            ["a.ts", "b.ts", "lib"],
        )
        check("G1: three mentions yield three blocks", len(blocks), 3)
        contents = "\n".join(blocks)
        check_true("G2: a.ts content present", "const a = 1" in contents)
        check_true("G3: b.ts content present", "const b = 2" in contents)
        check_true(
            "G4: lib/ directory listing present", "[Directory: lib/]" in contents
        )

    # ── Scenario H: Empty mentions list ─────────────────────────────────────
    print("\n── Scenario H: Edge cases ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        blocks = await build(root, "no mentions here", [])
        check("H1: empty mentions list yields no blocks", len(blocks), 0)

        blocks2 = await build(root, "no mentions here", None)  # type: ignore[arg-type]
        check("H2: None mentions yields no blocks", len(blocks2), 0)

    # ── Scenario I: Path traversal is rejected ───────────────────────────────
    print("\n── Scenario I: Path traversal ──")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        outside = Path(tmp).parent / "outside.ts"
        outside.write_text("should not be readable\n")

        blocks = await build(root, "see @../outside.ts", ["../outside.ts"])
        check("I1: path traversal attempt yields no block", len(blocks), 0)

    # ── Summary ──────────────────────────────────────────────────────────────
    print("\n" + "═" * 55)
    passed = sum(1 for s, _ in results if s == PASS)
    failed = sum(1 for s, _ in results if s == FAIL)
    print(f"  Results: {passed} passed, {failed} failed  (total {len(results)})")
    print("═" * 55)
    return failed


async def main():
    failed = await run()
    sys.exit(1 if failed else 0)


asyncio.run(main())
