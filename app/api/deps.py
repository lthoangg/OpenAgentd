"""FastAPI dependency providers."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.schemas import ChatForm
from app.core.config import Settings, settings
from app.core.db import async_session_factory, get_session

if TYPE_CHECKING:
    from app.agent.session import AgentSession


# ── Settings ─────────────────────────────────────────────────────────────────


@lru_cache
def get_settings() -> Settings:
    return settings


SettingsDep = Annotated[Settings, Depends(get_settings)]


# ── DB session ────────────────────────────────────────────────────────────────


DbSession = Annotated[AsyncSession, Depends(get_session)]


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    return async_session_factory


DbSessionFactory = Annotated[
    async_sessionmaker[AsyncSession], Depends(get_session_factory)
]


# ── Agent session (optional — None when no agent is configured) ──────────────
# The session is built lazily on first use and evicted after an idle window;
# see ``app.services.agent_manager``. Route handlers receive whatever the
# manager hands back at request time, or ``None`` when configuration is absent.


async def get_agent_session() -> "AgentSession | None":
    from app.services import agent_manager

    return await agent_manager.get_or_start_agent_session(str(Path.cwd()), None)


AgentSessionDep = Annotated["AgentSession | None", Depends(get_agent_session)]


# ── Form body dependency ──────────────────────────────────────────────────────
# FastAPI < 1.0 cannot combine ``Annotated[Model, Form()]`` with ``File()``
# in the same endpoint.  ``ChatForm.as_form`` works around this by reading
# individual Form() fields and constructing the validated model.

ChatFormDep = Annotated[ChatForm, Depends(ChatForm.as_form)]
