"""Lead agent team management tools — team_spawn, team_send, team_list, team_wait, team_stop."""

from __future__ import annotations

import json
from typing import Annotated, Literal

from pydantic import AliasChoices, BaseModel, Field, field_validator

from app.agent.tools.registry import InjectedArg, Tool
from app.core.db import DbFactory
from app.agent.providers.factory import ProviderFactory


class TeamSpawnArgs(BaseModel):
    profile: str = Field(
        description="Name of the member profile to instantiate (e.g. 'explorer', 'researcher', or custom profile)."
    )
    task: str = Field(
        description="Detailed task, query, or mission instructions for the subagent."
    )
    name: str | None = Field(
        default=None,
        description="Optional custom instance handle (e.g. 'explorer-fe'); defaults to monotonic profile#N.",
    )
    wait: bool = Field(
        default=True,
        description=(
            "If true, waits synchronously for member to finish or ask a question, returning "
            "the result directly in this tool call. If false, spawns in background."
        ),
    )
    model: str | None = Field(
        default=None,
        description="Optional model override for the subagent (e.g. 'googlegenai:gemini-3.1-flash').",
    )
    tools: list[str] | None = Field(
        default=None,
        description="Optional tool whitelist override to further restrict or augment profile tools.",
    )

    @field_validator("profile", "task")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field must not be blank")
        return v.strip()


class DelegateArgs(BaseModel):
    profile: str = Field(
        validation_alias=AliasChoices("profile", "agent", "member", "role"),
        description="Subagent profile name to delegate to (see available profiles in tool description).",
    )
    task: str = Field(
        validation_alias=AliasChoices("task", "message", "instruction", "query"),
        description="Detailed task instructions, questions, or clarification for the subagent.",
    )
    target: str | None = Field(
        default=None,
        validation_alias=AliasChoices("target", "member_id", "to"),
        description="Optional live subagent handle (e.g. 'explorer#1') to send follow-up instructions or answer a question. Omit to spawn a new instance.",
    )

    @field_validator("profile", "task")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field must not be blank")
        return v.strip()


def _build_delegate_description() -> str:
    from app.agent.loader import load_member_profiles
    from app.services.subagent_service import _resolve_agents_dir

    try:
        profiles = load_member_profiles(_resolve_agents_dir())
    except Exception:
        profiles = {}

    if profiles:
        profile_bullets = "\n".join(
            f"- profile='{name}': {p.description.strip()}"
            for name, p in sorted(profiles.items())
            if p.description
        )
        profiles_doc = f"\nAvailable subagent profiles:\n{profile_bullets}\n"
    else:
        profiles_doc = "\n"

    return (
        "Delegate a focused task to a specialized subagent running asynchronously in the background. "
        "Returns immediately after dispatching; the subagent will automatically send its deliverable "
        f"back to you as a message when finished.{profiles_doc}"
        "To reply to a subagent that asked a question or send follow-up instructions, "
        "provide target='<handle>' (e.g. target='explorer#1')."
    )


def make_delegate_tool(
    lead_session_id: str,
    db_factory: DbFactory,
    provider_factory: ProviderFactory | None = None,
) -> Tool:
    """Return the single delegate tool for the lead agent."""

    async def delegate(
        profile: str,
        task: str,
        target: str | None = None,
        _workspace: Annotated[str, InjectedArg()] = "",
    ) -> str:
        from app.services.subagent_service import (
            spawn_subagent,
            send_subagent_message,
        )

        try:
            if target:
                res = await send_subagent_message(
                    lead_session_id=lead_session_id,
                    member_id=target,
                    message=task,
                    wait=False,
                    db_factory=db_factory,
                )
            else:
                res = await spawn_subagent(
                    lead_session_id=lead_session_id,
                    profile=profile,
                    task=task,
                    wait=False,
                    workspace=_workspace,
                    db_factory=db_factory,
                    provider_factory=provider_factory,
                )

            if target:
                member_id = res.get("member_id", target)
                return (
                    f"Message delivered to subagent '{member_id}'. It is running in the "
                    "background and will deliver its response as a message to you once finished."
                )

            member_id = res.get("member_id", profile)
            return (
                f"Subagent '{member_id}' dispatched with task: {task}\n"
                "It is running asynchronously in the background. You will receive its "
                "deliverable as a user message once it completes."
            )
        except Exception as exc:
            return f"Error delegating to subagent: {exc}"

    return Tool(
        delegate,
        name="delegate",
        description=_build_delegate_description,
        args_schema=DelegateArgs,
    )


