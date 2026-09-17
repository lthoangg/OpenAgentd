"""Lead agent team delegation tool — delegate."""

from __future__ import annotations

from typing import Annotated

from pydantic import AliasChoices, BaseModel, Field, field_validator

from app.agent.tools.registry import InjectedArg, Tool
from app.core.db import DbFactory
from app.agent.providers.factory import ProviderFactory


class DelegateArgs(BaseModel):
    profile: str = Field(
        validation_alias=AliasChoices("profile", "agent", "member", "role"),
        description="Subagent profile name to delegate to (see available profiles in tool description).",
    )
    task: str = Field(
        validation_alias=AliasChoices("task", "message", "instruction", "query"),
        description=(
            "Detailed, bounded task instructions with explicit expected deliverables. "
            "Specify target files, symbols, or questions, and the desired return format. "
            "When replying to a subagent's question, provide the concrete decision."
        ),
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
    from loguru import logger

    from app.agent.loader import load_member_profiles
    from app.services.subagent_service import _resolve_agents_dir

    try:
        profiles = load_member_profiles(_resolve_agents_dir())
    except Exception as exc:
        logger.warning("failed_to_load_member_profiles_for_delegate error={}", exc)
        profiles = {}

    if profiles:
        profile_bullets = "\n".join(
            f"- profile='{name}': {p.description.strip()}"
            if p.description and p.description.strip()
            else f"- profile='{name}'"
            for name, p in sorted(profiles.items())
        )
        profiles_doc = f"\n\nAvailable subagent profiles:\n{profile_bullets}\n\n"
    else:
        profiles_doc = "\n\n"

    return (
        "Delegate a focused task to a specialized subagent running asynchronously in the background. "
        "Returns immediately after dispatching; the subagent will automatically send its deliverable "
        f"back to you as a message when finished.{profiles_doc}"
        "To run tasks concurrently, call delegate multiple times in the same turn. "
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
