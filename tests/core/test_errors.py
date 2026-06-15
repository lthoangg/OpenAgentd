"""Tests for app/core/errors.py — domain exception hierarchy."""

from __future__ import annotations

from app.agent.errors import (
    AgentConfigError,
    OpenAgentdError,
    ProviderAuthenticationError,
    ProviderConnectionError,
    ProviderError,
    ProviderRateLimitError,
    ProviderRequestError,
    RoutingError,
    SandboxCommandError,
    SandboxError,
    SandboxPathError,
    SessionError,
    SessionNotFoundError,
    ToolArgumentError,
    ToolError,
    ToolExecutionError,
    ToolNotFoundError,
)


class TestExceptionHierarchy:
    """Verify the inheritance tree is correct."""

    def test_all_inherit_from_openagentd_error(self):
        for exc_cls in (
            ProviderError,
            ProviderRateLimitError,
            ProviderConnectionError,
            ProviderAuthenticationError,
            ProviderRequestError,
            ToolError,
            ToolNotFoundError,
            ToolArgumentError,
            ToolExecutionError,
            SandboxError,
            SandboxPathError,
            SandboxCommandError,
            SessionError,
            SessionNotFoundError,
            AgentConfigError,
            RoutingError,
        ):
            assert issubclass(exc_cls, OpenAgentdError), f"{exc_cls.__name__}"

    def test_provider_subtypes(self):
        assert issubclass(ProviderRateLimitError, ProviderError)
        assert issubclass(ProviderConnectionError, ProviderError)
        assert issubclass(ProviderAuthenticationError, ProviderError)
        assert issubclass(ProviderRequestError, ProviderError)

    def test_provider_request_error_carries_metadata(self):
        exc = ProviderRequestError("bad model", status_code=400, provider="gpt-4o")
        assert str(exc) == "bad model"
        assert exc.status_code == 400
        assert exc.provider == "gpt-4o"

    def test_provider_authentication_error_carries_metadata(self):
        exc = ProviderAuthenticationError("no key", status_code=401, provider="claude")
        assert str(exc) == "no key"
        assert exc.status_code == 401
        assert exc.provider == "claude"

    def test_provider_connection_error_carries_metadata(self):
        exc = ProviderConnectionError(
            "unreachable", error_type="ReadTimeout", provider="gpt-4o"
        )
        assert str(exc) == "unreachable"
        assert exc.error_type == "ReadTimeout"
        assert exc.provider == "gpt-4o"

    def test_tool_subtypes(self):
        assert issubclass(ToolNotFoundError, ToolError)
        assert issubclass(ToolArgumentError, ToolError)
        assert issubclass(ToolExecutionError, ToolError)

    def test_sandbox_subtypes(self):
        assert issubclass(SandboxPathError, SandboxError)
        assert issubclass(SandboxCommandError, SandboxError)

    def test_sandbox_also_permission_error(self):
        """SandboxError inherits from both OpenAgentdError and PermissionError."""
        assert issubclass(SandboxError, PermissionError)
        assert issubclass(SandboxPathError, PermissionError)
        assert issubclass(SandboxCommandError, PermissionError)

    def test_session_subtypes(self):
        assert issubclass(SessionNotFoundError, SessionError)

    def test_can_raise_and_catch(self):
        with __import__("pytest").raises(OpenAgentdError):
            raise ToolNotFoundError("tool_xyz")

    def test_error_message_preserved(self):
        exc = ToolArgumentError("bad args for search")
        assert str(exc) == "bad args for search"
