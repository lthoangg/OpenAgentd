---
name: oad/testing
description: OpenAgentd testing workflow — test-first (red/green/refactor, Prove-It for bugs), per-surface run commands, placement, and fix patterns for the Rust backend (appv3), the web UI (Bun + Testing Library), native shells, and scripts. Use when implementing or changing behavior, fixing a bug, or running and fixing tests.
---

Tests are the proof that a change works. Write them first for behavior; skip
them only for config, docs, or static content with no behavioral effect.

## 1. Test first

1. **Red** — write the test for the new behavior and run it. It must fail for
   the expected reason (not a typo, import error, or missing fixture).
2. **Green** — make the smallest change that passes it. No speculative branches or config.
3. **Refactor** — clean up with the test green, re-running after each step.

**Bug fixes (Prove-It):** reproduce the bug in a failing test before touching the
implementation, fix the root cause, then run the surface's full suite.

## 2. Run commands

| Surface | Focused | Full gate |
|---|---|---|
| Backend `appv3/` | `cargo test --manifest-path appv3/Cargo.toml -p <crate> [name_filter]` | `make verify-v3` (fmt check, clippy `-D warnings`, all tests) |
| Web `web/` | `cd web && bun test --parallel src/__tests__/<path>.test.tsx` | `make verify-web` (oxlint, `tsc -b` incl. tests, full suite) |
| Shared native crate | `cd native/shell-core && cargo test <filter>` | `make verify-shell-core` |
| Desktop shell | see `references/native.md` | `make verify-desktop` |
| Mobile shell | — | `make verify-mobile` (check only) |
| Scripts, installers, workflows | `.venv/bin/python -m pytest scripts/tests/<file> -q` | `make verify-scripts` |

Crates are named `appv3-<dir>` (`appv3-api`, `appv3-agent`, `appv3-tools`, …);
integration files run with `--test <file_stem>`. `make verify` runs the portable
set (v3, scripts, web, docs, version); `make verify-native` runs the three native targets.
API or SSE changes need both backend and web checks, and event types must match
`appv3/crates/agent/data/sse_events.json`.

## 3. Placement

- **Rust**: unit tests in `#[cfg(test)] mod tests` beside the code; behavior that
  crosses modules in `appv3/crates/<crate>/tests/<topic>.rs` (e.g. `api/tests/http_api.rs`).
- **Web**: mirror the source path under `web/src/__tests__/`
  (`src/components/Foo.tsx` → `src/__tests__/components/Foo.test.tsx`); split a
  large component by concern (`AgentView.scroll.test.tsx`).
- **Scripts**: `scripts/tests/test_<script>.py`.

## 4. Surface rules

**Backend**
- Tests that spawn `server serve` (`appv3/crates/cli/tests/`) use throw-away
  `HOME`/XDG roots; never point a test at real user data.
- Use `#[tokio::test(start_paused = true)]` for timing, not real sleeps.

**Web** — details and boilerplate in `references/frontend.md`.
- Always pass `--parallel`: `mock.module()` patches Bun's global module registry,
  `mock.restore()` does not undo it, and `--parallel` gives each file its own worker.
- Call `mock.module()` before importing the code that uses it; `afterEach(cleanup)` in component tests.
- Reset stores in `beforeEach`; drive real store actions and SSE handlers rather than
  asserting on mocked internals.

## 5. Good tests

- Assert on outcomes (state, rendered output, return values), not on which internals were called.
- One behavior per test, named as a spec: `keeps a moved tab where it is`, not `works`.
- Real implementation > fake > stub > mock; mock only slow, non-deterministic, or external boundaries.
- DAMP over DRY: each test reads on its own.
- Never sleep for timing; use paused time, fake timers, or drive the awaited event.
- Never skip or delete a failing test to get green; fix it or say why it is wrong.

## 6. Done when

- [ ] New behavior has a test in the right place; a bug fix has a test that failed first.
- [ ] The full gate for every touched surface passes.
- [ ] Ready to ship → load `oad/commit`.
