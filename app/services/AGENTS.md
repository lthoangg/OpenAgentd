# app/services/ — Agent Instructions

Service-layer code shared by API routes, CLI commands, scheduler jobs, and the agent runtime.

## Where to look first

```
chat_service.py          Chat/session orchestration
team_manager.py          Team construction and session routing
stream_envelope.py       SSE envelope helpers
memory_stream_store.py   In-memory stream state
agent_fs.py              Agent/workspace filesystem helpers
snapshot_service.py      Workspace/session snapshot support
commands.py              Command handling helpers
title_service.py         Title generation
lsp/                     On-demand LSP servers + diagnostics injection (coding mode)
```

The LSP subsystem (`lsp/client.py`, `lsp/manager.py`) is driven by
`app/agent/hooks/lsp.py` and documented in
[`documents/docs/configuration/lsp.md`](../../documents/docs/configuration/lsp.md).

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
