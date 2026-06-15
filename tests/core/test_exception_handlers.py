"""Tests for app/core/exception_handlers.py — global FastAPI exception handlers."""

from __future__ import annotations

import pytest
from fastapi import Request

from app.agent.errors import (
    AgentConfigError,
    OpenAgentdError,
    ProviderAuthenticationError,
    ProviderConnectionError,
    ProviderRateLimitError,
    ProviderRequestError,
    RoutingError,
    SandboxError,
    SessionNotFoundError,
    ToolArgumentError,
    ToolExecutionError,
)
from app.core.exception_handlers import (
    EXCEPTION_HANDLERS,
    _agent_config,
    _openagentd_fallback,
    _provider_authentication,
    _provider_connection,
    _provider_rate_limit,
    _provider_request,
    _routing,
    _sandbox,
    _session_not_found,
    _tool_argument,
    _tool_execution,
)


def _make_request() -> Request:
    """Construct a minimal ASGI Request for handler calls."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": [],
    }
    return Request(scope)


class TestSessionNotFound:
    @pytest.mark.asyncio
    async def test_returns_404(self):
        req = _make_request()
        resp = await _session_not_found(req, SessionNotFoundError("s-123"))
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_body_contains_message(self):
        req = _make_request()
        resp = await _session_not_found(req, SessionNotFoundError("s-123"))
        body = resp.body
        assert b"s-123" in body

    @pytest.mark.asyncio
    async def test_empty_message_uses_default(self):
        req = _make_request()
        resp = await _session_not_found(req, SessionNotFoundError(""))
        body = resp.body
        assert b"Session not found" in body


class TestProviderRateLimit:
    @pytest.mark.asyncio
    async def test_returns_429(self):
        req = _make_request()
        resp = await _provider_rate_limit(req, ProviderRateLimitError("too fast"))
        assert resp.status_code == 429

    @pytest.mark.asyncio
    async def test_body_contains_message(self):
        req = _make_request()
        resp = await _provider_rate_limit(req, ProviderRateLimitError("too fast"))
        assert b"too fast" in resp.body

    @pytest.mark.asyncio
    async def test_empty_message_uses_default(self):
        req = _make_request()
        resp = await _provider_rate_limit(req, ProviderRateLimitError(""))
        assert b"rate limit exceeded" in bytes(resp.body)


class TestProviderConnection:
    @pytest.mark.asyncio
    async def test_returns_502(self):
        req = _make_request()
        resp = await _provider_connection(req, ProviderConnectionError("timeout"))
        assert resp.status_code == 502

    @pytest.mark.asyncio
    async def test_body_says_unreachable(self):
        req = _make_request()
        resp = await _provider_connection(req, ProviderConnectionError("timeout"))
        assert b"unreachable" in resp.body


class TestProviderAuthentication:
    @pytest.mark.asyncio
    async def test_returns_401(self):
        req = _make_request()
        resp = await _provider_authentication(
            req, ProviderAuthenticationError("bad key", status_code=401)
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_body_contains_message(self):
        req = _make_request()
        resp = await _provider_authentication(
            req, ProviderAuthenticationError("bad key")
        )
        assert b"bad key" in resp.body

    @pytest.mark.asyncio
    async def test_empty_message_uses_default(self):
        req = _make_request()
        resp = await _provider_authentication(req, ProviderAuthenticationError(""))
        assert b"authentication failed" in resp.body


class TestProviderRequest:
    @pytest.mark.asyncio
    async def test_returns_400(self):
        req = _make_request()
        resp = await _provider_request(
            req, ProviderRequestError("bad model", status_code=400)
        )
        assert resp.status_code == 400

    @pytest.mark.asyncio
    async def test_body_contains_message(self):
        req = _make_request()
        resp = await _provider_request(req, ProviderRequestError("bad model"))
        assert b"bad model" in resp.body

    @pytest.mark.asyncio
    async def test_empty_message_uses_default(self):
        req = _make_request()
        resp = await _provider_request(req, ProviderRequestError(""))
        assert b"rejected the request" in resp.body


class TestToolArgument:
    @pytest.mark.asyncio
    async def test_returns_422(self):
        req = _make_request()
        resp = await _tool_argument(req, ToolArgumentError("bad param"))
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_body_contains_message(self):
        req = _make_request()
        resp = await _tool_argument(req, ToolArgumentError("bad param"))
        assert b"bad param" in resp.body


class TestToolExecution:
    @pytest.mark.asyncio
    async def test_returns_500(self):
        req = _make_request()
        resp = await _tool_execution(req, ToolExecutionError("crashed"))
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_body_says_tool_failed(self):
        req = _make_request()
        resp = await _tool_execution(req, ToolExecutionError("crashed"))
        assert b"Tool execution failed" in resp.body


class TestSandbox:
    @pytest.mark.asyncio
    async def test_returns_403(self):
        req = _make_request()
        resp = await _sandbox(req, SandboxError("path escape"))
        assert resp.status_code == 403

    @pytest.mark.asyncio
    async def test_body_contains_message(self):
        req = _make_request()
        resp = await _sandbox(req, SandboxError("path escape"))
        assert b"path escape" in resp.body


class TestRouting:
    @pytest.mark.asyncio
    async def test_returns_404(self):
        req = _make_request()
        resp = await _routing(req, RoutingError("no agent"))
        assert resp.status_code == 404

    @pytest.mark.asyncio
    async def test_body_contains_message(self):
        req = _make_request()
        resp = await _routing(req, RoutingError("no agent"))
        assert b"no agent" in resp.body

    @pytest.mark.asyncio
    async def test_empty_message_uses_default(self):
        req = _make_request()
        resp = await _routing(req, RoutingError(""))
        assert b"No agent found" in resp.body


class TestAgentConfig:
    @pytest.mark.asyncio
    async def test_returns_500(self):
        req = _make_request()
        resp = await _agent_config(req, AgentConfigError("bad yaml"))
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_body_says_misconfigured(self):
        req = _make_request()
        resp = await _agent_config(req, AgentConfigError("bad yaml"))
        assert b"misconfigured" in resp.body


class TestOpenAgentdFallback:
    @pytest.mark.asyncio
    async def test_returns_500(self):
        req = _make_request()
        resp = await _openagentd_fallback(req, OpenAgentdError("unknown"))
        assert resp.status_code == 500

    @pytest.mark.asyncio
    async def test_body_says_internal_server_error(self):
        req = _make_request()
        resp = await _openagentd_fallback(req, OpenAgentdError("unknown"))
        assert b"Internal server error" in resp.body


class TestExceptionHandlersDict:
    def test_all_expected_types_registered(self):
        expected = {
            SessionNotFoundError,
            ProviderRateLimitError,
            ProviderAuthenticationError,
            ProviderRequestError,
            ProviderConnectionError,
            ToolArgumentError,
            ToolExecutionError,
            SandboxError,
            RoutingError,
            AgentConfigError,
            OpenAgentdError,
        }
        assert set(EXCEPTION_HANDLERS.keys()) == expected

    def test_correct_handlers_assigned(self):
        assert EXCEPTION_HANDLERS[SessionNotFoundError] is _session_not_found
        assert EXCEPTION_HANDLERS[ProviderRateLimitError] is _provider_rate_limit
        assert (
            EXCEPTION_HANDLERS[ProviderAuthenticationError] is _provider_authentication
        )
        assert EXCEPTION_HANDLERS[ProviderRequestError] is _provider_request
        assert EXCEPTION_HANDLERS[ProviderConnectionError] is _provider_connection
        assert EXCEPTION_HANDLERS[ToolArgumentError] is _tool_argument
        assert EXCEPTION_HANDLERS[ToolExecutionError] is _tool_execution
        assert EXCEPTION_HANDLERS[SandboxError] is _sandbox
        assert EXCEPTION_HANDLERS[RoutingError] is _routing
        assert EXCEPTION_HANDLERS[AgentConfigError] is _agent_config
        assert EXCEPTION_HANDLERS[OpenAgentdError] is _openagentd_fallback
