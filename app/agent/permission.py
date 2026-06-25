"""Permission system — tool-call approval with wildcard rule matching.

Architecture mirrors opencode's ``permission/index.ts`` + ``evaluate.ts``:

Rule evaluation
---------------
A ``Rule`` maps ``(permission, pattern, action)`` where:

- ``permission``: glob that matches a tool name (e.g. ``"bash"``, ``"*"``)
- ``pattern``:    glob that matches a command/path string (e.g. ``"git *"``, ``"*"``)
- ``action``:     ``"allow"`` | ``"deny"`` | ``"ask"``

Rules are evaluated last-match-wins (``findLast`` semantics), so more specific
rules appended after broad defaults override them — the same behaviour as
opencode's ``evaluate.ts``.

Default when no rule matches: ``"ask"`` (prompt user).

Permission service
------------------
``PermissionService`` is a per-session service held in a ``contextvars.ContextVar``
so each agent call inherits the correct rule set without parameter threading.

Permission flow
---------------
1. Before executing a tool, call ``service.ask(tool_name, pattern)``.
2. If the resolved action is ``"allow"`` → proceed immediately.
3. If ``"deny"`` → raise ``PermissionDeniedError``.
4. If ``"ask"`` → for now, the default service auto-allows and emits an event
   (frontend can later hook into this to show a UI prompt).

This file ships a fully wired service that can be extended with a real
interactive approval UI without changing the calling code.
"""

from __future__ import annotations

import asyncio
import contextvars
import fnmatch
import uuid
from dataclasses import dataclass, field
from typing import Callable, Literal


# ── Types ─────────────────────────────────────────────────────────────────────

Action = Literal["allow", "deny", "ask"]
Reply = Literal["once", "always", "reject"]


@dataclass(frozen=True, slots=True)
class Rule:
    """A single permission rule."""

    permission: str  # glob matching tool name
    pattern: str  # glob matching command/path argument
    action: Action


Ruleset = list[Rule]


# ── Errors ───────────────────────────────────────────────────────────────────


class PermissionDeniedError(PermissionError):
    """Raised when a rule explicitly denies a tool call."""

    def __init__(self, tool: str, pattern: str, ruleset: Ruleset) -> None:
        self.tool = tool
        self.pattern = pattern
        self.ruleset = ruleset
        rules_str = "; ".join(
            f"{r.permission}/{r.pattern}={r.action}"
            for r in ruleset
            if fnmatch.fnmatch(tool, r.permission)
        )
        super().__init__(
            f"Permission denied for tool '{tool}' pattern '{pattern}'. "
            f"Matching rules: [{rules_str}]"
        )


class PermissionRejectedError(PermissionError):
    """Raised when the user explicitly rejects a permission request."""

    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        super().__init__(f"User rejected permission request {request_id}")


# ── Rule evaluation ───────────────────────────────────────────────────────────


def evaluate(tool: str, pattern: str, *rulesets: Ruleset) -> Rule:
    """Return the last matching rule across all rulesets.

    Implements ``findLast`` semantics: later rules (appended per-session)
    override earlier ones, so session-specific ``always-allow`` rules win
    over the default ``ask`` fallback.

    Falls back to ``Rule(tool, "*", "ask")`` when no rule matches.
    """
    all_rules = [r for rs in rulesets for r in rs]
    match: Rule | None = None
    for rule in all_rules:
        if fnmatch.fnmatch(tool, rule.permission) and fnmatch.fnmatch(
            pattern, rule.pattern
        ):
            match = rule
    return match or Rule(permission=tool, pattern="*", action="ask")


# ── Permission request ────────────────────────────────────────────────────────


@dataclass
class PermissionRequest:
    """A pending approval request, stored until the user replies."""

    id: str
    session_id: str
    tool: str  # tool name
    patterns: list[str]  # command fragments / path globs to approve
    always_patterns: list[str]  # patterns added to session ruleset on "always"
    metadata: dict = field(default_factory=dict)
    # Future is created lazily via create() — do NOT set a default_factory here
    # because asyncio.get_event_loop() cannot be called at module import time.
    _future: "asyncio.Future | None" = field(default=None, compare=False, repr=False)

    @classmethod
    def create(
        cls,
        session_id: str,
        tool: str,
        patterns: list[str],
        always_patterns: list[str],
        metadata: dict | None = None,
    ) -> "PermissionRequest":
        req = cls(
            id=str(uuid.uuid4()),
            session_id=session_id,
            tool=tool,
            patterns=patterns,
            always_patterns=always_patterns,
            metadata=metadata or {},
        )
        req._future = asyncio.get_event_loop().create_future()
        return req


# ── Permission service ────────────────────────────────────────────────────────


