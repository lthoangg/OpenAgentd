"""Per-call agent role propagation for plugin filtering.

The role string ("lead", "member", or "agent" as a fallback) is read by
:func:`load_plugin_hooks` to evaluate each plugin's ``applies_to`` filter.
Callers that drive ``Agent.run()`` push their
role onto a :class:`contextvars.ContextVar` so the agent loop picks it up
without an extra parameter on every call site.

Mirrors the pattern used by :mod:`app.agent.denied_paths` and
:mod:`app.agent.permission`.
"""

from __future__ import annotations

import contextvars

#: Fallback role used when no caller has set a role.  Picked over "single"
#: because direct ``Agent.run()`` callers in this codebase are tests and
#: library consumers — there is no production "single mode" today.
DEFAULT_ROLE = "agent"

_role_ctx: contextvars.ContextVar[str] = contextvars.ContextVar(
    "agent_role_ctx",
    default=DEFAULT_ROLE,
)


def current_role() -> str:
    """Return the currently active agent role for the calling context."""
    return _role_ctx.get()


def set_role(role: str) -> contextvars.Token[str]:
    """Set the active role and return a reset token.

    Pair every call with ``_role_ctx.reset(token)`` (or a try/finally) so
    nested calls don't leak across awaits.
    """
    return _role_ctx.set(role)


def reset_role(token: contextvars.Token[str]) -> None:
    """Reset the role to its previous value using the token from :func:`set_role`."""
    _role_ctx.reset(token)
