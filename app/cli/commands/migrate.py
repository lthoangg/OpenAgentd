"""``openagentd migrate`` — import configs from other local agent tools."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import yaml

from app.cli.paths import _config_dir


_OPENCLAW_PROMPT_FILES: tuple[str, ...] = (
    "AGENTS.md",
    "SOUL.md",
    "SOULS.md",
    "TOOLS.md",
)


@dataclass(slots=True)
class MigrationResult:
    target: Path
    imported_files: list[str]


def migrate_openclaw_agent(
    source_dir: Path,
    config_dir: Path,
    *,
    name: str,
    model: str,
    force: bool = False,
) -> MigrationResult:
    """Convert OpenClaw/Hermes workspace prompt files into one lead agent."""
    if Path(name).name != name:
        raise ValueError("Agent name must be a filename, not a path")

    source_dir = source_dir.expanduser().resolve()
    if not source_dir.is_dir():
        raise ValueError(f"OpenClaw workspace does not exist: {source_dir}")

    sections: list[str] = []
    imported_files: list[str] = []
    for filename in _OPENCLAW_PROMPT_FILES:
        path = source_dir / filename
        if not path.is_file():
            continue
        body = path.read_text(encoding="utf-8").strip()
        if not body:
            continue
        sections.append(f"# Imported from {filename}\n\n{body}")
        imported_files.append(filename)

    if not sections:
        expected = ", ".join(_OPENCLAW_PROMPT_FILES)
        raise ValueError(f"No OpenClaw prompt files found in {source_dir}: {expected}")

    agents_dir = config_dir / "agents"
    target = agents_dir / f"{name}.md"
    if target.exists() and not force:
        raise FileExistsError(f"Agent already exists: {target}. Pass --force to replace it.")

    frontmatter = yaml.safe_dump(
        {
            "name": name,
            "role": "lead",
            "description": "Migrated from OpenClaw/Hermes workspace prompt files.",
            "model": model,
        },
        sort_keys=False,
    ).strip()
    content = f"---\n{frontmatter}\n---\n\n" + "\n\n---\n\n".join(sections) + "\n"

    agents_dir.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return MigrationResult(target=target, imported_files=imported_files)


def cmd_migrate(args: argparse.Namespace) -> None:
    if args.source != "openclaw":
        raise SystemExit(f"Unsupported migration source: {args.source}")

    config_dir = Path(args.config_dir).expanduser() if args.config_dir else _config_dir(args.dev)
    result = migrate_openclaw_agent(
        Path(args.from_dir),
        config_dir,
        name=args.name,
        model=args.model,
        force=args.force,
    )

    imported = ", ".join(result.imported_files)
    print(f"Imported {imported} into {result.target}")
