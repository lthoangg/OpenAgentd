# ADR-0008: Use native Uvicorn performance backends

## Status
Accepted

## Date
2026-07-20

## Context
OpenAgentd serves HTTP, SSE, and WebSocket traffic through Uvicorn on CPython
3.14. The minimal Uvicorn installation uses the standard `asyncio` event loop
and the pure-Python `h11` HTTP parser. Native alternatives can reduce server
CPU time and improve throughput, especially with concurrent streams, but the
application must continue to run on Windows and remain explicit about the
dependencies included in its relocatable desktop sidecar.

The desktop `serve` entry point also creates its event loop before calling
`uvicorn.Server.serve()`. Installing `uvloop` alone would therefore optimize
the CLI-launched server but not the desktop sidecar unless that entry point
uses Uvicorn's selected loop factory.

## Decision
Install `httptools` on CPython and install `uvloop` on non-Windows CPython.
Keep Uvicorn's `http` and `loop` settings on `auto`, and make the desktop
entry point create its event loop with Uvicorn's loop factory. Windows and
unsupported Python implementations retain Uvicorn's standard fallbacks.

## Alternatives Considered

### Keep asyncio and h11 everywhere
- Pros: Pure-Python HTTP stack, smallest bundle, identical loop across platforms.
- Cons: Leaves supported native performance improvements unused.
- Rejected because: OpenAgentd already distributes platform-specific native
  dependencies, and both backends have CPython 3.14 wheels for release targets.

### Depend on `uvicorn[standard]`
- Pros: One dependency declaration enables all Uvicorn optional integrations.
- Cons: Also installs unrelated production dependencies such as `watchfiles`
  and `python-dotenv`, obscuring which runtime capabilities OpenAgentd needs.
- Rejected because: Explicit dependencies preserve the sidecar's intentional
  runtime surface and size.

### Require uvloop on every platform
- Pros: One event-loop implementation.
- Cons: uvloop does not support Windows.
- Rejected because: OpenAgentd supports Windows and must retain asyncio there.

## Consequences
- Uvicorn uses `httptools` automatically for HTTP/1.1 parsing on CPython.
- macOS and Linux use `uvloop`; Windows continues to use `asyncio`.
- The desktop sidecar and CLI-launched server select the same event-loop backend.
- Unix sidecars gain roughly 4.6 MB of installed native packages before bundle
  compression; Windows gains only `httptools`.
- Event-loop, subprocess, SSE, WebSocket, startup, and shutdown behavior must
  remain covered by cross-platform verification.
