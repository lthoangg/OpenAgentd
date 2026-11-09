#!/usr/bin/env python3
"""Fail when a Tauri shell registers a command its ACL does not allow.

Tauri 2 blocks every IPC call to an app command unless the command is listed
in ``build.rs`` (``AppManifest::commands``, which generates its
``allow-<name>`` permission) and a capability under ``capabilities/`` grants
that permission. A command that is in ``generate_handler!`` but missing from
either compiles and links fine, then fails at runtime with "Command <name> not
allowed by ACL" (v3.50.0 shipped the phone's cloud account flow that way).

For each shell this checks that every command registered in
``generate_handler!`` is in ``build.rs`` and granted by some capability file,
and that ``build.rs`` lists no command the handler does not register.

Usage:
    python3 scripts/check_tauri_commands.py              # desktop and mobile
    python3 scripts/check_tauri_commands.py mobile/src-tauri
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Each shell and the source file holding its `generate_handler!`.
SHELLS = {
    "desktop/src-tauri": "src/main.rs",
    "mobile/src-tauri": "src/lib.rs",
}

_HANDLER = re.compile(r"generate_handler!\s*\[(.*?)\]", re.S)
_COMMANDS = re.compile(r"\.commands\(\s*&\[(.*?)\]", re.S)
_LINE_COMMENT = re.compile(r"//[^\n]*")


@dataclass
class Report:
    shell: str
    registered: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def handler_commands(source: str) -> list[str]:
    """Command names in `generate_handler![...]`, without module paths."""
    match = _HANDLER.search(_LINE_COMMENT.sub("", source))
    if not match:
        raise ValueError("no generate_handler![...] found")
    names = []
    for item in match.group(1).split(","):
        item = item.strip()
        if item:
            names.append(item.split("::")[-1].strip())
    return names


def manifest_commands(build_rs: str) -> list[str]:
    """Command names in `AppManifest::new().commands(&[...])`."""
    match = _COMMANDS.search(_LINE_COMMENT.sub("", build_rs))
    if not match:
        raise ValueError("no AppManifest .commands(&[...]) found in build.rs")
    return re.findall(r'"([^"]+)"', match.group(1))


def granted_permissions(capabilities_dir: Path) -> set[str]:
    """Every permission identifier any capability file grants."""
    granted: set[str] = set()
    for path in sorted(capabilities_dir.glob("*.json")):
        data = json.loads(path.read_text())
        for entry in data.get("permissions", []):
            ident = entry if isinstance(entry, str) else entry.get("identifier")
            if ident:
                granted.add(ident)
    return granted


def permission_name(command: str) -> str:
    return "allow-" + command.replace("_", "-")


def check_shell(shell_dir: Path, handler_file: str) -> Report:
    report = Report(shell=str(shell_dir))
    registered = handler_commands((shell_dir / handler_file).read_text())
    manifest = manifest_commands((shell_dir / "build.rs").read_text())
    granted = granted_permissions(shell_dir / "capabilities")
    report.registered = registered

    for name in sorted(set(registered) - set(manifest)):
        report.errors.append(f"{name}: registered in {handler_file} but missing from build.rs")
    for name in sorted(set(registered)):
        if permission_name(name) not in granted:
            report.errors.append(
                f"{name}: registered in {handler_file} but no capability grants {permission_name(name)}"
            )
    for name in sorted(set(manifest) - set(registered)):
        report.errors.append(f"{name}: listed in build.rs but not registered in {handler_file}")
    return report


def main(argv: list[str]) -> int:
    targets = argv or list(SHELLS)
    failed = False
    for target in targets:
        rel = target.rstrip("/")
        if rel not in SHELLS:
            print(f"unknown shell {target}; expected one of {', '.join(SHELLS)}", file=sys.stderr)
            return 2
        report = check_shell(ROOT / rel, SHELLS[rel])
        if report.errors:
            failed = True
            print(f"{rel}: {len(report.errors)} ACL problem(s)")
            for error in report.errors:
                print(f"  {error}")
        else:
            print(f"{rel}: all {len(report.registered)} registered commands are allowed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