class TeamSendArgs(BaseModel):
    member_id: str = Field(
        validation_alias=AliasChoices("member_id", "member", "to", "target"),
        description="Exact live handle (e.g. 'explorer#1') or bare profile name if unique.",
    )
    message: str = Field(
        validation_alias=AliasChoices("message", "content", "instruction", "text"),
        description="Instruction, clarification, or answer to member's question.",
    )
    wait: bool = Field(
        default=True,
        description="If true, waits for member turn to finish and returns reply.",
    )

    @field_validator("member_id", "message")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field must not be blank")
        return v.strip()


class TeamListArgs(BaseModel):
    pass


class TeamWaitArgs(BaseModel):
    member_ids: list[str] | None = Field(
        default=None,
        description="Specific member IDs to await; omit to await all running members.",
    )
    timeout: int = Field(
        default=120,
        description="Maximum seconds to wait before returning current statuses.",
    )


class TeamStopArgs(BaseModel):
    member_id: str = Field(
        description="Member ID or handle to stop (e.g. 'explorer#1')."
    )


class TeamManageArgs(BaseModel):
    action: Literal["list", "wait", "stop"] = Field(
        description="Action to perform: 'list' (subagents roster), 'wait' (await background tasks), or 'stop' (cancel an active subagent)."
    )
    member_id: str | None = Field(
        default=None,
        description="Target member ID for 'stop' or single 'wait' (e.g. 'explorer#1').",
    )
    member_ids: list[str] | None = Field(
        default=None,
        description="Optional list of member IDs for 'wait'; omit to await all running members.",
    )
    timeout: int = Field(
        default=120,
        description="Maximum seconds to wait when action='wait'.",
    )


def make_team_spawn_tool(
    lead_session_id: str,
    db_factory: DbFactory,
    provider_factory: ProviderFactory | None = None,
) -> Tool:
    """Return the team_spawn tool bound to a lead session."""

    async def team_spawn(
        profile: str,
        task: str,
        name: str | None = None,
        wait: bool = True,
        model: str | None = None,
        tools: list[str] | None = None,
        _workspace: Annotated[str, InjectedArg()] = "",
    ) -> str:
        from app.services.subagent_service import spawn_subagent

        try:
            res = await spawn_subagent(
                lead_session_id=lead_session_id,
                profile=profile,
                task=task,
                name=name,
                wait=wait,
                tools_override=tools,
                model_override=model,
                workspace=_workspace,
                db_factory=db_factory,
                provider_factory=provider_factory,
            )
            return json.dumps(res, indent=2)
        except Exception as exc:
            return f"Error spawning subagent: {exc}"

    return Tool(
        team_spawn,
        name="team_spawn",
        description=(
            "Spawn a specialized subagent from a profile (e.g. 'explorer', 'researcher') "
            "to work on a focused subtask. Multiple instances of the same profile get handles "
            "like 'explorer#1', 'explorer#2'. Set wait=True to block and receive results in this "
            "turn, or wait=False to run in the background."
        ),
        args_schema=TeamSpawnArgs,
    )


