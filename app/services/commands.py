"""Slash-command discovery and rendering.

Commands are markdown files with YAML frontmatter, reused from opencode's
format so users can share a single library between the two tools:

    ---
    description: One-line description shown in the picker
    ---

    Body becomes the user message. ``$ARGUMENTS`` (if present) is
    replaced with whatever the user typed after the command name; if
    the placeholder is absent, the arguments are appended on a new line.

Discovery walks four roots in precedence order — first hit wins on a
name collision, later sources are silently ignored:

    1. ``{workspace}/.openagentd/commands/``  (project, OpenAgentd-native;
                                               coding mode only)
    2. ``{workspace}/.opencode/commands/``    (project, opencode reuse;
                                               coding mode only)
    3. ``{OPENAGENTD_CONFIG_DIR}/commands/``     (global, OpenAgentd)
    4. ``~/.config/opencode/commands/`` (global, opencode reuse)

Nested folders are honoured: ``commands/git/commit.md`` registers as
``git/commit`` so users can group related commands. The forward slash
is preserved verbatim in the command id — the picker matches against it.
"""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from pathlib import Path

import yaml

from app.core.config import settings


@dataclass(frozen=True)
class Command:
    """A discovered slash command."""

    name: str  # e.g. "commit" or "git/commit"
    description: str
    body: str  # post-frontmatter markdown, untouched
    path: Path  # absolute path to the source .md file
    source: str  # one of: project-openagentd / project-opencode / global-openagentd / global-opencode


@dataclass(frozen=True)
class SlashInvocation:
    """Parsed slash-command invocation from a chat message."""

    command: str
    subcommand: str | None
    arguments: str
    argv: list[str]


# ── Discovery roots ─────────────────────────────────────────────────────────


def _candidate_roots(workspace: Path | None = None) -> list[tuple[Path, str]]:
    """Ordered list of ``(root_dir, source_label)`` to search.

    Roots that don't exist are still returned — the caller filters them
    out — so the precedence rule is deterministic regardless of which
    sources happen to be present on disk.
    """
    home = Path.home()
    config = Path(settings.OPENAGENTD_CONFIG_DIR)
    roots: list[tuple[Path, str]] = []
    if workspace is not None:
        roots.extend(
            [
                (workspace / ".openagentd" / "commands", "project-openagentd"),
                (workspace / ".opencode" / "commands", "project-opencode"),
            ]
        )
    roots.extend(
        [
            (config / "commands", "global-openagentd"),
            (home / ".config" / "opencode" / "commands", "global-opencode"),
        ]
    )
    return roots


# ── Parsing ─────────────────────────────────────────────────────────────────

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split YAML frontmatter from markdown body.

    Mirrors ``app.agent.tools.builtin.skill._parse_frontmatter`` — kept
    private here to avoid a cross-package import that would pull the
    skill tool's settings into ``services``.
    """
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text.strip()
    meta = yaml.safe_load(match.group(1)) or {}
    if not isinstance(meta, dict):
        meta = {}
    return meta, match.group(2).strip()


def _iter_md(root: Path):
    """Yield ``(absolute_path, command_name)`` for every ``*.md`` under *root*.

    The command name is the path relative to *root* with the ``.md``
    suffix stripped.  Only one level of nesting is honoured:

    * ``commands/commit.md``         → ``"commit"``
    * ``commands/git/commit.md``     → ``"git/commit"``
    * ``commands/a/b/c.md``          → skipped (more than one level deep)

    Files nested more than one level deep are silently ignored so the
    command namespace stays predictable and the slash-picker UI remains
    manageable.
    """
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*.md")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).with_suffix("")
        # Allow at most one level of nesting (i.e. at most 2 path parts).
        if len(rel.parts) > 2:
            continue
        # ``as_posix`` normalises separators on Windows so command ids
        # stay platform-independent.
        yield path, rel.as_posix()


# ── Built-in commands ───────────────────────────────────────────────────────
#
# Built-ins are prompt templates owned by OpenAgentd itself rather than the
# user's command library. They are intentionally **not** listed by
# ``discover_commands`` — the picker registers them as immediate-execute
# actions (see ``TeamChatView``'s ``slashCommands``) — but they are
# resolvable through :func:`get_builtin_command` and the
# ``/api/commands/{name}/render`` endpoint so the frontend can fetch the
# rendered body without hardcoding the prompt in the bundle.

_BUILTIN_INIT_BODY = """\
Inspect the project at the current working directory and create or update \
`AGENTS.md` at the repo root, in each meaningful top-level subfolder, and in \
meaningful nested subfolders where a future coding agent would need local \
instructions to change or add features safely. Treat this as documentation \
work, not a code change.

