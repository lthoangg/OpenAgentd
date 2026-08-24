"""``openagentd run`` — execute one foreground coding-agent turn."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from uuid import uuid7

from app.api.routes.agents import is_registered_model_id
from app.core.db import run_migrations
from app.core.logging_config import setup_logging
from app.core.workspace_init import ensure_workspace_initialized
from app.services import (
    agent_service,
    memory_stream_store as stream_store,
    team_manager,
)


def _normalized_override(value: str | None) -> str | None:
    """Return a non-empty CLI override without accepting whitespace-only values."""
    return value.strip() if value and value.strip() else None


def _event_data(event: dict[str, str]) -> dict:
    """Decode a stream event payload, treating malformed payloads as empty."""
    try:
        data = json.loads(event.get("data", "{}"))
    except (TypeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _run_migrations_quietly() -> None:
    """Apply migrations without Alembic's routine foreground INFO output."""
    run_migrations(quiet_alembic=True)


async def _run(args: argparse.Namespace) -> None:
    """Dispatch one current-directory coding turn and mirror lead text to stdout."""
    prompt = args.prompt
    if not prompt.strip():
        raise SystemExit("--prompt must not be blank.")

    model = _normalized_override(args.model)
    thinking_level = _normalized_override(args.thinking)
    if model and not await is_registered_model_id(model):
        raise SystemExit("Choose a model from the registry.")

    ensure_workspace_initialized()
    _run_migrations_quietly()

    session_id = str(uuid7())
    workspace = team_manager.validate_workspace(str(Path.cwd()))
    team = await team_manager.get_or_start_coding_team(workspace, session_id)

    session_id, _, _ = await agent_service.dispatch_user_message(
        team,
        content=prompt,
        session_id=session_id,
        mode="coding",
        workspace=workspace,
        model=model,
        thinking_level=thinking_level,
    )

    wrote_text = False
    terminal_error: str | None = None
    async for event in stream_store.attach(session_id):
        event_type = event.get("event")
        data = _event_data(event)

        if event_type == "message" and data.get("agent") == team.lead.name:
            text = data.get("text")
            if isinstance(text, str) and text:
                print(text, end="", flush=True)
                wrote_text = True
            continue

        if event_type == "error":
            terminal_error = data.get("title") or data.get("code") or "Agent run failed"
            continue

        if event_type == "agent_not_configured":
            terminal_error = data.get("message") or "The lead agent is not configured."
            continue

        if event_type == "question_asked":
            await agent_service.interrupt_team(team, session_id)
            terminal_error = "Non-interactive run cannot answer agent questions."
            break

    if wrote_text:
        print()
    if terminal_error:
        print(terminal_error, file=sys.stderr)
        raise SystemExit(terminal_error)


def cmd_run(args: argparse.Namespace) -> None:
    """Run one non-interactive foreground agent turn."""
    setup_logging(log_level="ERROR")
    try:
        asyncio.run(_run(args))
    except SystemExit:
        raise
    except Exception:
        raise SystemExit("Unable to run the agent; check backend logs.") from None