def make_team_send_tool(lead_session_id: str, db_factory: DbFactory) -> Tool:
    """Return the team_send tool bound to a lead session."""

    async def team_send(
        member_id: str,
        message: str,
        wait: bool = True,
    ) -> str:
        from app.services.subagent_service import send_subagent_message

        try:
            res = await send_subagent_message(
                lead_session_id=lead_session_id,
                member_id=member_id,
                message=message,
                wait=wait,
                db_factory=db_factory,
            )
            return json.dumps(res, indent=2)
        except Exception as exc:
            return f"Error sending message to subagent: {exc}"

    return Tool(
        team_send,
        name="team_send",
        description=(
            "Send follow-up instructions or answer a pending question from a subagent "
            "(e.g. 'explorer#1'). Set wait=True to wait for the subagent's reply."
        ),
        args_schema=TeamSendArgs,
    )


def make_team_manage_tool(
    lead_session_id: str,
    db_factory: DbFactory,
) -> Tool:
    """Return the team_manage tool bound to a lead session."""

    async def team_manage(
        action: Literal["list", "wait", "stop"],
        member_id: str | None = None,
        member_ids: list[str] | None = None,
        timeout: int = 120,
    ) -> str:
        from app.services.subagent_service import (
            list_subagents,
            stop_subagent,
            wait_subagents,
        )

        try:
            if action == "list":
                res = await list_subagents(lead_session_id, db_factory=db_factory)
                return json.dumps(res, indent=2)
            elif action == "wait":
                ids = member_ids or ([member_id] if member_id else None)
                res = await wait_subagents(
                    lead_session_id=lead_session_id,
                    member_ids=ids,
                    timeout=timeout,
                    db_factory=db_factory,
                )
                return json.dumps(res, indent=2)
            elif action == "stop":
                if not member_id:
                    return "Error: member_id is required for action='stop'."
                res = await stop_subagent(lead_session_id, member_id)
                return json.dumps(res, indent=2)
            else:
                return (
                    f"Error: unknown action '{action}'. Use 'list', 'wait', or 'stop'."
                )
        except Exception as exc:
            return f"Error in team_manage: {exc}"

    return Tool(
        team_manage,
        name="team_manage",
        description=(
            "Auxiliary management for subagents: action='list' inspects the subagent roster and statuses, "
            "action='wait' awaits running background subagents, action='stop' aborts an active subagent."
        ),
        args_schema=TeamManageArgs,
    )


def make_team_list_tool(
    lead_session_id: str, db_factory: DbFactory | None = None
) -> Tool:
    """Return the team_list tool bound to a lead session."""

    async def team_list() -> str:
        from app.services.subagent_service import list_subagents

        try:
            data = await list_subagents(lead_session_id, db_factory=db_factory)
            return json.dumps(data, indent=2)
        except Exception as exc:
            return f"Error listing subagents: {exc}"

    return Tool(
        team_list,
        name="team_list",
        description="List available member profiles and active subagent instances under this session.",
        args_schema=TeamListArgs,
    )


def make_team_wait_tool(lead_session_id: str, db_factory: DbFactory) -> Tool:
    """Return the team_wait tool bound to a lead session."""

    async def team_wait(
        member_ids: list[str] | None = None,
        timeout: int = 120,
    ) -> str:
        from app.services.subagent_service import wait_subagents

        try:
            res = await wait_subagents(
                lead_session_id=lead_session_id,
                member_ids=member_ids,
                timeout=timeout,
                db_factory=db_factory,
            )
            return json.dumps(res, indent=2)
        except Exception as exc:
            return f"Error awaiting subagents: {exc}"

    return Tool(
        team_wait,
        name="team_wait",
        description="Wait for running background subagents to complete and collect their outputs.",
        args_schema=TeamWaitArgs,
    )


def make_team_stop_tool(lead_session_id: str) -> Tool:
    """Return the team_stop tool bound to a lead session."""

    async def team_stop(member_id: str) -> str:
        from app.services.subagent_service import stop_subagent

        try:
            res = await stop_subagent(lead_session_id, member_id)
            return json.dumps(res, indent=2)
        except Exception as exc:
            return f"Error stopping subagent: {exc}"

    return Tool(
        team_stop,
        name="team_stop",
        description="Stop and cancel an active subagent instance (e.g. 'explorer#1').",
        args_schema=TeamStopArgs,
    )
