---
name: oad/testing
description: >
  OpenAgentd testing reference — environment setup, run commands, and fix
  patterns for backend (pytest) and frontend (Bun/RTL). Load this for
  running, fixing, or adding coverage to existing tests. For writing a
  failing test before new code, use oad/test-driven-development instead.
---

# When to load which skill

| Situation | Skill |
|---|---|
| Running or fixing existing tests | **this skill** |
| Adding coverage for already-written code | **this skill** |
| Writing a failing test *before* implementing new behavior | `oad/test-driven-development` (loads this automatically) |
| Reproducing a bug with a test before fixing | `oad/test-driven-development` (Prove-It pattern) |

---

# Backend (pytest / FastAPI)

## Run commands

```bash
uv run pytest -n 4 -q                             # full suite, fast and low CPU
uv run pytest tests/path/to/test_file.py -q       # single file
uv run pytest tests/path/to/test_file.py::test_x  # single test
```

## Environment rules

- `asyncio_mode = auto` — write `async def test_x(): ...` directly, never `@pytest.mark.asyncio`.
- Global autouse fixtures (`tests/conftest.py`) give you a file-backed test DB (`setup_db`), a clean slate per test (`clean_db`), and an `os.environ` snapshot/restore — don't re-declare them.
- Use `async_session_factory` from `app.core.db` for DB access in production code under test; it points at the test DB automatically. Never open a second `:memory:` engine alongside it — it sees an empty schema.
- Mock at the import site used by the code under test (`patch("app.services.lsp.manager.lsp_manager", ...)`), not the definition site.
- Tests run in random order and parallel workers — no shared mutable module-level state between tests.

## Placement

Mirror the source tree: `app/services/chat_service.py` → `tests/services/test_chat_service.py`

## Manual scenario scripts

Run these after fixing the listed subsystems — they exercise service-layer logic end-to-end against a real in-memory DB/filesystem and catch regressions unit tests miss:

```bash
uv run python tests/manual/mention_scenarios.py   # after _safe_join*, mention context changes
uv run python tests/manual/lsp_scenarios.py       # after LspHook / LspManager / LspClient changes
uv run python tests/manual/manual_scenarios.py    # after chat_service compaction/undo-redo changes
uv run python tests/manual/extended_scenarios.py  # after chat_service edge-case changes
```

---

# Frontend (Bun / React Testing Library)

## Run commands

```bash
cd web && bun test --parallel         # full suite
cd web && bun test src/__tests__/path/to/Foo.test.tsx  # single file
```

## Environment rules

- `afterEach(cleanup)` in every component test file.
- Mock `lucide-react` at the top of every component test file:
  `mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))`.
- `mock.module()` patches the global Bun module registry and is not undone by `mock.restore()` — always run with `--parallel` so files get their own worker. Place any `mock.module()` call **before** the import of the code that uses it.
- Store tests reset state in `beforeEach` (`useXStore.setState(INITIAL)`).
- Prefer firing real store actions/SSE handlers over asserting on mocked internals (e.g. `useAgentStore.getState()._handleSSEEvent(...)`, then read `getState()` back).

## Placement

`web/src/components/Foo.tsx` → `web/src/__tests__/components/Foo.test.tsx`

---

# Desktop (Rust / Tauri / cargo test)

Read the surface-specific reference for commands and gotchas:

```
read("<skill_dir>/reference/rust-tauri.md")
```

---

# Writing good tests (applies to all surfaces)

- **Assert on outcome, not internals.** Check returned/rendered state, not which method was called.
- **DAMP over DRY.** Each test reads standalone — some duplication across test bodies is fine.
- **Real implementation > fake > stub > mock.** Mock only at slow, non-deterministic, or external boundaries.
- **One behavior per test**, named as a spec: `sets completedAt when task is completed`, not `works`.
- **Never `await asyncio.sleep(n)`** for real delays — patch `asyncio.sleep` or drive an `asyncio.Event`.

# Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Testing implementation details (mock call assertions) | Assert on state/output |
| Flaky tests (order/timing-dependent) | Isolate state; patch delays, never sleep |
| Mocking everything | Prefer real fixtures; mock only slow/non-deterministic boundaries |
| Bug fix with no reproduction test | Use `oad/test-driven-development` Prove-It pattern |
| Skipping a failing test to get green | Fix it or track it explicitly, never silently skip |
| Second `:memory:` DB engine alongside the global test DB | Use `async_session_factory` |

# Test pyramid

```
     Manual scenario scripts (tests/manual/*.py) — few, high-value, real DB/FS
    Integration tests — API route + DB, component + store, mirrored path
   Unit tests — pure functions, isolated hooks/services — most of the suite
```

- Most new tests should be unit: no DB, no network, milliseconds each.
- Cross a boundary → integration test at the mirrored path, prefer real fixtures over mocks.
- Extend an existing manual scenario script rather than starting a parallel one.
