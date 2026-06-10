---
title: Developer Guidelines
description: Dev commands, code style, testing patterns, GitHub conventions.
status: stable
updated: 2026-05-16
---

# openagentd — Developer Guidelines

openagentd is an on-machine AI assistant: FastAPI backend, React web UI, multi-agent teams, in-memory SSE streaming.

---

## Commands

### openagentd CLI

```bash
uv sync                              # install / sync dependencies

openagentd                               # start the API server in the background
openagentd start --lan --key             # expose server to mobile/LAN clients with access-key auth
openagentd stop                          # stop background processes
openagentd restart                       # restart the background server
openagentd status                        # check if running
openagentd address                       # show local and LAN server URLs
openagentd health                        # run server/mobile diagnostics
openagentd logs                          # tail the server log (alias: openagentd logs -n 100)
openagentd doctor                        # check system health
openagentd upgrade                       # stop, upgrade, and restart if running (desktop app: OpenAgentd → Check for Updates…)
openagentd --version                     # print version

openagentd auth copilot                  # GitHub Copilot OAuth (browser PKCE)
openagentd auth codex                    # OpenAI Codex OAuth (browser PKCE — recommended)
openagentd auth codex --device           # OpenAI Codex OAuth (headless device-code, SSH-friendly)
```

### Backend (Python / uv) — for development

```bash
# lint + format
uv run ruff check app/ tests/        # lint
uv run ruff check app/ tests/ --fix  # auto-fix
uv run ruff format app/ tests/

# type check
uv run ty check app/

# tests
uv run pytest --no-cov -q            # fast — skip coverage
uv run pytest                        # full — with coverage report (htmlcov/)
uv run pytest tests/path/to/test.py::TestClass::test_name  # single test
```

### Frontend (TypeScript / Bun)

```bash
cd web
bun run lint                         # eslint
bun run typecheck                    # tsc --noEmit
bun run test                         # unit tests (uses --isolate; required for clean module state)
bun run build                        # production build (dist/)
```

---

## Code style

### 1. General

- **Modern Python 3.14+** — use `|` for unions, `match` where appropriate, `from __future__ import annotations` in every file.
- **Minimalism** — no unnecessary abstractions. Thin routes, logic in services/hooks.
- **Active development** — no backward compatibility constraints. Breaking changes are fine.

### 2. Typing

