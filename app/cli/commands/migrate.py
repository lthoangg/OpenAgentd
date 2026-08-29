"""``openagentd transfer migrate`` — import configs from local agent tools."""

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

_HERMES_CONTEXT_FILES: tuple[str, ...] = (
    "SOUL.md",
    ".hermes.md",
    "HERMES.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".cursorrules",
)


@dataclass(slots=True)
class MigrationResult:
    target: Path
    imported_files: list[str]


def _migrate_agent(
    source_dir: Path,
    config_dir: Path,
    *,
    prompt_files: tuple[str, ...],
    source_label: str,
    missing_msg: str,
    description: str,
    name: str,
    model: str,
    force: bool = False,
) -> MigrationResult:
    """Convert source directory prompt/context files into one agent."""
    if Path(name).name != name:
        raise ValueError("Agent name must be a filename, not a path")

    source_dir = source_dir.expanduser().resolve()
    if not source_dir.is_dir():
        raise ValueError(f"{source_label} does not exist: {source_dir}")

    sections: list[str] = []
    imported_files: list[str] = []
    for filename in prompt_files:
        path = source_dir / filename
        if not path.is_file():
            continue
        body = _read_markdown_body(path)
        if not body:
            continue
        sections.append(f"# Imported from {filename}\n\n{body}")
        imported_files.append(filename)

    if not sections:
        expected = ", ".join(prompt_files)
        raise ValueError(f"No {missing_msg} found in {source_dir}: {expected}")

    agents_dir = config_dir / "agents"
    target = agents_dir / f"{name}.md"
    if target.exists() and not force:
        raise FileExistsError(
            f"Agent already exists: {target}. Pass --force to replace it."
        )

    frontmatter = yaml.safe_dump(
        {
            "name": name,
            "role": "lead",
            "description": description,
            "model": model,
        },
        sort_keys=False,
    ).strip()
    content = f"---\n{frontmatter}\n---\n\n" + "\n\n---\n\n".join(sections) + "\n"

    agents_dir.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return MigrationResult(target=target, imported_files=imported_files)


def migrate_openclaw_agent(
    source_dir: Path,
    config_dir: Path,
    *,
    name: str,
    model: str,
    force: bool = False,
) -> MigrationResult:
    """Convert OpenClaw workspace prompt files into one agent."""
    return _migrate_agent(
        source_dir,
        config_dir,
        prompt_files=_OPENCLAW_PROMPT_FILES,
        source_label="OpenClaw workspace",
        missing_msg="OpenClaw prompt files",
        description="Migrated from OpenClaw/Hermes workspace prompt files.",
        name=name,
        model=model,
        force=force,
    )


def migrate_hermes_agent(
    source_dir: Path,
    config_dir: Path,
    *,
    name: str,
    model: str,
    force: bool = False,
) -> MigrationResult:
    """Convert Hermes identity/context files into one agent."""
    return _migrate_agent(
        source_dir,
        config_dir,
        prompt_files=_HERMES_CONTEXT_FILES,
        source_label="Hermes home or project directory",
        missing_msg="Hermes context files",
        description="Migrated from Hermes identity/context files.",
        name=name,
        model=model,
        force=force,
    )


def cmd_migrate(args: argparse.Namespace) -> None:
    config_dir = (
        Path(args.config_dir).expanduser() if args.config_dir else _config_dir()
    )
    source_dir = (
        Path(args.from_dir) if args.from_dir else _default_source_dir(args.source)
    )
    if args.source == "openclaw":
        result = migrate_openclaw_agent(
            source_dir,
            config_dir,
            name=args.name or args.source,
            model=args.model,
            force=args.force,
        )
    elif args.source == "hermes":
        result = migrate_hermes_agent(
            source_dir,
            config_dir,
            name=args.name or args.source,
            model=args.model,
            force=args.force,
        )
    else:
        raise SystemExit(f"Unsupported migration source: {args.source}")

    imported = ", ".join(result.imported_files)
    print(f"Imported {imported} into {result.target}")


def _default_source_dir(source: str) -> Path:
    if source == "hermes":
        return Path("~/.hermes")
    return Path("~/.openclaw/workspace")


def _read_markdown_body(path: Path) -> str:
    text = path.read_text(encoding="utf-8").strip()
    if not text.startswith("---\n"):
        return text
    _, sep, body = text[4:].partition("\n---")
    if not sep:
        return text
    return body.lstrip("\r\n").strip()
