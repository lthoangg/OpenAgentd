"""Global FastAPI exception handlers for domain errors.

Maps the :class:`~app.core.errors.OpenAgentdError` hierarchy to HTTP status codes.
Pass :data:`EXCEPTION_HANDLERS` to ``FastAPI(exception_handlers=...)`` in the
application factory so every unhandled domain error gets a consistent JSON
response without per-route boilerplate.

Usage::

    from app.core.exception_handlers import EXCEPTION_HANDLERS

    app = FastAPI(exception_handlers=EXCEPTION_HANDLERS, ...)
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from loguru import logger

from app.agent.errors import (
    AgentConfigError,
    DeniedPathError,
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

# Match the type FastAPI's ``exception_handlers`` parameter expects.
_ExceptionHandler = Callable[[Request, Any], Coroutine[Any, Any, Response]]


async def _session_not_found(
    request: Request, exc: SessionNotFoundError
) -> JSONResponse:
    logger.info("session_not_found error={}", exc)
    return JSONResponse(
        status_code=404, content={"detail": str(exc) or "Session not found."}
    )


async def _provider_rate_limit(
    request: Request, exc: ProviderRateLimitError
) -> JSONResponse:
    logger.warning("provider_rate_limit error={}", exc)
    return JSONResponse(
        status_code=429, content={"detail": str(exc) or "Provider rate limit exceeded."}
    )


async def _provider_authentication(
    request: Request, exc: ProviderAuthenticationError
) -> JSONResponse:
    logger.warning("provider_authentication_error error={}", exc)
    return JSONResponse(
        status_code=401,
        content={"detail": str(exc) or "Provider authentication failed."},
    )


async def _provider_request(
    request: Request, exc: ProviderRequestError
) -> JSONResponse:
    logger.warning("provider_request_error error={}", exc)
    return JSONResponse(
        status_code=400,
        content={"detail": str(exc) or "Provider rejected the request."},
    )


async def _provider_connection(
    request: Request, exc: ProviderConnectionError
) -> JSONResponse:
    logger.error("provider_connection_error error={}", exc)
    return JSONResponse(
        status_code=502, content={"detail": "LLM provider unreachable."}
    )


async def _tool_argument(request: Request, exc: ToolArgumentError) -> JSONResponse:
    logger.warning("tool_argument_error error={}", exc)
    return JSONResponse(status_code=422, content={"detail": str(exc)})


async def _tool_execution(request: Request, exc: ToolExecutionError) -> JSONResponse:
    logger.error("tool_execution_error error={}", exc)
    return JSONResponse(status_code=500, content={"detail": "Tool execution failed."})


async def _denied_path(request: Request, exc: DeniedPathError) -> JSONResponse:
    logger.warning("denied_path_error error={}", exc)
    return JSONResponse(status_code=403, content={"detail": str(exc)})


_sandbox = _denied_path


async def _routing(request: Request, exc: RoutingError) -> JSONResponse:
    logger.warning("routing_error error={}", exc)
    return JSONResponse(
        status_code=404, content={"detail": str(exc) or "No agent found for request."}
    )


async def _agent_config(request: Request, exc: AgentConfigError) -> JSONResponse:
    logger.error("agent_config_error error={}", exc)
    return JSONResponse(status_code=500, content={"detail": "Agent misconfigured."})


async def _openagentd_fallback(request: Request, exc: OpenAgentdError) -> JSONResponse:
    """Catch-all for any OpenAgentdError subclass not handled by a more specific entry."""
    logger.error("unhandled_domain_error type={} error={}", type(exc).__name__, exc)
    return JSONResponse(status_code=500, content={"detail": "Internal server error."})


# Specific exception types must come before the base class so FastAPI resolves
# the most-specific handler first.  Order matters: subclasses before superclasses.
EXCEPTION_HANDLERS: dict[int | type[Exception], _ExceptionHandler] = {
    SessionNotFoundError: _session_not_found,
    ProviderRateLimitError: _provider_rate_limit,
    ProviderAuthenticationError: _provider_authentication,
    ProviderRequestError: _provider_request,
    ProviderConnectionError: _provider_connection,
    ToolArgumentError: _tool_argument,
    ToolExecutionError: _tool_execution,
    DeniedPathError: _denied_path,
    SandboxError: _denied_path,
    RoutingError: _routing,
    AgentConfigError: _agent_config,
    OpenAgentdError: _openagentd_fallback,
}
