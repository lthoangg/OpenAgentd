"""Stop source files from growing past what one reader can hold.

A web app file may have 800 lines and a Rust file 1,000. A file that is
already larger says so in its first lines:

    // size-ceiling: 1719 — split state transitions from the queue before adding

and may not pass that number. So the limit only blocks growth: nothing has
to be split today, the agent that opens the file sees where to split it, and
raising a ceiling is a one-line diff a reviewer sees.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

# (what the files are, limit in lines, git pathspecs)
RULES: tuple[tuple[str, int, tuple[str, ...]], ...] = (
    ("web app file", 800, ("web/src/*.ts", "web/src/*.tsx")),
    (
        "Rust file",
        1000,
        ("appv3/crates/*.rs", "native/*.rs", "desktop/src-tauri/src/*.rs", "mobile/src-tauri/src/*.rs"),
    ),
)
# Tests follow their sources and generated or vendored code is not ours to shape.
SKIPPED_PARTS = frozenset({"__tests__", "tests", "vendor", "gen", "target"})
CEILING_RE = re.compile(r"^\s*(?://|/\*|\*)\s*size-ceiling:\s*(\d+)\s*(?:—|-)\s*(\S.*?)\s*(?:\*/)?\s*$")
HEADER_LINES = 5


def tracked_files(root: Path, patterns: tuple[str, ...]) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--", *patterns], check=False, capture_output=True
    )
    if result.returncode:
        raise RuntimeError("could not list tracked files with git")
    return sorted(filter(None, result.stdout.decode().split("\0")))


def is_source(name: str) -> bool:
    path = Path(name)
    return (
        not SKIPPED_PARTS.intersection(path.parts[:-1])
        and ".test." not in path.name
        and not path.name.endswith(".d.ts")
    )


def check_file(name: str, text: str, kind: str, limit: int) -> str | None:
    """The problem with one file, or None."""
    lines = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
    ceiling = next(
        (match for line in text.split("\n", HEADER_LINES)[:HEADER_LINES] if (match := CEILING_RE.match(line))),
        None,
    )
    if lines <= limit:
        if ceiling:
            return f"{name}: {lines} lines, under the {limit}-line limit: delete its size-ceiling comment"
        return None
    if ceiling is None:
        return (
            f"{name}: {lines} lines, over the {limit}-line limit for a {kind}. "
            "Move one body of knowledge into its own module (with its tests, and no re-export left behind). "
            f"If it has no seam, say so in a first-line comment: // size-ceiling: {lines} — <why it stays whole>"
        )
    allowed = int(ceiling.group(1))
    if lines > allowed:
        return (
            f"{name}: {lines} lines, over its size ceiling of {allowed}. "
            f"Its first lines say where to split: {ceiling.group(2)}. "
            "Do that, or raise the ceiling there if this change cannot (a reviewer sees the line)"
        )
    return None


def check_repository(root: Path, files: dict[str, tuple[str, int]]) -> list[str]:
    """Problems for `files`: repository-relative name -> (kind, limit)."""
    errors = []
    for name, (kind, limit) in sorted(files.items()):
        problem = check_file(name, (root / name).read_text(encoding="utf-8"), kind, limit)
        if problem:
            errors.append(problem)
    return errors


def source_files(root: Path) -> dict[str, tuple[str, int]]:
    return {
        name: (kind, limit)
        for kind, limit, patterns in RULES
        for name in tracked_files(root, patterns)
        if is_source(name) and (root / name).is_file()
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="repository root")
    args = parser.parse_args()
    try:
        errors = check_repository(args.root, source_files(args.root))
    except (OSError, RuntimeError) as error:
        print(f"check_file_size: {error}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
