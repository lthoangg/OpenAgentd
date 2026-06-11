"""ContinuationHook — drives the ``/continue`` agent run.

When a user invokes the ``/continue`` command, the agent loop runs against
the existing DB history plus a persisted, hidden user directive.  This hook
has one job in that run:

1. **Stamp the first assistant response** with
   ``extra["is_continuation"] = True`` so the frontend can render it tight
   against the prior assistant bubble.  The API response layer uses this same
   flag to omit reasoning content from client-facing history while keeping the
   provider request shape unchanged for prompt-cache compatibility.

Within a single ``/continue`` turn the model may emit several assistant
messages (content → tool call → reaction); only the first one is a
continuation of the prior turn.  ``_stamp_fired`` ensures that happens once.

The ``is_continuation`` flag rides on ``AssistantMessage.extra`` and is
persisted verbatim by :class:`SQLiteCheckpointer.sync` via the existing
``extra=msg.extra`` pass-through — no changes to the persistence layer.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.agent.hooks.base import BaseAgentHook
from app.agent.schemas.chat import AssistantMessage

if TYPE_CHECKING:
    from app.agent.state import AgentState, RunContext


# Phrasing notes:
# * "your previous response" anchors the model to the trailing assistant turn.
# * "Continue exactly where" anchors the model to continuation, not restart.
# * "Do not restart, apologise, add a preamble, or summarise" pre-empts the
#   common failure modes observed in the empirical probe.
CONTINUATION_DIRECTIVE = (
    "Continue exactly where your previous response stopped. "
    "Do not restart, apologise, add a preamble, or summarise."
)


class ContinuationHook(BaseAgentHook):
    """Stamp the first assistant message produced by a ``/continue`` run.

    Attached to a single ``/continue``-triggered agent run.
    """

    def __init__(self) -> None:
        self._stamp_fired: bool = False

    async def after_model(
        self,
        ctx: "RunContext",
        state: "AgentState",
        response: AssistantMessage,
    ) -> None:
        if self._stamp_fired:
            return
        # Merge into existing extra (the agent loop sets extra["usage"]
        # before this hook runs — preserve it).
        #
        # TODO(frontend): the flag is currently set but no UI keys off it.
        # Per the design discussion (Option 3 — tight stack), the message
        # renderer should suppress the avatar/header and tighten the top
        # margin when the previous block is from the same assistant.
        if response.extra is None:
            response.extra = {"is_continuation": True}
        else:
            response.extra["is_continuation"] = True
        self._stamp_fired = True
