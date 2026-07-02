---
name: oad/test-driven-development
description: >
  OpenAgentd TDD workflow — write a failing test before the code that makes
  it pass, reproduce a bug with a test before fixing it. Use when
  implementing any logic, fixing any bug, or changing any existing
  behavior in backend (pytest) or frontend (Bun/RTL) code.
---

Write the test first. It must fail for the right reason before you write the
code that makes it pass. Tests are proof — "seems right" is not done.

**When NOT to use:** pure config, docs, or static content changes with no
behavioral impact.

---

## 1. RED — write a failing test

Before touching implementation code, write the test and confirm it fails.

**Placement** mirrors the source tree:

- Backend: `app/services/chat_service.py` → `tests/services/test_chat_service.py`
- Frontend: `web/src/components/Foo.tsx` → `web/src/__tests__/components/Foo.test.tsx`

**Backend (pytest) essentials:**

- `asyncio_mode = auto` — write `async def test_x(): ...` directly, never
  `@pytest.mark.asyncio`.
- Global autouse fixtures (`tests/conftest.py`) already give you a
  file-backed test DB (`setup_db`), a clean slate per test (`clean_db`), and
  an `os.environ` snapshot/restore — don't re-declare them.
- Use `async_session_factory` from `app.core.db` for DB access in production
  code under test; it points at the test DB automatically. Never open a
  second `:memory:` engine alongside the global DB — it sees an empty
  schema.
- Mock at the import site used by the code under test
  (`patch("app.services.lsp.manager.lsp_manager", ...)`), not the
  definition site.
- Tests run in random order and in parallel workers — no shared mutable
  module-level state between tests.

**Frontend (Bun/RTL) essentials:**

- `afterEach(cleanup)` in every component test file.
- Mock `lucide-react` at the top of every component test file:
  `mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))`.
- `mock.module()` patches the global Bun module registry and is not undone
  by `mock.restore()` — always run with `--parallel` so files get their own
  worker, and place any `mock.module()` call for a dependency **before**
  the import of the code that uses it.
- Store tests reset state in `beforeEach` (`useXStore.setState(INITIAL)`).
- Prefer firing real store actions/SSE handlers over asserting on mocked
  internals (e.g. `useTeamStore.getState()._handleSSEEvent(...)`, then read
  `getState()` back).

Run the new test and confirm it fails for the expected reason, not a typo or
import error:

```bash
# backend, single test
uv run pytest --no-cov tests/services/test_chat_service.py::test_new_behavior -q

# frontend, single file
cd web && bun test src/__tests__/components/Foo.test.tsx
```

## 2. GREEN — minimal implementation

Write the smallest change that makes the test pass. Don't add branches,
config, or abstraction the test doesn't require yet.

## 3. REFACTOR — clean up

With the test green, improve naming/structure without changing behavior.
Re-run the touched test file (and the full suite if the change is
cross-cutting) after every refactor step.

```bash
uv run pytest -n auto --no-cov -q
cd web && bun test --parallel
```

---

## The Prove-It Pattern (bug fixes)

Do not start a bug fix by editing the implementation. Start by writing a
test that reproduces it:

```
Bug report → write a test demonstrating it → confirm it FAILS
  → implement the fix → confirm it PASSES → run the full suite (no regressions)
```

If the bug touches `_safe_join*`/mention context, `WorkspaceInstructionsHook`,
or `LspHook`, also re-run the matching standalone scenario script after the
fix — these exercise service-layer logic end-to-end against a real in-memory
DB/filesystem and catch regressions unit tests miss:

```bash
uv run python tests/manual/mention_scenarios.py   # after _safe_join*, mention context changes
uv run python tests/manual/lsp_scenarios.py       # after LspHook / LspManager / LspClient changes
uv run python tests/manual/manual_scenarios.py    # after chat_service compaction/undo-redo changes
uv run python tests/manual/extended_scenarios.py  # after chat_service edge-case changes
```

---

## Test pyramid for this repo

```
        Manual scenario scripts (tests/manual/*.py) — few, high-value, real DB/FS
       Integration tests — API route + DB, component + store, mirrored path
      Unit tests — pure functions, isolated hooks/services — most of the suite
```

- Most new tests should be small/unit: no DB, no network, milliseconds each.
- Cross a boundary (route → DB, component → store/SSE) → integration test,
  mirrored path, prefer real fixtures over mocks where one already exists
  (`async_session_factory` on backend, real Zustand store on frontend).
- Reach for a manual scenario script only for flows already covered by one
  (compaction, undo/redo, mention context, LSP diagnostics) — extend the
  existing script, don't start a parallel one.

## Writing good tests

- **Assert on outcome, not internals.** Check the returned/rendered state,
  not which method was called — interaction-based tests break on refactors
  that don't change behavior.
- **DAMP over DRY.** Each test should read standalone; don't chase shared
  setup helpers so hard that a reader has to trace three files to know what
  a test verifies. Some duplication across test bodies is fine.
- **Real implementation > fake > stub > mock**, in that order. Mock only at
  a boundary that's slow, non-deterministic, or external (LLM provider
  calls, network, filesystem watchers).
- **One behavior per test**, named as a spec: `sets completedAt when task is
  completed`, not `works` or `handles errors`.
- **Never `await asyncio.sleep(n)`** for real delays in a test — patch
  `asyncio.sleep` or drive an `asyncio.Event`/mocked `requestAnimationFrame`
  instead.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Testing implementation details (mock call assertions) | Assert on state/output |
| Flaky tests (order/timing-dependent) | Isolate state; never sleep for real delays — patch it |
| Mocking everything | Prefer real fixtures; mock only slow/non-deterministic boundaries |
| Bug fix with no reproduction test | Write the failing test first (Prove-It) |
| Skipping a failing test to get green | Fix it or track it explicitly, never silently skip |
| Second `:memory:` DB engine alongside the global test DB | Use `async_session_factory` / a file-backed `tmp_path` engine |

---

## Verification

- [ ] New behavior has a corresponding test at the mirrored path
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] `uv run pytest -n auto --no-cov -q` passes (backend changes)
- [ ] `cd web && bun test --parallel` passes (frontend changes)
- [ ] Relevant `tests/manual/*.py` scenario script re-run if the touched
      subsystem has one (mention context, LSP, chat_service compaction/undo)
- [ ] No tests skipped/disabled to make the suite pass
