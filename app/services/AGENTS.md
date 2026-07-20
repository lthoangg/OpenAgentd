# app/services/ — Agent Instructions

Service-layer code shared by API routes, CLI commands, scheduler jobs, and the agent runtime.

## Where to look first

```
chat_service.py          Chat/session orchestration
team_manager.py          Team construction and session routing
stream_envelope.py       SSE envelope helpers
memory_stream_store.py   In-memory stream state
event_broadcaster.py     Live-only global app event fan-out (scheduler/title/notifications)
agent_fs.py              Agent/workspace filesystem helpers
snapshot_service.py      Workspace/session snapshot support
commands.py              Command handling helpers
title_service.py         Title generation
lsp/                     On-demand LSP servers + diagnostics injection (coding mode)
provider_connection.py   Shared "is this provider connected?" check (Settings UI + tray usage)
provider_usage.py        Per-provider usage dispatch + connected-provider usage-summary aggregator (stale-while-revalidate cache, per-provider last-known-good fallback, user-disconnect exclusion, visible-model limit filtering)
```

The LSP subsystem (`lsp/client.py`, `lsp/manager.py`) is driven by
`app/agent/hooks/lsp.py`; managed language-server provisioning lives in
`lsp/managed.py`.

## Common feature checks

- Route behavior change: keep HTTP validation in `app/api/`, durable logic here, and add route/service tests.
- Session/history change: inspect `chat_service.py`, DB models, stream store, and web store assumptions.
- File/workspace change: check traversal protection, symlink behavior, media endpoints, and tests under `tests/api/routes/test_team_*`.

## Commands

```bash
uv run pytest --no-cov -q tests/services
uv run pytest --no-cov -q tests/api/routes
uv run ruff check app/services tests/services
uv run ty check app/
```

## Gotchas

- Keep services framework-light unless they are explicitly API-facing.
- Preserve async boundaries and pass real `async_sessionmaker[AsyncSession]` in tests.
- Avoid real sleeps/timeouts in tests; inject or patch timing behavior.
