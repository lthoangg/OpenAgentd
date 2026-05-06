---
title: Developer Guidelines
description: Dev commands, code style, testing patterns, performance optimizations, and team protocol conventions.
status: stable
updated: 2026-05-05
---

# openagentd — Developer Guidelines

openagentd is an on-machine AI assistant: FastAPI backend, React web UI, multi-agent teams, in-memory SSE streaming.

---

## Commands

### openagentd CLI

```bash
uv sync                              # install / sync dependencies

openagentd                               # start server + web UI in background (production)
openagentd --dev                         # start in foreground with hot-reload (development)
openagentd stop                          # stop background processes
openagentd status                        # check if running
openagentd logs                          # tail the server log (alias: openagentd logs -n 100)
openagentd doctor                        # check system health
openagentd update                        # update to the latest version (or Settings → Updates in installed app)
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
bun test src/__tests__               # unit tests
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
│   ├── agent_loop/                  # tool_executor (sanitize_error memory-path normalisation)
│   ├── hooks/                       # per-hook tests
│   ├── mcp/                         # config, manager, tools, installer_script
│   ├── mode/team/                   # member, mailbox, team tests
│   ├── providers/                   # per-provider tests + openai/{routing,
│   │                                #   completions_handler, responses_handler,
│   │                                #   responses_streaming, provider}.py
│   ├── schemas/
│   ├── tools/                       # shell, filesystem, web_tools, registry,
│   │   └── multimodalities/         # generate_image/video backend tests
│   └── test_*.py                    # loader, agent_loop, sandbox (denylist), permission
├── api/                             # mirrors app/api/
│   └── routes/                      # chat, team, mcp, speech route tests
├── cli/                             # mirrors app/cli/
├── core/                            # config, db, paths, otel
├── models/                          # SQLModel schema tests
└── services/                        # stream_store, chat_service, title_service
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
├── api/sse.test.ts                  # SSE parser
├── stores/useTeamStore.test.ts      # Zustand store state + event handlers
└── utils/blocks.test.ts             # ContentBlock helpers
```

**Key patterns:**
- Import from `@/` — tsconfig paths resolve to `src/`
- `useStore.setState(partial)` to seed state; `useStore.getState().action()` to invoke
- No `require()` — use static ESM imports only
- No React render in unit tests — test store logic and pure utils directly

---

## Architecture

See [`documents/architecture.md`](architecture.md) for:
- C4 context, container, component diagrams
- In-memory SSE streaming protocol (state blob + asyncio queues)
- 3-phase tool event lifecycle (`tool_call` → `tool_start` → `tool_end`)
- Agent reasoning loop with hooks
- Logging architecture

---

## Performance

Optimizations applied to the backend for low-effort, high-impact gains:

| Optimization | Where | Impact |
|-------------|-------|--------|
| **UUIDv7** | All PKs, session/run/message IDs | Time-ordered, B-tree-friendly. Sorting by ID = sorting by creation time. stdlib `uuid7()` (Python 3.14). |
| **SQLite WAL** | `app/core/db.py` connect listener | 5-10x write throughput. Concurrent reads during writes. `synchronous=NORMAL` for durability/speed balance. |
| **Composite indexes** | `session_messages` table | `(session_id, created_at)` covers sorted message queries. `(session_id, is_summary)` covers summary lookups. |
| **Pool sizing** | `app/core/db.py` engine config | `pool_size=20, max_overflow=10`. Prevents connection starvation under concurrent SSE streams. |
| **`discover_skills()` cache** | `app/agent/tools/builtin/skill.py` | `lru_cache` by directory path. Avoids subdirectory walk per `/api/team/agents` request. |
| **`exclude_none` responses** | `app/api/schemas.py` | Pydantic `model_serializer(mode='wrap')` strips nulls. ~10-20% smaller JSON. |
| **Message pagination** | All session detail endpoints | `offset` + `limit` params (default 200, max 1000). Prevents unbounded responses. |
| **Session list cursor pagination** | `GET /api/team/sessions` | `created_at`-keyed cursor (`?before=<ISO8601>`, default 20/page). No `COUNT(*)` — efficient on large tables; lazy-loads in sidebar via `IntersectionObserver`. |

---

## Team Protocol

Multi-agent team behavior is controlled by `AgentTeamProtocolHook` (in `app/agent/mode/team/hooks/team_prompt.py`), tool descriptions (`app/agent/mode/team/tools.py`), and per-agent system prompts (`.md` body in `OPENAGENTD_CONFIG_DIR/agents/`).

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| **`send_message` = work output only** | Free-tier LLMs will endlessly ping-pong pleasantries if allowed to "coordinate" via messages. Members may only send research findings, drafted text, or data. |
| **`message_leader(stop=true)` preferred** | Members should finish fast. Default `stop=false` caused members to linger and send "ready" spam. Protocol now says: prefer `stop=true`, only use `false` if you have concrete remaining work. |
| **No synthetic `[DONE]` message** | Team early-exit breaks the loop directly via `member._replied`. No `AssistantMessage(content="[DONE]")` appended — it polluted history and required provider-specific filters. |
| **Lead ignores status-only messages** | "OK", "ready", "waiting" messages from members carry no deliverable. Lead must not reply — it just creates noise loops. |
| **Members collaborate directly** | Members may message each other for help, to pass work output, or to request input — without routing through the lead. The lead sets initial direction; members self-coordinate from there. Social chatter and status pings are still banned — peer messages must carry substance. |

### Member lifecycle

```
1. get_tasks()
2. claim_task(task_id)
3. Do actual work (search, write, etc.)
4. update_task_status(task_id, "completed")
5. message_leader(content="<results>", stop=true)
```

If no tasks assigned: `message_leader(content="No tasks assigned", stop=true)` immediately.

---

## Workflow

1. **Understand** — read the relevant docs and existing code patterns.
2. **Lint before committing** — `uv run ruff check app/ tests/` (backend), `bun run lint` (web).
3. **Tests must pass** — `uv run pytest --no-cov -q` + `bun test src/__tests__`.
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
