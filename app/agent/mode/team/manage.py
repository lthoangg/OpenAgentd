"""Lead-only team roster management tools.

``team_manage`` owns the live roster: spawn or dismiss member instances in
batches.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Literal

from loguru import logger
from pydantic import Field

from app.agent.tools.registry import Tool

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


_MANAGE_DESCRIPTION = (
    "Manage the live team roster and discover spawnable member blueprints. "
    "Blueprint names vary by workspace; use only listed/available names. "
    "Spawn members before messaging them, reuse live/restorable handles when "
    "continuing related work, and dismiss only explicit live handles when they "
    "are no longer needed. Tool results and validation errors include available "
    "blueprints and live/restorable handles."
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
                    "For spawn: pass listed/available blueprint names or "
                    "restorable handles. For dismiss: pass explicit live handles. "
                    "Multiple entries are processed left-to-right."
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
