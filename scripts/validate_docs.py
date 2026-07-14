"""Validate repository documentation contracts without third-party dependencies."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

FRONTMATTER_REQUIREMENTS: tuple[tuple[str, frozenset[str]], ...] = (
    ("documents/docs/", frozenset({"title", "description", "status", "updated"})),
    (
        "documents/styling-specs/",
        frozenset({"title", "description", "status", "updated"}),
    ),
    (
        "documents/techdebts/",
        frozenset({"title", "status", "owner", "opened", "updated"}),
    ),
    ("seed/agents/", frozenset({"name", "role", "model", "thinking_level"})),
    (".github/ISSUE_TEMPLATE/", frozenset({"name", "about", "labels"})),
)
IMAGE_SUFFIXES = frozenset(
    {".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"}
)
LINK_RE = re.compile(r"(?<!!)\[[^]]*\]\(([^)]+)\)")
MAKE_RE = re.compile(r"^make(?:\s+-C\s+([^\s`]+))?\s+([A-Za-z0-9_.-]+)(?:\s|$)")
AGENTS_PATH_RE = re.compile(r"(?<![\w:/.-])([\w.\-/]+/AGENTS\.md)\b")


def tracked_markdown_files(root: Path) -> list[Path]:
    """Return tracked Markdown files in stable repository-relative order."""
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z", "--", "*.md"],
        check=False,
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError("could not list tracked Markdown files with git")
    return [
        root / Path(name)
        for name in sorted(filter(None, result.stdout.decode().split("\0")))
    ]


def _relative(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def _frontmatter_fields(text: str) -> set[str] | None:
    if not text.startswith("---\n"):
        return None
    end = text.find("\n---", 4)
    if end == -1:
        return set()
    return {
        match.group(1)
        for match in re.finditer(
            r"^([A-Za-z][A-Za-z0-9_-]*):", text[4:end], re.MULTILINE
        )
    }


def _required_frontmatter(relative_path: str) -> frozenset[str]:
    if relative_path.endswith("/SKILL.md") or relative_path.startswith(
        "app/agent/builtin_skills/"
    ):
        return frozenset({"name", "description"})
    if relative_path.startswith(".openagentd/commands/") or relative_path.startswith(
        ".openagentd/snippets/"
    ):
        return frozenset({"description"})
    for prefix, fields in FRONTMATTER_REQUIREMENTS:
        if relative_path.startswith(prefix):
            return fields
    return frozenset()


def _local_link_target(raw_target: str) -> str | None:
    target = raw_target.strip().split(maxsplit=1)[0].strip("<>")
    target = target.split("#", 1)[0].split("?", 1)[0]
    if not target or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target):
        return None
    if Path(unquote(target)).suffix.lower() in IMAGE_SUFFIXES:
        return None
    return unquote(target)


def _make_targets(makefile: Path) -> set[str]:
    if not makefile.is_file():
        return set()
    return {
        match.group(1)
        for line in makefile.read_text(encoding="utf-8").splitlines()
        if (match := re.match(r"^([A-Za-z0-9_.-]+):", line))
    }


def _validate_adr_index(root: Path, errors: list[str]) -> None:
    adr_dir = root / "documents" / "adrs"
    index = adr_dir / "README.md"
    if not index.is_file():
        return
    indexed = set(
        re.findall(r"\]\((\d{4}-[^)]+\.md)\)", index.read_text(encoding="utf-8"))
    )
    for filename in sorted(indexed):
        if not (adr_dir / filename).is_file():
            errors.append(
                f"documents/adrs/README.md: ADR entry target does not exist: {filename}"
            )
    for path in sorted(adr_dir.glob("[0-9][0-9][0-9][0-9]-*.md")):
        if path.name not in indexed:
            errors.append(f"{_relative(root, path)}: ADR file is missing from index")


def validate_repository(root: Path, markdown_files: list[Path]) -> list[str]:
    """Return deterministic contract violations for the supplied tracked Markdown files."""
    root = root.resolve()
    errors: list[str] = []
    for path in sorted(markdown_files, key=lambda item: _relative(root, item)):
        relative = _relative(root, path)
        text = path.read_text(encoding="utf-8")
        fields = _frontmatter_fields(text)
        if fields is not None:
            for field in sorted(_required_frontmatter(relative) - fields):
                errors.append(f"{relative}: missing frontmatter field: {field}")
        for match in LINK_RE.finditer(text):
            target = _local_link_target(match.group(1))
            if (
                target is not None
                and not (path.parent / target).is_file()
                and not (path.parent / target).is_dir()
            ):
                errors.append(f"{relative}: local link target does not exist: {target}")
        for command in re.findall(r"`([^`]+)`", text):
            match = MAKE_RE.match(command.strip())
            if match:
                directory, target = match.groups()
                makefile = (
                    root / directory / "Makefile" if directory else root / "Makefile"
                )
                if target not in _make_targets(makefile):
                    errors.append(
                        f"{relative}: documented Make target does not exist: {target}"
                    )

    root_agents = root / "AGENTS.md"
    if root_agents.is_file():
        for referenced in sorted(
            set(AGENTS_PATH_RE.findall(root_agents.read_text(encoding="utf-8")))
        ):
            if not (root / referenced).is_file():
                errors.append(
                    f"AGENTS.md: referenced AGENTS path does not exist: {referenced}"
                )
    _validate_adr_index(root, errors)
    return sorted(errors)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root",
    )
    args = parser.parse_args()
    try:
        errors = validate_repository(args.root, tracked_markdown_files(args.root))
    except (OSError, RuntimeError) as error:
        print(f"check_docs: {error}", file=sys.stderr)
        return 1
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
