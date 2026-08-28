"""Message — the wire shape for anything delivered into a session's inbox.

The inbox itself is a private ``asyncio.Queue`` on
:class:`~app.agent.mode.team.runtime.SessionRuntime`; this module only owns the
payload, which is also persisted (``is_broadcast`` lands in the message row's
``extra``).
"""

from __future__ import annotations

from uuid import uuid7
from datetime import datetime, timezone

from pydantic import BaseModel, Field


class Message(BaseModel):
    """A message sent between agents or from the user."""

    id: str = Field(default_factory=lambda: str(uuid7()))
    from_agent: str
    to_agent: str | None = None  # None = broadcast
    content: str
    is_broadcast: bool = False
    # Reports are persisted before mailbox delivery so they survive a daemon
    # restart. The receiving runtime injects that row without saving a
    # duplicate inbox row.
    persisted_message_id: str | None = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