1. Read any existing `AGENTS.md` first, including parent files. Preserve \
accurate human-authored notes; only revise stale or misleading sections.
2. Survey the repo: layout, nested feature areas, runtimes, build / test / \
lint commands (Makefile, package.json, pyproject.toml, Cargo.toml, CI), \
conventions, docs, and generated/vendor/cache/build folders to skip.
3. Add nested `AGENTS.md` only where it helps a future coding agent: where to \
look first, coupled files/docs/tests, focused commands, or local gotchas. Do \
not duplicate parent guidance.
4. Keep every file concise — ideally one screen. Root covers repo-wide context; \
children cover only what differs. Prefer sections: Summary, Where to look \
first, Common feature checks, Commands, Gotchas, Docs.
5. Do not invent commands or features. Document only what exists, and note \
expensive/optional checks separately from required focused checks.
6. Run the lint/test/type-check commands you documented when feasible. If a \
check fails because of environment or missing services, document the condition \
instead of changing code."""


_BUILTIN_COMMANDS: dict[str, Command] = {
    "init": Command(
        name="init",
        description="Create or update AGENTS.md for this project.",
        body=_BUILTIN_INIT_BODY,
        path=Path("<builtin>"),
        source="builtin",
    ),
}


def get_builtin_command(name: str) -> Command | None:
    """Return the built-in command with *name*, or ``None`` if not built-in."""
    return _BUILTIN_COMMANDS.get(name)


_SLASH_INVOCATION_RE = re.compile(
    r"^/(?P<command>[A-Za-z0-9_-]+)(?::(?P<subcommand>[A-Za-z0-9_-]+))?(?:\s+(?P<arguments>.*))?$",
    re.DOTALL,
)


def parse_slash_invocation(content: str) -> SlashInvocation | None:
    """Parse ``/<command>[:subcommand] [arguments]`` chat input.

    This is intentionally separate from disk command discovery: built-ins can
    consume structured subcommands while custom commands still use their file
    name as the command id.
    """
    match = _SLASH_INVOCATION_RE.match(content.strip())
    if match is None:
        return None
    arguments = match.group("arguments") or ""
    try:
        argv = shlex.split(arguments)
    except ValueError:
        argv = []
    return SlashInvocation(
        command=match.group("command"),
        subcommand=match.group("subcommand"),
        arguments=arguments,
        argv=argv,
    )


# ── Public API ──────────────────────────────────────────────────────────────


def discover_commands(workspace: Path | None = None) -> dict[str, Command]:
    """Return ``{name: Command}`` for every command across the four roots.

    First-source wins on conflict. ``workspace`` is exposed for tests and
    coding mode; callers pass nothing to list only global commands.
    """
    commands: dict[str, Command] = {}
    for root, source in _candidate_roots(workspace):
        for path, name in _iter_md(root):
            if name in commands:
                continue  # earlier source wins
            try:
                text = path.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = _parse_frontmatter(text)
            description = meta.get("description", "")
            if not isinstance(description, str):
                description = ""
            commands[name] = Command(
                name=name,
                description=description.strip(),
                body=body,
                path=path,
                source=source,
            )
    return commands


def render_command(command: Command, arguments: str = "") -> str:
    """Substitute ``$ARGUMENTS`` in *command.body*.

    If the placeholder is present, every occurrence is replaced. If it
    is absent and *arguments* is non-empty, the arguments are appended
    on a new line so the LLM still sees them. Empty arguments leave
    the body untouched.
    """
    args = arguments.strip()
    if "$ARGUMENTS" in command.body:
        return command.body.replace("$ARGUMENTS", args)
    if args:
        return f"{command.body}\n\n{args}"
    return command.body