- Strict type hints on all signatures.
- Pydantic v2 for all data models. `ConfigDict(extra="ignore")` for external responses.
- Discriminated unions: `Annotated[Union[...], Field(discriminator="role")]` (e.g. `ChatMessage`).
- Type checker is [**ty**](https://github.com/astral-sh/ty) (Astral, Rust-based, currently 0.0.x beta). Config lives in `[tool.ty.src]` in `pyproject.toml`. ty is gradual-typing-friendly out of the box — no strict-mode rule overrides needed.

### 3. Naming

| Scope | Convention |
|-------|-----------|
| Modules/packages | `snake_case` |
| Classes | `PascalCase` |
| Functions/variables | `snake_case` |
| Constants | `UPPER_SNAKE_CASE` |

### 4. Error handling

- Define specific domain exception classes for known error states.
- `try...except` in streaming loops — never let a chunk crash the run.
- Catch `pydantic.ValidationError` when processing streaming chunks or tool args.
- All hook invocations are wrapped in `_safe_invoke_hooks()` — a buggy hook never crashes the agent.

### 5. Imports

- Absolute imports starting from `app` (e.g. `from app.agent.schemas.chat import ChatMessage`).
- Order: stdlib → third-party → local, separated by blank lines (ruff enforces this).
- Use `TYPE_CHECKING` guard for heavy/circular imports in hooks and tools.

### 6. Logging

Uses **loguru** (not structlog). See [`documents/architecture.md`](architecture.md#6-logging-architecture) for full details.

```python
logger.info("event_name key={} key2={}", val, val2)  # snake_case event names
```

- INFO: all agent lifecycle points with timing
- DEBUG: full tool args/results, provider details
- `LOG_LEVEL` env var controls console verbosity (default `INFO`)

---

## Testing

### Backend

Tests strictly mirror `app/` structure (with the redundant `app/` prefix dropped). Find tests for `app/<path>/<module>.py` at `tests/<path>/test_<module>.py`.

```
tests/
├── conftest.py                      # in-memory SQLite, redirects app.core.db
├── agent/                           # mirrors app/agent/
│   ├── agent_loop/                  # core loop, retry, streaming, tool_dispatch, tool_executor
│   ├── hooks/                       # per-hook tests
│   ├── mcp/                         # config, manager, tools, installer_script
│   ├── mode/team/                   # member, mailbox, team, manage, lazy spawn
│   ├── plugins/                     # plugin loader, role contextvar
│   ├── providers/                   # per-provider tests
│   ├── schemas/                     # chat / agent / events wire types
│   ├── tools/                       # shell, filesystem, web, registry, multimodalities/
│   └── test_*.py                    # loader, drift, sandbox, permission, multimodal
├── api/                             # mirrors app/api/
│   └── routes/                      # one test file per route module
├── cli/                             # mirrors app/cli/ (init, auth, doctor, upgrade …)
├── core/                            # config, db, paths, otel
├── desktop/                         # desktop_auth contract
├── models/                          # SQLModel schema tests
├── scheduler/                       # scheduled task runtime
├── services/                        # stream_store, chat_service, title_service, dream, wiki
└── test_server.py                   # FastAPI app factory
```

**Key patterns:**
- `conftest.py` redirects `app.core.db` to in-memory SQLite — no external DB needed
- `app.dependency_overrides[dep] = override` for FastAPI dependency injection
- `patch("app.services.stream_store._backend", ...)` for stream_store
- When testing functions with `DbFactory` parameter (`async_sessionmaker[AsyncSession]`), pass the actual `async_sessionmaker` from the `engine` fixture rather than creating mock context managers — type hints are strict (see `tests/services/test_title_service.py` for example)

**Performance patterns — keeping tests fast:**
- `asyncio.sleep` inside production code (e.g. shell warmup, title timeout) must be mocked or injected with `TimeoutError` directly — never wait out real timeouts
- Background shell tests use a `fast_bg` fixture that replaces the production warmup sleep with a short spin loop (20 × 10 ms) so subprocess output is buffered without the full 1–3 s wait
- `os.execvp` calls in CLI tests must raise `SystemExit(0)` in the fake to stop execution — the real call replaces the process
- `cmd_stop` timeout test: patch `time.monotonic` with an iterator `[0.0, 999.0]` so `999 > 0+5` triggers SIGKILL on the first loop tick; `inf > inf` is `False` and causes an infinite loop
- `asyncio.wait_for` patches must call `coro.close()` before raising to avoid `RuntimeWarning: coroutine never awaited`

**Profiling slow tests:**
```bash
uv run pytest --no-cov --durations=0 -q   # shows every test's time, slowest first
```

**Coverage:**
```bash
uv run pytest                        # generates htmlcov/
open htmlcov/index.html
```

Target: keep coverage above 80% for `app/agent/` and `app/api/`. The `app/agent/providers/openai/` sub-package has dedicated unit tests in `tests/agent/providers/openai/` (split per handler: routing, completions, responses, streaming, provider) and should be kept at full coverage.

### Frontend

Tests use **Bun test + Happy DOM** — no browser needed.

```
web/src/__tests__/
├── setup.ts                         # GlobalRegistrator.register() for Happy DOM
├── bun-test.d.ts                    # bun:test type declarations
├── api/                             # client, sse parser, auth
├── components/                      # one test file per non-trivial component
│   └── settings/                    # Settings page forms (Agent, McpServer, …)
├── hooks/                           # use-mobile, useProximity, useKeyboardShortcuts, …
├── lib/                             # framework-level helpers
├── queries/                         # TanStack Query hooks (scheduler, mcp, mutations)
├── routes/                          # route-level integration tests
├── stores/                          # Zustand stores (useTeamStore variants, useUIStore)
├── utils/                           # markdown, blocks, format, telemetry helpers
└── *.test.tsx                       # top-level tests (quote, sandbox)
```

**Key patterns:**
- Import from `@/` — tsconfig paths resolve to `src/`.
- `useStore.setState(partial)` to seed state; `useStore.getState().action()` to invoke.
- No `require()` — static ESM imports only.
- Component tests use `render` from `@testing-library/react` + `user-event`; pure utils and store logic are tested directly without React renders.

---

## Architecture

See [`documents/architecture.md`](architecture.md) for:
- C4 context, container, component diagrams
- In-memory SSE streaming protocol (state blob + asyncio queues)
- Tool event lifecycle (`tool_call` → `tool_start` → optional `tool_output_delta` → `tool_end`)
- Agent reasoning loop with hooks
- Logging architecture

---

## Performance

Backend performance work lives close to the code it affects. Highlights:

- **UUIDv7** on all PKs (time-ordered, B-tree-friendly — `app/models/`).
- **SQLite WAL** + `synchronous=NORMAL` for ~5–10× write throughput (`app/core/db.py`).
- **Composite indexes** on `session_messages` for sorted message queries and summary lookups.
- **Connection pool** sized `pool_size=20, max_overflow=10` to absorb concurrent SSE streams (`app/core/db.py`).
- **`exclude_none`** Pydantic serializer trims ~10–20 % off JSON payloads (`app/api/schemas.py`).
- **Pagination** on session detail (`limit`/`offset`) and **cursor pagination** on the session list (`?before=<ISO8601>`) — no `COUNT(*)` on the hot path.
- **`discover_skills()` `lru_cache`** avoids a subdirectory walk per `/api/team/agents` request.

For deeper context see [`architecture.md`](./architecture.md).

---

## Team protocol

Multi-agent behaviour is controlled by `AgentTeamProtocolHook`, the `team_message` / `team_manage` tool descriptions, and per-agent system prompts. The full design (member lifecycle, lead delegation rules, drift detection, lazy spawn) lives in [`agent/teams.md`](./agent/teams.md) and [`agent/team-lazy-spawn.md`](./agent/team-lazy-spawn.md). Manual smoke tests: [`testing/team.md`](./testing/team.md).

---

## Workflow

1. **Understand** — read the relevant docs and existing code patterns.
2. **Lint before committing** — `uv run ruff check app/ tests/` (backend), `bun run lint` (web).
3. **Tests must pass** — `uv run pytest --no-cov -q` + `cd web && bun run test`.
4. **Atomic commits** — one logical change per commit, conventional commit format.

---

## GitHub conventions

### Issues

Labels:
- `[bug]` — Something broken
- `[feature]` — New capability
- `[docs]` — Documentation updates
- `[devex]` — Developer experience improvements
- `[question]` — User questions (close after answering)

Issue description format:
```
## Problem
## Expected behavior
## Actual behavior
## Steps to reproduce
## Logs/screenshots
```

### Pull requests

Requirements: clear description, linked issue (`Fixes #123`), tests passing, no type errors, docs updated if needed.

```
## Changes
## Why
## Testing
Fixes #123
```

### Discussions

- **Ideas** — new features, architectural discussions
- **RFCs** — significant changes requiring community input
- **Show & Tell** — integrations, custom deployments
