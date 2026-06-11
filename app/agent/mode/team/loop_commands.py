"""Loop slash-command parsing for team sessions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

from app.services.commands import parse_slash_invocation

_LOOP_LIMITS = {5, 10, 20, 50}


@dataclass
class LoopState:
    prompt: str
    remaining: int
    paused: bool = False


@dataclass(frozen=True)
class LoopCommand:
    action: Literal["start", "set", "pause", "resume", "stop"]
    prompt: str | None = None
    limit: int | None = None


def loop_status_payload(
    *,
    prompt: str | None,
    limit: int,
    remaining: int,
    paused: bool = False,
) -> dict[str, object]:
    used = max(limit - remaining, 0)
    return {
        "prompt": prompt,
        "limit": limit,
        "remaining": remaining,
        "used": used,
        "paused": paused,
    }


def parse_loop_command(content: str) -> LoopCommand | None:
    invocation = parse_slash_invocation(content)
    if invocation is None or invocation.command != "loop":
        return None

    if invocation.subcommand is None:
        prompt = invocation.arguments.strip()
        return LoopCommand(action="start", prompt=prompt) if prompt else None

    if invocation.subcommand == "set":
        if len(invocation.argv) != 1 or not invocation.argv[0].isdigit():
            return None
        limit = int(invocation.argv[0])
        if limit not in _LOOP_LIMITS:
            return None
        return LoopCommand(action="set", limit=limit)

    if invocation.subcommand not in {"pause", "resume", "stop"} or invocation.argv:
        return None
    action = cast(Literal["pause", "resume", "stop"], invocation.subcommand)
    return LoopCommand(action=action)


def is_loop_command(content: str) -> bool:
    invocation = parse_slash_invocation(content)
    return invocation is not None and invocation.command == "loop"
