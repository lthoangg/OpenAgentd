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
from functools import lru_cache
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
_MAX_CACHED_COMMAND_PARSES = 256
_MAX_CACHED_COMMAND_BYTES = 128 * 1024


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


def _read_command_file(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    meta, body = _parse_frontmatter(text)
    description = meta.get("description", "")
    if not isinstance(description, str):
        description = ""
    return description.strip(), body


@lru_cache(maxsize=_MAX_CACHED_COMMAND_PARSES)
def _parse_command_file(
    path: Path, _signature: tuple[int, int, int, int, int]
) -> tuple[str, str]:
    """Read and parse a command file identified by its stat signature."""
    return _read_command_file(path)


def _cached_command_content(path: Path) -> tuple[str, str] | None:
    """Return parsed command content, reusing an unchanged file's result."""
    try:
        stat = path.stat()
    except OSError:
        return None
    try:
        if stat.st_size > _MAX_CACHED_COMMAND_BYTES:
            return _read_command_file(path)
        signature = (
            stat.st_mtime_ns,
            stat.st_ctime_ns,
            stat.st_size,
            stat.st_mode,
            stat.st_ino,
        )
        return _parse_command_file(path, signature)
    except OSError:
        return None


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
Create or update AGENTS.md files for this repository. The reader is a future \
coding agent with the full source tree but no memory. Write only what it \
cannot quickly infer from the code.

Root AGENTS.md is special: it is injected into the system prompt on every task. \
Keep it stricter than every child file. Child AGENTS.md files are read only on \
demand, so move local detail down.

TEST EVERY LINE
\"Would an agent get this wrong, or waste real time, without being told?\"
If no, cut it. Do not restate the code. Keep only non-obvious conventions, \
coupling, prerequisites, sharp edges, and rationale. For root, keep only facts \
that are repo-wide and useful on most tasks.

KEEP
- Where to start for a given change.
- Files, tests, or docs that must change together.
- Non-obvious commands, flags, order, or prerequisites.
- Setup that causes silent failure when missing.
- Conventions not enforced by tooling.
- Traps where the obvious edit is wrong.

CUT
- Anything obvious from reading nearby files.
- README restatements, framework basics, long file/dependency lists.
- Version numbers and other fast-drifting facts.
- Folder-specific detail that belongs in a child file.

SHOW CONCRETE COUPLING
Bad: \"api/ holds the API routes.\"
Good: \"Add routes under api/routes/ and register them in api/registry; \
unregistered routes 404 silently.\"

TREE RULES
- Root is the only guaranteed entry point; every other AGENTS.md must be \
  reachable from it by relative links, hop by hop.
- Each file indexes only its immediate children and the few local docs worth \
  knowing, each with a one-line \"go here when…\" note.
- Use relative links only; do not dump the full descendant tree.
- Root must include: (1) one-line usage protocol, (2) immediate-child index, \
  (3) cross-cutting repo-wide guidance only.

WHEN TO CREATE A CHILD FILE
Create a child AGENTS.md only when a subtree has local conventions, local \
commands, distinct architecture, or real traps. If a folder is \"more of the \
same,\" keep it as one line in the parent index. Do not create AGENTS.md in \
generated, vendored, cache, or build-output directories.

PROCESS
1. Survey the actual repo structure, stack, commands, conventions, and ignore \
   rules before writing.
2. Read existing AGENTS.md files first, including parents. Preserve accurate \
   notes; change only what is stale or misleading.
3. Plan the file tree before editing. Push detail downward by default.
4. Draft, then prune hard. Keep each file short; root should be especially \
   compact. If nothing survives pruning, do not create the file.
5. Verify documented commands when feasible. Quote commands exactly as defined \
   in repo files; do not normalize or improve them. If checks are blocked by \
   environment or missing services, document the condition instead of changing \
   code.
6. Reconcile links so no real doc is orphaned. In your final response, include \
   a manifest of files created, updated, or deliberately skipped, with one-line \
   reasons.

GUARDRAILS
- Document only what exists; never invent features or commands.
- Never copy secrets or env-file contents.
- On re-run, prefer minimal diffs; do not churn correct files."""


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
            content = _cached_command_content(path)
            if content is None:
                continue
            description, body = content
            commands[name] = Command(
                name=name,
                description=description,
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
