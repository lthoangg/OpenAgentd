"""team_manage tool — lead-only orchestrator capability management.

The lead agent uses this tool to grant or revoke skills, tools, or MCP
servers from a team member at runtime. Mutations are persisted by
rewriting the target member's ``.md`` frontmatter; the existing
config-drift hot-reload (``TeamMemberBase._refresh_agent_from_disk``)
picks up the change at the start of the member's next turn.

Use case: keep every member lean by default. When a task needs a
specialised capability (e.g. the ``shadcn`` MCP server), the lead grants
it just-in-time and revokes it once the work is done.

Validation runs *before* writing so typos can never be persisted into
``.md``. Resolution at agent-load time is soft (``loader.py`` warns and
skips unknown names) so the team stays robust if the underlying
registry shifts after a grant.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Literal

import yaml
from loguru import logger
from pydantic import Field

from app.agent.tools.registry import Tool

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


# Tools the lead must not be able to touch on a member: they are either
# always-on (``skill``), runtime-injected (``team_message``), or lead-only
# (``todo_manage``, ``schedule_task``, ``note``). Listing them in member
# frontmatter would either no-op or be silently ignored — surface the
# mistake instead.
_PROTECTED_TOOL_NAMES = frozenset(
    {"skill", "team_message", "todo_manage", "schedule_task", "note"}
)


_DESCRIPTION = (
    "Manage a team member's capabilities (skills, built-in tools, MCP servers) "
    "at runtime. Use this to grant a member a specialised capability just-in-time "
    "for a task, then revoke it when the work is done — keeps members focused. "
    "Action 'list' inspects current capabilities; 'add' / 'remove' edit the "
    "member's config file and the member auto-reloads on its next turn."
)


def make_team_manage_tool(team: "AgentTeam") -> Tool:
    """Return the ``team_manage`` tool bound to *team*. Lead-only."""

    async def team_manage(
        member: Annotated[
            str,
            Field(
                description=(
                    "Target member name (must be a regular member, not the lead). "
                    "Use the exact name from the team roster."
                )
            ),
        ],
        action: Annotated[
            Literal["add", "remove", "list"],
            Field(
                description=(
                    "'add' grants a capability; 'remove' revokes one; "
                    "'list' returns the member's current skills/tools/mcp."
                )
            ),
        ],
        kind: Annotated[
            Literal["skill", "tool", "mcp"] | None,
            Field(
                description=(
                    "Capability category. Required for 'add' and 'remove', "
                    "ignored by 'list'."
                )
            ),
        ] = None,
        name: Annotated[
            str | None,
            Field(
                description=(
                    "Capability name. For 'skill' use the skill id (e.g. "
                    "'web-research'); for 'tool' use a built-in tool name "
                    "(e.g. 'web_search'); for 'mcp' use a configured MCP "
                    "server name (e.g. 'shadcn'). Required for 'add' and "
                    "'remove', ignored by 'list'."
                )
            ),
        ] = None,
    ) -> str:
        """Grant or revoke a member's skill / tool / MCP server."""
        target = team.members.get(member)
        if target is None:
            available = sorted(team.members.keys())
            return (
                f"Member '{member}' not found. "
                f"Available members: {available}. "
                f"(The lead '{team.lead.name}' cannot be managed via team_manage.)"
            )

        source = target.agent.source_path
        if source is None:
            return (
                f"Member '{member}' has no source .md file (in-memory agent); "
                "team_manage requires a file-backed agent."
            )

        # ── action: list ──────────────────────────────────────────────
        if action == "list":
            # Read the on-disk frontmatter rather than the live agent so the
            # output reflects pending changes that the member hasn't reloaded
            # yet — which is what the lead actually needs to see.
            from app.agent.loader import parse_agent_md

            try:
                cfg = parse_agent_md(Path(source))
            except Exception as exc:
                # Malformed frontmatter (bad YAML, schema violation, missing
                # closing ---). Surface as a user-visible error instead of
                # crashing the LLM turn.
                return f"Failed to read '{member}': {exc}"
            return (
                f"Capabilities for '{member}' (from {Path(source).name}):\n"
                f"- skills: {sorted(cfg.skills)}\n"
                f"- tools:  {sorted(cfg.tools)}\n"
                f"- mcp:    {sorted(cfg.mcp)}"
            )

        # ── add / remove require kind + name ──────────────────────────
        if kind is None or name is None:
            return (
                f"Action '{action}' requires both 'kind' and 'name'. "
                "Example: team_manage(member='executor', action='add', "
                "kind='mcp', name='shadcn')."
            )

        # Validate name exists in the relevant registry. Done before any
        # disk write so typos cannot be persisted.
        validation_error = _validate_capability(kind, name)
        if validation_error:
            return validation_error

        # ── mutate frontmatter on disk ────────────────────────────────
        try:
            changed, message = _mutate_md_frontmatter(
                Path(source),
                action=action,
                kind=kind,
                name=name,
            )
        except Exception as exc:
            logger.warning(
                "team_manage_write_failed member={} action={} kind={} name={} error={}",
                member,
                action,
                kind,
                name,
                exc,
            )
            return f"Failed to update '{member}': {exc}"

        if not changed:
            return message  # already-present / not-present, no write

        logger.info(
            "team_manage member={} action={} kind={} name={}",
            member,
            action,
            kind,
            name,
        )
        return (
            f"{message} Member '{member}' will reload on its next turn "
            "(or now, if idle)."
        )

    return Tool(team_manage, name="team_manage", description=_DESCRIPTION)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_capability(kind: str, name: str) -> str | None:
    """Return an error string if the capability name is unknown, else ``None``."""
    if kind == "skill":
        from app.agent.tools.builtin.skill import discover_skills

        available = sorted(discover_skills().keys())
        if name not in available:
            return f"Unknown skill '{name}'. Available skills: {available}"
        return None

    if kind == "tool":
        if name in _PROTECTED_TOOL_NAMES:
            return (
                f"Tool '{name}' is managed automatically and cannot be granted "
                f"or revoked via team_manage (protected: {sorted(_PROTECTED_TOOL_NAMES)})."
            )
        # Lazy-import to avoid the loader -> manage circular dep.
        from app.agent.loader import _default_tool_registry

        registry = _default_tool_registry()
        # Filter to *configurable* built-ins: drop MCP-prefixed entries
        # (those are managed by kind='mcp') and protected names.
        configurable = sorted(
            n
            for n in registry
            if not n.startswith("mcp_") and n not in _PROTECTED_TOOL_NAMES
        )
        if name not in configurable:
            return f"Unknown tool '{name}'. Available tools: {configurable}"
        return None

    if kind == "mcp":
        from app.agent.mcp import mcp_manager

        servers = sorted(mcp_manager.server_names())
        if name not in servers:
            return f"Unknown MCP server '{name}'. Configured servers: {servers}"
        return None

    return f"Unknown kind '{kind}'. Use 'skill', 'tool', or 'mcp'."


