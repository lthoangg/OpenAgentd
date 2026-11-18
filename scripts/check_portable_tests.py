#!/usr/bin/env python3
"""Catch backend test code that only works on Unix before Windows CI does.

The appv3 tests run on Windows only in CI, and CI runs only on a release PR,
so a POSIX-only test used to surface days later as a failed release round.
Two mistakes made most of those rounds, and both can be read from source:

1. A command written in POSIX shell for the agent's shell tool or for a
   spawned `sh`. The shell tool runs PowerShell on Windows, where
   `while [ … ]; do … done`, `$((…))`, `| wc`, `printf`, `touch` and a bare
   `$NAME` environment read fail or mean something else. Branch on
   `cfg!(windows)` (`agent/tests/common/mod.rs` has `wait_for_file`), gate
   the test with `#[cfg(unix)]`, or, when the command never runs, say why on
   the line or just above it: `// posix-only: <reason>`.
2. A signed file (one with a `.sig` beside it) that git may check out with
   CRLF line endings. Mark it and its signature `-text` in `.gitattributes`.

The patterns are narrow on purpose: a check that cries wolf gets ignored.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

POSIX_SHELL = re.compile(
    r"while \[|until \[|; done\b|\$\(\(|\|\s*wc\b|\bprintf ['%]|\btouch '"
    r'|"command":\s*"(?:[^"\\]|\\.)*?(?<!env:)\$[A-Z][A-Z0-9_]{2,}'
)
SPAWNS_SH = re.compile(r'Command::new\("(?:sh|bash)"\)')
GUARD = re.compile(r"cfg!\((?:not\()?(?:windows|unix)\)?\)|#\[cfg\((?:not\()?(?:windows|unix)|target_os")
FILE_GUARD = re.compile(r"^#!\[cfg\((?:unix|not\(windows\))\)\]")
FN_START = re.compile(r"^\s*(?:pub(?:\([^)]*\))? )?(?:async )?fn ")
EXEMPT = "posix-only:"


def is_test_file(name: str) -> bool:
    return "/tests/" in name or name.endswith("tests.rs")


def check_rust(name: str, text: str) -> list[str]:
    lines = text.split("\n")
    if any(FILE_GUARD.match(line) for line in lines[:20]):
        return []
    in_test = is_test_file(name)
    fn_start = 0
    out: list[str] = []
    for i, line in enumerate(lines):
        if "#[cfg(test)]" in line:
            in_test = True
        if FN_START.match(line):
            fn_start = i
        if not in_test or line.lstrip().startswith("//"):
            continue
        hit = POSIX_SHELL.search(line) or SPAWNS_SH.search(line)
        if not hit:
            continue
        if any(EXEMPT in above for above in lines[max(0, i - 3) : i + 1]):
            continue
        # The scope is the enclosing function with the attributes above it.
        end = i + 1
        while end < len(lines) and not FN_START.match(lines[end]):
            end += 1
        if GUARD.search("\n".join(lines[max(0, fn_start - 3) : end])):
            continue
        out.append(
            f"{name}:{i + 1}: {hit.group(0)!r} only works in a POSIX shell, but Windows runs this test too. "
            "Branch on cfg!(windows), gate the test with #[cfg(unix)], "
            "or if the command never runs say why: // posix-only: <reason>"
        )
    return out


def check_signed(root: Path, tracked: list[str]) -> list[str]:
    signed = [name for name in tracked if name.endswith(".sig")]
    names = [n for sig in signed for n in (sig, sig[: -len(".sig")]) if n in set(tracked)]
    if not names:
        return []
    attrs = subprocess.run(
        ["git", "check-attr", "text", "--", *names], cwd=root, capture_output=True, text=True, check=True
    ).stdout
    out = []
    for line in attrs.splitlines():
        path, _, value = line.rpartition(": ")
        path = path.removesuffix(": text")
        if value != "unset":
            out.append(
                f"{path}: signed bytes, but git may rewrite its line endings on checkout (text: {value}). "
                "Mark it -text in .gitattributes."
            )
    return out


def tracked_files(root: Path, *patterns: str) -> list[str]:
    out = subprocess.run(["git", "ls-files", "--", *patterns], cwd=root, capture_output=True, text=True, check=True)
    return [line for line in out.stdout.splitlines() if line]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="repository root")
    root = parser.parse_args(argv).root
    problems: list[str] = []
    for name in tracked_files(root, "appv3/crates/*.rs"):
        path = root / name
        if path.exists():
            problems += check_rust(name, path.read_text(encoding="utf-8"))
    problems += check_signed(root, tracked_files(root))
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
