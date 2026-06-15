"""Domain exception hierarchy for OpenAgentd.

All openagentd-specific exceptions inherit from :class:`OpenAgentdError`.
Use these instead of bare ``ValueError`` / ``RuntimeError`` / ``PermissionError``
so callers can catch at the right granularity.

Hierarchy::

    OpenAgentdError
    ├── ProviderError
    │   ├── ProviderRateLimitError
    │   ├── ProviderConnectionError
    │   ├── ProviderAuthenticationError
    │   └── ProviderRequestError
    ├── ToolError
    │   ├── ToolNotFoundError
    │   ├── ToolArgumentError
    │   └── ToolExecutionError
    ├── SandboxError (also inherits PermissionError)
    │   ├── SandboxPathError
    │   └── SandboxCommandError
    ├── SessionError
    │   └── SessionNotFoundError
    ├── AgentConfigError
    └── RoutingError
"""

from __future__ import annotations


class OpenAgentdError(Exception):
    """Base exception for all OpenAgentd domain errors."""


# ── Provider errors ───────────────────────────────────────────────────────


class ProviderError(OpenAgentdError):
    """Base for LLM provider errors."""


class ProviderRateLimitError(ProviderError):
    """Provider returned 429 or equivalent rate-limit signal."""


class ProviderConnectionError(ProviderError):
    """Could not reach the provider (network / DNS / timeout).

    Carries the underlying transport error type (``error_type``) and the
    provider label so the UI can surface *why* the provider was
    unreachable instead of a bare connection failure.
    """

    def __init__(
        self,
        message: str,
        *,
        error_type: str | None = None,
        provider: str | None = None,
    ) -> None:
        self.error_type = error_type
        self.provider = provider
        super().__init__(message)


class ProviderAuthenticationError(ProviderError):
    """Provider credentials are missing, expired, or rejected (HTTP 401/403)."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        provider: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.provider = provider
        super().__init__(message)


class ProviderRequestError(ProviderError):
    """Provider rejected the request as invalid (HTTP 400/404/422).

    Carries the parsed, human-readable message from the provider's error
    body plus the originating status code so the UI can surface *why* the
    request failed (bad model name, unsupported parameter, context too
    long, …) instead of a bare ``400 Bad Request``.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        provider: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.provider = provider
        super().__init__(message)


# ── Tool errors ───────────────────────────────────────────────────────────


class ToolError(OpenAgentdError):
    """Base for tool-related errors."""


class ToolNotFoundError(ToolError):
    """Requested tool name does not exist in the registry."""


class ToolArgumentError(ToolError):
    """Tool arguments could not be parsed or validated."""


class ToolExecutionError(ToolError):
    """Tool execution failed at runtime."""


# ── Sandbox errors ────────────────────────────────────────────────────────


class SandboxError(OpenAgentdError, PermissionError):
    """Base for sandbox policy violations.

    Inherits from both ``OpenAgentdError`` (domain hierarchy) and
    ``PermissionError`` (backward compatibility with existing catches).
    """


class SandboxPathError(SandboxError):
    """Path escapes the workspace or is a symlink."""


class SandboxCommandError(SandboxError):
    """Command is blocked by the sandbox denylist."""


# ── Session errors ────────────────────────────────────────────────────────


class SessionError(OpenAgentdError):
    """Base for session-related errors."""


class SessionNotFoundError(SessionError):
    """Requested session does not exist in the database."""


# ── Config / routing ─────────────────────────────────────────────────────


class AgentConfigError(OpenAgentdError):
    """Agent YAML configuration is invalid or incomplete."""


class RoutingError(OpenAgentdError):
    """Could not resolve an agent for the incoming request."""