# ---------------------------------------------------------------------------
# Frontmatter mutation
# ---------------------------------------------------------------------------


_FRONTMATTER_KEYS = {"skill": "skills", "tool": "tools", "mcp": "mcp"}


def _mutate_md_frontmatter(
    path: Path,
    *,
    action: Literal["add", "remove"],
    kind: str,
    name: str,
) -> tuple[bool, str]:
    """Add or remove *name* from the appropriate list in *path*'s frontmatter.

    Returns ``(changed, human_message)``. ``changed=False`` means the file
    was not written because the target was already in the desired state
    (idempotent).

    The body after the closing ``---`` is preserved verbatim. YAML key
    order and comments inside the frontmatter are *not* preserved — these
    files are machine-managed config; if humans add comments they should
    keep them in the body.
    """
    from app.agent.loader import _FRONTMATTER_RE

    text = path.read_text(encoding="utf-8")
    m = _FRONTMATTER_RE.match(text)
    if not m:
        raise ValueError(f"Agent file '{path}' is missing YAML frontmatter.")

    raw_meta = yaml.safe_load(m.group(1)) or {}
    body = m.group(2)

    key = _FRONTMATTER_KEYS[kind]
    current: list[str] = list(raw_meta.get(key) or [])

    if action == "add":
        if name in current:
            return False, f"'{name}' is already in {key} for this member."
        current.append(name)
    else:  # remove
        if name not in current:
            return False, f"'{name}' is not in {key} for this member."
        current = [n for n in current if n != name]

    raw_meta[key] = current

    new_yaml = yaml.safe_dump(raw_meta, sort_keys=False, allow_unicode=True).rstrip()
    new_text = f"---\n{new_yaml}\n---\n{body}"
    path.write_text(new_text, encoding="utf-8")

    verb = "Added" if action == "add" else "Removed"
    preposition = "to" if action == "add" else "from"
    return True, f"{verb} {kind} '{name}' {preposition} {key}."
