"""Lead-only team roster and capability management tools.

``team_manage`` owns the live roster: spawn or dismiss member instances in
batches. ``team_configure`` owns capability changes: grant/revoke skills,
built-in tools, or MCP servers for a live member.

The split keeps the lead's mental model simple: ``team_manage`` controls who
is online, while ``team_configure`` controls what an online member can do.

Capability mutations apply only to the live member instance in the current
team/session. They are intentionally not persisted to blueprint ``.md`` files;
self-healing/manual settings edits own durable root config changes.

Validation runs before mutating the live instance so typos fail loudly.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Literal

from loguru import logger
from pydantic import Field

from app.agent.tools.registry import Tool

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


# Tools the lead must not be able to touch on a member: they are either
# always-on (``skill``), runtime-injected (``team_message``), or lead-only
# (``todo_manage``, ``schedule_task``, ``note``). Granting or revoking them
# at runtime would either no-op or break protocol invariants — surface the
# mistake instead.
_PROTECTED_TOOL_NAMES = frozenset(
    {"skill", "team_message", "todo_manage", "schedule_task", "note"}
)


_MANAGE_DESCRIPTION = (
    "Manage the live team roster and discover spawnable member blueprints. "
    "Use action='spawn' with blueprint names like 'executor' to create the next "
    "instance; repeat a blueprint name to create parallel instances. Use explicit "
    "handles like 'executor#1' to restore/reuse that instance's history when a "
    "follow-up continues or corrects prior work. Prefer keeping useful members "
    "alive across turns and re-messaging the same live handle — reusing a live "
    "instance preserves its warm context and is faster and cheaper than "
    "dismiss-then-respawn. Use action='dismiss' with explicit live handles like "
    "'executor#1' only when an instance clearly won't be reused or the roster is "
    "cluttered; history is preserved either way. Accepts multiple members in one "
    "call. Available blueprints and any live/restorable handles are surfaced in "
    "this tool's results and in validation errors for unknown blueprints. If no "
    "blueprints are configured, no member blueprints are available to spawn."
)


_CONFIGURE_DESCRIPTION = (
    "Manage a live team member's capabilities (skills, built-in tools, MCP servers). "
    "Use this to grant a member a specialised capability just-in-time for a task, "
    "then revoke it when the work is done — keeps members focused. Action 'list' "
    "inspects current capabilities; 'add' / 'remove' affect the current live member "
    "only. Use self-healing/settings edits for persistent blueprint/root changes."
)


def make_team_manage_tool(team: "AgentTeam") -> Tool:
    """Return the roster-management ``team_manage`` tool. Lead-only."""

    async def team_manage(
        action: Annotated[
            Literal["spawn", "dismiss"],
            Field(
                description=(
                    "'spawn' brings members online; 'dismiss' removes live "
                    "instances from the roster while preserving history."
                )
            ),
        ],
        members: Annotated[
            list[str],
            Field(
                description=(
                    "For spawn: blueprint names ('executor') create the next "
                    "available instance, explicit handles ('executor#1') "
                    "restore/reuse that exact history. For dismiss: pass "
                    "explicit live handles ('executor#1'). Multiple entries "
                    "are processed left-to-right."
                )
            ),
        ],
    ) -> str:
        """Spawn or dismiss live member instances in a batch."""
        if not members:
            return "No members provided."

        if action == "spawn":
            return await _manage_spawn(team, members)
        return await _manage_dismiss(team, members)

    return Tool(team_manage, name="team_manage", description=_MANAGE_DESCRIPTION)


async def _manage_spawn(team: "AgentTeam", members: list[str]) -> str:
    spawned: list[str] = []
    already_live: list[str] = []
    errors: list[str] = []

    from app.agent.mode.team.team import parse_instance_handle

    for item in members:
        item = item.strip()
        if not item:
            errors.append("empty member name")
            continue

        parsed = parse_instance_handle(item)
        if parsed is None:
            blueprint = item
            instance_id = None
        else:
            blueprint, instance_id = parsed

        try:
            member = await team.spawn(blueprint, instance_id=instance_id)
        except ValueError as exc:
            if "already live" in str(exc):
                already_live.append(item)
            else:
                errors.append(f"{item}: {exc}")
        except KeyError as exc:
            errors.append(str(exc))
        except Exception as exc:
            logger.exception("team_manage_spawn_failed member={}", item)
            errors.append(f"{item}: spawn failed: {exc}")
        else:
            spawned.append(member.name)

    return _format_manage_result(
        ("Spawned", spawned),
        ("Already live", already_live),
        ("Errors", errors),
    )


async def _manage_dismiss(team: "AgentTeam", members: list[str]) -> str:
    dismissed: list[str] = []
    not_live: list[str] = []
    errors: list[str] = []

    from app.agent.mode.team.team import parse_instance_handle

    for item in members:
        item = item.strip()
        if not item:
            errors.append("empty member name")
            continue
        if item == team.lead.name:
            errors.append(f"Cannot dismiss the team lead '{item}'")
            continue
        if parse_instance_handle(item) is None:
            matches = team.live_instances_for_blueprint(item)
            if matches:
                errors.append(
                    f"Use explicit handles for dismissing '{item}': {matches}"
                )
            else:
                errors.append(
                    f"Use explicit handles for dismiss; '{item}' is not a live handle."
                )
            continue

        try:
            found = await team.dismiss(item)
        except Exception as exc:
            logger.exception("team_manage_dismiss_failed member={}", item)
            errors.append(f"{item}: dismiss failed: {exc}")
            continue

        if found:
            dismissed.append(item)
        else:
            not_live.append(item)

    return _format_manage_result(
        ("Dismissed", dismissed),
        ("Not live", not_live),
        ("Errors", errors),
    )


def _format_manage_result(*groups: tuple[str, list[str]]) -> str:
    parts = [f"{label}: {', '.join(values)}." for label, values in groups if values]
    return " ".join(parts) if parts else "No changes."


def make_team_configure_tool(team: "AgentTeam") -> Tool:
    """Return the ``team_configure`` tool bound to *team*. Lead-only."""

    async def team_configure(
        member: Annotated[
            str,
            Field(
                description=(
                    "Target member handle (must be a regular member, not the lead). "
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
                    "'mcp-installer'); for 'tool' use a built-in tool name "
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
                f"(The lead '{team.lead.name}' cannot be configured.)"
            )

        # ── action: list ──────────────────────────────────────────────
        if action == "list":
            return (
                f"Capabilities for live member '{member}' in this session:\n"
                f"- skills: {sorted(target.agent.skills)}\n"
                f"- tools:  {sorted(target.agent._tools)}\n"
                f"- mcp:    {sorted(target.agent.mcp_servers)}"
            )

        # ── add / remove require kind + name ──────────────────────────
        if kind is None or name is None:
            return (
                f"Action '{action}' requires both 'kind' and 'name'. "
                "Example: team_configure(member='executor#1', action='add', "
                "kind='mcp', name='shadcn')."
            )

        # Validate name exists in the relevant registry. Done before any
        # disk write so typos cannot be persisted.
        validation_error = _validate_capability(kind, name)
        if validation_error:
            return validation_error

        changed, message = _mutate_live_member_capability(
            target,
            action=action,
            kind=kind,
            name=name,
        )

        if not changed:
            return message  # already-present / not-present, no write

        logger.info(
            "team_configure member={} action={} kind={} name={}",
            member,
            action,
            kind,
            name,
        )
        return (
            f"{message} This affects only live member '{member}' in the current "
            "team session. Use self-healing/settings to persist blueprint changes."
        )

    return Tool(
        team_configure, name="team_configure", description=_CONFIGURE_DESCRIPTION
    )


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
# Live capability mutation
# ---------------------------------------------------------------------------


def _mutate_live_member_capability(
    target,
    *,
    action: Literal["add", "remove"],
    kind: str,
    name: str,
) -> tuple[bool, str]:
    """Add/remove one capability on the live member instance only."""
    agent = target.agent

    if kind == "skill":
        current = agent.skills
    elif kind == "mcp":
        current = agent.mcp_servers
    elif kind == "tool":
        current = list(agent._tools)
    else:
        return False, f"Unknown kind '{kind}'. Use 'skill', 'tool', or 'mcp'."

    if action == "add":
        if name in current:
            return False, f"'{name}' is already enabled for this live member."
        if kind == "tool":
            from app.agent.loader import _default_tool_registry

            registry = _default_tool_registry()
            tool = registry.get(name)
            if tool is None:
                return False, f"Tool '{name}' is no longer available."
            agent._tools[name] = tool
        elif kind == "mcp":
            from app.agent.mcp import mcp_manager

            server_tools = mcp_manager.get_tools_for_server(name)
            agent.mcp_servers.append(name)
            for tool in server_tools or []:
                agent._tools.setdefault(tool.name, tool)
        else:
            agent.skills.append(name)
    else:  # remove
        if name not in current:
            return False, f"'{name}' is not enabled for this live member."
        if kind == "tool":
            agent._tools.pop(name, None)
        elif kind == "mcp":
            agent.mcp_servers = [n for n in agent.mcp_servers if n != name]
            prefix = f"mcp_{name}_"
            for tool_name in [n for n in agent._tools if n.startswith(prefix)]:
                agent._tools.pop(tool_name, None)
        else:
            agent.skills = [n for n in agent.skills if n != name]

    verb = "Added" if action == "add" else "Removed"
    preposition = "to" if action == "add" else "from"
    return True, f"{verb} {kind} '{name}' {preposition} live member capabilities."
