#!/usr/bin/env python3
"""Run the ``make verify-*`` gates that cover the paths a change touches.

``make verify-quick`` always runs. Each changed path then adds the gates
listed for it in ``RULES``, so a change is checked by every surface that
compiles or reads it, not only by the one it lives in.

Usage:
    python3 scripts/verify_changed.py           # run the gates (``make verify-changed``)
    python3 scripts/verify_changed.py --list    # print them and run nothing
    python3 scripts/verify_changed.py --base origin/main

The change is everything since the merge base with the branch's upstream
(``origin/main`` when it has none), plus uncommitted and untracked files.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Path glob -> gates. `**` crosses directories, `*` stays inside one (the
# syntax of a workflow's `paths:`). scripts/tests/test_verify_changed.py
# fails when the workflow that runs a gate in CI is not triggered by a path
# listed for it here.
RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("appv3/**", ("verify-v3",)),
    ("web/**", ("verify-web",)),
    ("scripts/**", ("verify-scripts",)),
    ("desktop/src-tauri/**", ("verify-desktop",)),
    ("mobile/src-tauri/**", ("verify-mobile",)),
    # Cargo path dependencies: a crate change rebuilds everything linking it.
    ("native/cloud/**", ("verify-cloud", "verify-v3", "verify-mobile")),
    ("native/shell-core/**", ("verify-shell-core", "verify-desktop", "verify-mobile")),
    ("mobile/android-plugin/**", ("verify-mobile",)),
    # Sources the web tests read to hold the UI to the backend and the shells.
    ("appv3/crates/agent/data/**", ("verify-web",)),
    ("appv3/crates/preview/assets/**", ("verify-web",)),
    ("desktop/src-tauri/src/**", ("verify-web",)),
    ("mobile/src-tauri/src/**", ("verify-web",)),
    ("mobile/ios-widget/**", ("verify-web",)),
    ("mobile/android-plugin/**", ("verify-web",)),
    # Files the pytest contracts in scripts/tests guard.
    ("Makefile", ("verify-scripts",)),
    ("install.sh", ("verify-scripts",)),
    ("install.ps1", ("verify-scripts",)),
    (".github/workflows/**", ("verify-scripts",)),
    (".agents/skills/oad/debug/scripts/**", ("verify-scripts",)),
    ("appv3/contract/**", ("verify-scripts",)),
    ("desktop/scripts/**", ("verify-scripts",)),
    ("desktop/src-tauri/**", ("verify-scripts",)),
    ("mobile/**", ("verify-scripts",)),
    ("web/package.json", ("verify-scripts",)),
    ("web/bun.lock", ("verify-scripts",)),
)

# Run order: cheapest first.
ORDER = (
    "verify-scripts",
    "verify-web",
    "verify-shell-core",
    "verify-cloud",
    "verify-v3",
    "verify-desktop",
    "verify-mobile",
)


def glob_matches(glob: str, path: str) -> bool:
    parts: list[str] = []
    i = 0
    while i < len(glob):
        if glob.startswith("**/", i):
            parts.append("(?:.*/)?")
            i += 3
        elif glob.startswith("**", i):
            parts.append(".*")
            i += 2
        elif glob[i] == "*":
            parts.append("[^/]*")
            i += 1
        else:
            parts.append(re.escape(glob[i]))
            i += 1
    return re.fullmatch("".join(parts), path) is not None


def targets_for(paths: list[str]) -> list[str]:
    """The gates for these repository-relative paths, in run order."""
    wanted = {target for glob, targets in RULES for target in targets if any(glob_matches(glob, path) for path in paths)}
    return [target for target in ORDER if target in wanted]


def _git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=False)


def default_base(root: Path) -> str:
    upstream = _git(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    return upstream.stdout.strip() if upstream.returncode == 0 else "origin/main"


def changed_files(root: Path, base: str) -> list[str]:
    """Paths that differ from the merge base with ``base``, in the tree as it is now."""
    merge_base = _git(root, "merge-base", "HEAD", base)
    if merge_base.returncode:
        raise RuntimeError(f"no merge base with {base}: {merge_base.stderr.strip()}")
    tracked = _git(root, "diff", "--name-only", "-z", merge_base.stdout.strip())
    untracked = _git(root, "ls-files", "--others", "--exclude-standard", "-z")
    if tracked.returncode or untracked.returncode:
        raise RuntimeError(f"git could not list the change: {tracked.stderr}{untracked.stderr}".strip())
    return sorted(set(filter(None, (tracked.stdout + untracked.stdout).split("\0"))))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", help="ref to compare with (default: the upstream branch, else origin/main)")
    parser.add_argument("--list", action="store_true", help="print the gates and run nothing")
    args = parser.parse_args()

    base = args.base or default_base(ROOT)
    try:
        paths = changed_files(ROOT, base)
    except RuntimeError as error:
        print(f"verify_changed: {error}", file=sys.stderr)
        return 2
    if not paths:
        print(f"verify_changed: nothing changed against {base}")
        return 0
    targets = ["verify-quick", *targets_for(paths)]
    print(f"verify_changed: {len(paths)} changed path(s) against {base}: make {' '.join(targets)}", flush=True)
    if args.list:
        return 0
    return subprocess.run(["make", "-C", str(ROOT), *targets], check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
