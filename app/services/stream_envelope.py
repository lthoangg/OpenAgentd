"""SSE stream envelope — typed wrapper for events flowing through ``stream_store``.

The envelope carries a parsed ``data`` dict rather than a JSON string so the
stream-store backends can read fields directly (``env.data["text"]``) without a
``json.loads`` dance on every ``push_event``.  Serialisation happens once at
the SSE boundary (``to_wire``).

Producers construct an envelope from a typed ``*Event`` Pydantic model via
:meth:`StreamEnvelope.from_event`; the classmethod pulls the discriminator
(``evt.type``) into ``event`` so the SSE ``event:`` line always matches the
payload's ``type`` field.  Transport (the SSE route) calls :meth:`to_wire`
to cross the string-serialised boundary — there is no reverse ``from_wire``
because raw ``{"event","data"}`` dicts are never fed back into
:func:`stream_store.push_event`.
"""

from __future__ import annotations

import json
from typing import Any, Union

from pydantic import BaseModel, ConfigDict, Field

from app.agent.schemas.events import (
    AgentNotConfiguredEvent,
    AgentStatusEvent,
    DoneEvent,
    ErrorEvent,
    MessageEvent,
    PermissionAskedEvent,
    PermissionRepliedEvent,
    ProviderStatusEvent,
    QuestionAnsweredEvent,
    QuestionAskedEvent,
    QuestionDismissedEvent,
    RateLimitEvent,
    SessionEvent,
    SummarizationContentEvent,
    SummarizationEndEvent,
    SummarizationStartEvent,
    ThinkingEvent,
    ToolCallEvent,
    ToolEndEvent,
    ToolOutputDeltaEvent,
    ToolStartEvent,
    UsageEvent,
)

# Me union of every event that can flow through the stream. ``from_event``
# accepts any of these; we do not constrain at runtime because there is one
# legacy producer (team.py generic lifecycle branch) that emits an ad-hoc
# dict rather than a typed model — that path uses ``from_parts`` instead.
AnyStreamEvent = Union[
    SessionEvent,
    ThinkingEvent,
    MessageEvent,
    ToolCallEvent,
    ToolStartEvent,
    ToolOutputDeltaEvent,
    ToolEndEvent,
    UsageEvent,
    DoneEvent,
    RateLimitEvent,
    ProviderStatusEvent,
    ErrorEvent,
    AgentNotConfiguredEvent,
    AgentStatusEvent,
    PermissionAskedEvent,
    PermissionRepliedEvent,
    QuestionAskedEvent,
    QuestionAnsweredEvent,
    QuestionDismissedEvent,
    SummarizationStartEvent,
    SummarizationContentEvent,
    SummarizationEndEvent,
]


class StreamEnvelope(BaseModel):
    """Typed wrapper around one SSE event + its parsed payload.

    ``event`` mirrors the SSE ``event:`` line and the payload's ``type`` field.
    ``data`` is the payload as a ``dict`` — NOT a JSON string.  Serialise once
    at the transport boundary via :meth:`to_wire`.
    """

    model_config = ConfigDict(extra="ignore")

    event: str = Field(..., description="SSE event name; mirrors data['type']")
    data: dict[str, Any] = Field(default_factory=dict, description="Parsed payload")

    # ── Construction ──────────────────────────────────────────────────────
    @classmethod
    def from_event(cls, evt: AnyStreamEvent) -> StreamEnvelope:
        """Wrap a typed ``*Event`` model in an envelope.

        The ``event`` string is pulled from ``evt.type`` so the SSE line and
        the payload discriminator are guaranteed to agree.
        """
        return cls(event=evt.type, data=evt.model_dump(mode="json"))

    @classmethod
    def from_parts(cls, event: str, data: dict[str, Any]) -> StreamEnvelope:
        """Escape hatch for ad-hoc events that have no typed ``*Event`` model.

        Used by the team coordinator for generic lifecycle events and by
        reconnect replay for ``inbox`` (which carries team-specific fields
        not modelled in ``events.py``).  Prefer :meth:`from_event` for
        anything with a schema.
        """
        return cls(event=event, data=data)

    # ── Transport ─────────────────────────────────────────────────────────
    def to_wire(self) -> dict[str, str]:
        """Serialise to the SSE wire shape: ``{"event": str, "data": str}``.

        The ``data`` dict is JSON-encoded here; callers that forward the
        result to ``sse_starlette`` should use this method rather than
        dumping the model directly.
        """
        return {"event": self.event, "data": json.dumps(self.data)}

    # ── Field accessors (ergonomic shortcuts) ─────────────────────────────
    @property
    def agent(self) -> str:
        """Agent name from the payload, or empty string if absent."""
        agent = self.data.get("agent", "")
        return agent if isinstance(agent, str) else ""

    def field(self, name: str, default: Any = None) -> Any:
        """Shortcut for ``env.data.get(name, default)``."""
        return self.data.get(name, default)
