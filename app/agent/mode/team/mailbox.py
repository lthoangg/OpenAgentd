"""TeamMailbox — per-agent asyncio.Queue inboxes with on-message callbacks."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from uuid import uuid7
from datetime import datetime, timezone

from pydantic import BaseModel, Field

# Bound on per-agent inbox backlog. Generous for normal operation (a
# healthy member drains its inbox almost immediately) while capping memory
# if a member is stalled/erroring and never drains.
_MAX_INBOX_BACKLOG = 500


class Message(BaseModel):
    """A message sent between agents or from the user."""

    id: str = Field(default_factory=lambda: str(uuid7()))
    from_agent: str
    to_agent: str | None = None  # None = broadcast
    content: str
    is_broadcast: bool = False
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# Callback type: async fn(agent_name, message) → None
OnMessageCallback = Callable[[str, Message], Awaitable[None]]


class TeamMailbox:
    """Per-agent inbox queues with on-message activation callbacks.

    Every agent registers by name before use.  ``send`` delivers to a single
    inbox.

    An optional ``on_message`` callback is invoked after every successful
    ``send``.  This is the activation hook: the team uses it to spawn a
    processing task for the receiving agent when a message arrives.
    """

    def __init__(self, on_message: OnMessageCallback | None = None) -> None:
        self._inboxes: dict[str, asyncio.Queue[Message]] = {}
        self._on_message = on_message

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    def register(self, agent_name: str) -> None:
        """Register an inbox for the given agent name (idempotent)."""
        if agent_name not in self._inboxes:
            self._inboxes[agent_name] = asyncio.Queue()

    def deregister(self, agent_name: str) -> None:
        """Remove an agent's inbox. Undelivered messages are discarded."""
        self._inboxes.pop(agent_name, None)

    # ------------------------------------------------------------------
    # Sending
    # ------------------------------------------------------------------

    @staticmethod
    def _put_bounded(inbox: asyncio.Queue[Message], message: Message) -> None:
        """Enqueue *message*, dropping the oldest queued one past the backlog cap.

        Inboxes have no ``maxsize`` so ``put`` never blocks the sender — a
        stalled/erroring member that never drains its inbox would otherwise
        accumulate messages (and their content) without bound. Dropping the
        oldest pending message keeps memory bounded and favors the most
        recent context once the member recovers.
        """
        if inbox.qsize() >= _MAX_INBOX_BACKLOG:
            try:
                inbox.get_nowait()
            except asyncio.QueueEmpty:
                pass
        inbox.put_nowait(message)

    async def send(self, to: str, message: Message) -> None:
        """Deliver *message* to a single named inbox."""
        if to not in self._inboxes:
            raise KeyError(f"No inbox registered for agent '{to}'")
        self._put_bounded(self._inboxes[to], message)
        if self._on_message is not None:
            await self._on_message(to, message)

    # ------------------------------------------------------------------
    # Receiving
    # ------------------------------------------------------------------

    async def receive(self, agent_name: str) -> Message:
        """Block until a message arrives in *agent_name*'s inbox."""
        if agent_name not in self._inboxes:
            raise KeyError(f"No inbox registered for agent '{agent_name}'")
        return await self._inboxes[agent_name].get()

    def receive_nowait(self, agent_name: str) -> Message:
        """Return the next message immediately or raise ``asyncio.QueueEmpty``."""
        if agent_name not in self._inboxes:
            raise KeyError(f"No inbox registered for agent '{agent_name}'")
        return self._inboxes[agent_name].get_nowait()

    def inbox_empty(self, agent_name: str) -> bool:
        """Return True if the named inbox has no pending messages."""
        if agent_name not in self._inboxes:
            return True
        return self._inboxes[agent_name].empty()

    def discard_pending(self, agent_name: str) -> int:
        """Discard queued messages for an interrupted activation."""
        inbox = self._inboxes.get(agent_name)
        if inbox is None:
            return 0
        discarded = 0
        while True:
            try:
                inbox.get_nowait()
            except asyncio.QueueEmpty:
                return discarded
            discarded += 1

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    @property
    def registered_agents(self) -> list[str]:
        return list(self._inboxes.keys())
