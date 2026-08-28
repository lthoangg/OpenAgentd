"""FastAPI dependency providers."""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.schemas import ChatForm
from app.core.config import Settings, settings
from app.core.db import async_session_factory, get_session

if TYPE_CHECKING:
    from app.agent.mode.team.runtime import SessionRuntime


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


# ── Team (optional — None when no agents are configured) ─────────────────────
# The team is built lazily on first use and evicted after an idle window;
# see ``app.services.team_manager``.  Route handlers receive whatever the
# manager hands back at request time (typically a live team, or ``None``
# when the agents directory is empty/missing).


async def get_team() -> "SessionRuntime | None":
    from app.services import team_manager

    return await team_manager.get_or_start_team()


TeamDep = Annotated["SessionRuntime | None", Depends(get_team)]


# ── Form body dependency ──────────────────────────────────────────────────────
# FastAPI < 1.0 cannot combine ``Annotated[Model, Form()]`` with ``File()``
# in the same endpoint.  ``ChatForm.as_form`` works around this by reading
# individual Form() fields and constructing the validated model.

ChatFormDep = Annotated[ChatForm, Depends(ChatForm.as_form)]