class PermissionService:
    """Per-session permission service.

    Holds:
    - ``base_ruleset``: global rules loaded from config (read-only reference)
    - ``session_ruleset``: per-session ``always-allow`` rules accumulated
      from user replies during this session
    - ``pending``: map of request_id → PermissionRequest awaiting reply

    The service is stored in a ``contextvars.ContextVar`` so agent tasks
    inherit the correct instance without explicit parameter threading.
    """

    def __init__(
        self,
        session_id: str,
        base_ruleset: Ruleset | None = None,
        *,
        on_ask: Callable[[PermissionRequest], None] | None = None,
    ) -> None:
        self.session_id = session_id
        self.base_ruleset: Ruleset = list(base_ruleset or [])
        self.session_ruleset: Ruleset = []
        self.pending: dict[str, PermissionRequest] = {}
        # Callback fired when a new permission request is created (for SSE)
        self._on_ask = on_ask

    # ── Core API ──────────────────────────────────────────────────────────

    async def ask(
        self,
        tool: str,
        patterns: list[str],
        always_patterns: list[str] | None = None,
        metadata: dict | None = None,
    ) -> None:
        """Check permission for *tool* against *patterns*.

        - ``"allow"`` → returns immediately.
        - ``"deny"``  → raises ``PermissionDeniedError``.
        - ``"ask"``   → emits a ``PermissionRequest`` and awaits the reply
          future.  In the default auto-allow mode the future is resolved
          immediately with ``"always"``.

        Raises:
            PermissionDeniedError: if any rule explicitly denies the call.
            PermissionRejectedError: if the user rejects the request.
        """
        needs_ask = False
        for pattern in patterns:
            rule = evaluate(tool, pattern, self.base_ruleset, self.session_ruleset)
            if rule.action == "deny":
                raise PermissionDeniedError(
                    tool, pattern, self.base_ruleset + self.session_ruleset
                )
            if rule.action == "ask":
                needs_ask = True

        if not needs_ask:
            return

        req = PermissionRequest.create(
            session_id=self.session_id,
            tool=tool,
            patterns=patterns,
            always_patterns=always_patterns or patterns,
            metadata=metadata or {},
        )
        self.pending[req.id] = req

        if self._on_ask is not None:
            self._on_ask(req)

        assert req._future is not None, "PermissionRequest must be created via create()"
        try:
            reply: Reply = await req._future
        finally:
            self.pending.pop(req.id, None)

        if reply == "reject":
            raise PermissionRejectedError(req.id)

        if reply == "always":
            for p in req.always_patterns:
                self.session_ruleset.append(
                    Rule(permission=tool, pattern=p, action="allow")
                )

    def reply(self, request_id: str, reply: Reply) -> bool:
        """Resolve a pending permission request with *reply*.

        Returns True if the request was found and resolved, False if unknown.
        """
        req = self.pending.get(request_id)
        if req is None:
            return False
        if req._future is not None and not req._future.done():
            req._future.set_result(reply)
        return True

    def auto_allow_pending(self, request_id: str) -> bool:
        """Auto-allow a specific pending request (used for now-defaulting)."""
        return self.reply(request_id, "always")

    def auto_allow_all_pending(self) -> int:
        """Auto-allow all pending requests. Returns number resolved."""
        count = 0
        for req_id in list(self.pending):
            if self.auto_allow_pending(req_id):
                count += 1
        return count

    def list_pending(self) -> list[PermissionRequest]:
        return list(self.pending.values())

    def add_rule(self, rule: Rule) -> None:
        """Append a rule to the session ruleset."""
        self.session_ruleset.append(rule)


# ── Default auto-allow service ────────────────────────────────────────────────


class AutoAllowPermissionService(PermissionService):
    """A ``PermissionService`` that immediately allows all ``ask`` requests.

    This is the default until the frontend ships a permission approval UI.
    It still emits SSE events (via ``on_ask``) so the UI can observe requests.
    """

    async def ask(
        self,
        tool: str,
        patterns: list[str],
        always_patterns: list[str] | None = None,
        metadata: dict | None = None,
    ) -> None:
        """Check rules; auto-approve ``ask`` actions rather than blocking."""
        for pattern in patterns:
            rule = evaluate(tool, pattern, self.base_ruleset, self.session_ruleset)
            if rule.action == "deny":
                raise PermissionDeniedError(
                    tool, pattern, self.base_ruleset + self.session_ruleset
                )

        # Fire on_ask callback for SSE visibility (non-blocking)
        if self._on_ask is not None:
            req = PermissionRequest.create(
                session_id=self.session_id,
                tool=tool,
                patterns=patterns,
                always_patterns=always_patterns or patterns,
                metadata=metadata or {},
            )
            self._on_ask(req)
            # Auto-allow — add to session ruleset
            for p in req.always_patterns:
                self.session_ruleset.append(
                    Rule(permission=tool, pattern=p, action="allow")
                )


# ── Context-var integration ───────────────────────────────────────────────────

_permission_ctx: contextvars.ContextVar[PermissionService] = contextvars.ContextVar(
    "permission_ctx"
)

_default_service: PermissionService | None = None


def get_permission_service() -> PermissionService:
    """Return the active ``PermissionService`` for the current context.

    Falls back to a module-level default ``AutoAllowPermissionService`` when
    no context is set (e.g. during tests or standalone tool invocations).
    """
    global _default_service
    try:
        return _permission_ctx.get()
    except LookupError:
        if _default_service is None:
            _default_service = AutoAllowPermissionService(session_id="default")
        return _default_service


def set_permission_service(service: PermissionService) -> contextvars.Token:
    """Set the active ``PermissionService`` for the current context."""
    return _permission_ctx.set(service)


# ── Config-based ruleset builder ──────────────────────────────────────────────


def ruleset_from_config(config: dict) -> Ruleset:
    """Build a Ruleset from a config dict.

    Config format (mirrors opencode's permission config)::

        {
            "bash": "allow",          # allow all bash calls
            "*": "ask",               # ask for everything else
            "bash": {                 # per-pattern rules
                "git *": "allow",
                "rm *": "ask",
            }
        }

    Wildcard tool names (``"*"``, ``"filesystem_*"``) are sorted before specific
    names so that specific tool rules override the broad default — same
    behaviour as opencode's ``fromConfig``.
    """
    entries = sorted(
        config.items(),
        key=lambda kv: ("*" not in kv[0], kv[0]),
    )
    rules: Ruleset = []
    for tool_glob, value in entries:
        if isinstance(value, str):
            rules.append(Rule(permission=tool_glob, pattern="*", action=value))  # type: ignore[arg-type]
        elif isinstance(value, dict):
            for pattern, action in value.items():
                rules.append(Rule(permission=tool_glob, pattern=pattern, action=action))  # type: ignore[arg-type]
    return rules
