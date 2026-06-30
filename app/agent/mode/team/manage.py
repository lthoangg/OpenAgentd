"""Lead-only team roster management tools.

``team_manage`` owns the live roster: list spawnable blueprints and live
members, spawn member instances, and dismiss them in batches.
"""

from __future__ import annotations

from typing import Any, TYPE_CHECKING, Literal

from loguru import logger
from pydantic import BaseModel, Field, field_validator, model_validator

from app.agent.tools.registry import Tool

if TYPE_CHECKING:
    from app.agent.mode.team.team import AgentTeam


_MANAGE_DESCRIPTION = (
    "Manage the live team roster and discover spawnable member blueprints. "
    "Blueprint names vary by workspace; use only listed/available names. "
    "Spawn members before messaging them, reuse live/restorable handles when "
    "continuing related work, and dismiss only explicit live handles when they "
    "are no longer needed."
)


class TeamManageArgs(BaseModel):
    """Arguments for the team_manage tool."""

    action: Literal["spawn", "dismiss", "list"] = Field(
        description=(
            "'list' shows the current live member handles and the "
            "spawnable blueprints for this workspace; 'spawn' brings "
            "members online; 'dismiss' removes live instances from the "
            "roster while preserving history."
        )
    )
    members: list[str] = Field(
        default_factory=list,
        description=(
            "For list: pass an empty array and read back the live "
            "member handles plus spawnable blueprints. For spawn: pass "
            "listed/available blueprint names or restorable handles. "
            "For dismiss: pass explicit live handles. Multiple entries "
            "are processed left-to-right."
        ),
    )

    @field_validator("members", mode="before")
    @classmethod
    def coerce_members(cls, v: Any) -> Any:
        if v is None:
            return []
        if isinstance(v, str):
            text = v.strip()
            if not text:
                return []
            if text.startswith("[") and text.endswith("]"):
                try:
                    import json

                    parsed = json.loads(text)
                    if isinstance(parsed, list):
                        return [
                            str(item).strip() for item in parsed if str(item).strip()
                        ]
                except Exception:
                    pass
            return [item.strip() for item in text.split(",") if item.strip()]
        if isinstance(v, (list, tuple, set)):
            return [str(item).strip() for item in v if str(item).strip()]
        return [str(v).strip()]

    @model_validator(mode="after")
    def _validate_members(self) -> TeamManageArgs:
        if self.action in ("spawn", "dismiss"):
            if not self.members:
                raise ValueError(
                    f"members list cannot be empty for action='{self.action}'"
                )
        return self


def make_team_manage_tool(team: "AgentTeam") -> Tool:
    """Return the roster-management ``team_manage`` tool. Lead-only."""

    async def team_manage(
        action: Literal["spawn", "dismiss", "list"], members: list[str]
    ) -> str:
        """Spawn, dismiss, or list live member instances in a batch."""
        if action == "list":
            return _manage_list(team)

        if not members:
            return "No members provided."

        if action == "spawn":
            return await _manage_spawn(team, members)
        return await _manage_dismiss(team, members)

    return Tool(
        team_manage,
        name="team_manage",
        description=_MANAGE_DESCRIPTION,
        args_schema=TeamManageArgs,
    )


async def _manage_spawn(team: "AgentTeam", members: list[str]) -> str:
    spawned: list[str] = []
    already_live: list[str] = []
    errors: list[str] = []
    unknown_blueprints: list[str] = []

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
        except KeyError:
            unknown_blueprints.append(item)
        except Exception as exc:
            logger.exception("team_manage_spawn_failed member={}", item)
            errors.append(f"{item}: spawn failed: {exc}")
        else:
            spawned.append(member.name)

    if unknown_blueprints:
        available = sorted(team.blueprints.keys())
        errors.append(
            f"Unknown blueprints: {', '.join(unknown_blueprints)}. Available: {available}."
        )

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


def _manage_list(team: "AgentTeam") -> str:
    live = sorted(team.members.keys())
    blueprints = [
        f"{bp.name} — {bp.description}" if bp.description else bp.name
        for bp in sorted(team.blueprints.values(), key=lambda bp: bp.name)
    ]
    return _format_manage_result(
        ("Live", live),
        ("Spawnable blueprints", blueprints),
    )


def _format_manage_result(*groups: tuple[str, list[str]]) -> str:
    parts = [f"{label}: {', '.join(values)}." for label, values in groups if values]
    return " ".join(parts) if parts else "No changes."
