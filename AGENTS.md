# OpenAgentd — Agent Instructions

The mobile-first cockpit for local AI agents — a Tauri 2 mobile + desktop shell wrapping a FastAPI backend + React web UI. Apache 2.0, ships as `openagentd` (CLI + sidecar) on every platform. Canonical feature catalogue: [`documents/docs/features.md`](documents/docs/features.md) — check there before claiming the product does (or doesn't) something.

## Tech stack

- **Backend:** Python `>=3.14`, FastAPI, SQLModel, Pydantic v2, SQLite (WAL), SSE, loguru.
- **Frontend:** React 19, TypeScript 5.9, Vite 7, Bun, Tailwind v4, Zustand + Immer, TanStack Query.
- **Mobile/Desktop:** Tauri v2 shell with a Python sidecar; Rust 2021 / minimum Rust 1.77.2.
- **Agent config:** `.md` files with YAML frontmatter in `{OPENAGENTD_CONFIG_DIR}/agents/`.

## Layout

```
app/         FastAPI backend (agent/, api/, core/, models/, services/, cli/)
web/         React frontend
desktop/     Tauri v2 shell
tests/       pytest suite (mirrors app/)
documents/   Developer docs (see documents/docs/index.md)
```

Several directories carry their own `AGENTS.md` with local conventions and
"where to look first" maps — consult the nearest one before editing:
`app/AGENTS.md`, `app/agent/AGENTS.md`, `app/api/AGENTS.md`,
`app/services/AGENTS.md`, `web/AGENTS.md`, `web/src/AGENTS.md`,
`desktop/AGENTS.md`, `desktop/src-tauri/AGENTS.md`, `manual/AGENTS.md`,
`tests/AGENTS.md`, `tests/manual/AGENTS.md`, `scripts/AGENTS.md`,
`documents/AGENTS.md`, and `documents/docs/AGENTS.md`.

## Validation

Choose checks appropriate to the files and risk involved. Use the Make targets as the command source of truth:

```bash
make verify          # portable backend + web + docs + version contract
make verify-backend  # Python lint, format, types, and tests
make verify-web      # frontend lint, types, and tests
make verify-docs     # links, frontmatter, and documented targets
make verify-native   # desktop + mobile Rust checks; native dependencies required
```

Run `make help` for focused scenario, health, prompt-budget, and build targets.

## Manual smoke/debug helpers

`manual/` contains API-driven smoke scripts for live-server debugging (`make run` or `make dev`, default `http://localhost:8000/api`). Prefer these before ad-hoc DB/API probing when investigating a user-reported session or symptom:

```bash
uv run python -m manual.health
uv run python -m manual.team_sessions --id <SESSION_ID>
uv run python -m manual.team_history <SESSION_ID>
uv run python -m manual.team_timeline <SESSION_ID> --full
uv run python -m manual.team_sse "message" --session <SESSION_ID>
uv run python -m manual.queued_injection
uv run python -m manual.lsp_smoketest          # LSP diagnostics injection in a live coding turn
```

See [`manual/AGENTS.md`](manual/AGENTS.md) for the full script catalogue.

## Manual scenario tests

`tests/manual/` contains standalone scenario scripts that exercise service-layer logic against an in-memory SQLite database or temporary filesystem — no running server needed. Run them directly to verify behaviour after changes to the covered subsystems:

```bash
make scenarios-chat      # chat_service compaction, undo/redo, queues, and edge cases
make scenarios-mentions  # workspace mentions, binary/image handling, and path traversal
make scenarios-lsp       # LSP client, manager, hook, formatting, and diagnostics
make scenarios           # all service-layer scenarios
```

Re-run `mention_scenarios.py` after any change to `build_mention_context_blocks`, `_read_mention_as_attachment`, or `_safe_join*` in `app/api/routes/team/_helpers.py`. Re-run `lsp_scenarios.py` after any change to `LspHook` (`app/agent/hooks/lsp.py`), `LspManager`/`check_lsp_diagnostics` (`app/services/lsp/manager.py`), or `LspClient` (`app/services/lsp/client.py`).

## Design principle: mobile-first, multi-platform

[`DESIGN.md`](DESIGN.md) is the canonical design system — colour tokens, type
scale, spacing, radii, elevation, motion, platform shell geometry, and the
do's/don'ts. Consult it before adding or restyling any UI, and keep new surfaces
inside its existing tokens instead of inventing values.

OpenAgentd is **one codebase that must feel native on every surface** —
touch phones (Tauri iOS/Android), desktop apps (Tauri macOS/Windows/Linux),
and the browser. Build mobile-first, then progressively enhance for larger
screens. Never ship a layout that only works on one form factor.

- **Mobile-first, then scale up.** Author the base/unprefixed styles for the
  smallest viewport; add `sm:`/`md:`/`lg:` overrides for wider screens. Use
  `useIsMobile()` (and `usePlatform()` for OS/Tauri checks) to branch
  behaviour, not just CSS.
- **Responsive multi-screen views.** Features that show side panels, splits,
  or multi-pane layouts on desktop must collapse to overlay drawers / single
  column / stacked views on mobile — and vice-versa. Test both. Reuse the
  shared drawer + gesture primitives (see `web/src/AGENTS.md` → *Mobile touch
  gestures*) rather than hand-rolling per-screen behaviour.
- **Touch + pointer parity.** Every action reachable by hover/right-click on
  desktop needs a touch equivalent (tap, long-press, edge-swipe). Keep
  desktop keyboard shortcuts working; don't make them mobile-only or
  mobile-broken.
- **Respect the platform chrome.** Account for mobile safe areas/notches and
  the macOS traffic-light overlay without wasting header space; use the
  existing `mobile-safe-*` utilities and `useTauriDrag`.
- **One feature, all surfaces.** When adding UI, verify it on a narrow
  (≤768px) and a wide viewport before calling it done.

## Security-sensitive changes

Touching auth/token checks (`app/core/desktop_auth.py`), builtin tools that execute shell commands or write files (`app/agent/tools/builtin/`), MCP server config (`app/agent/mcp/`), or any path built from user/model input — load the `security-review` skill first. Use the `oad/review` skill (five-axis review) before opening a PR.

Key security invariants to preserve:

- **`validate_workspace()`** (`app/services/team_manager.py`) — the single authority for workspace path validation. All endpoints that accept a `workspace` query param must route through it. Do not add a new `Path(workspace).resolve()` call in a route handler without going through this function.
- **`_safe_resolve()` / `_safe_join*()`** — use these for any per-file path within a workspace. Never build a path by concatenating user input directly.
- **`hmac.compare_digest`** — always use for token/secret comparison, never `==`.
- **Subprocess** — always use argument-list form; never `shell=True` with f-strings outside the sandboxed shell tool.
- **DuckDB / SQL** — always use `?` parameterised placeholders; validate string path params (e.g. `trace_id`) before querying.

## Delegating to spawned team members

When using team-spawning tools (e.g. `coder`, `explorer` blueprints) to parallelize work on this repo: the spawning agent is the orchestrator and stays that way. Spawned members report results back — they do not spawn further members themselves. Keep delegation depth at one level; if a sub-task looks like it needs its own delegation, do that from the orchestrator, not from inside a member.

## Documentation

Product documentation is intentionally small. [`documents/docs/features.md`](documents/docs/features.md) is the canonical catalogue of shipped user-visible capabilities; [`README.md`](README.md) is the user-facing product and installation entry point. Code, tests, CLI help, and the UI are authoritative for implementation and operation; git history preserves why those implementations changed.

## When shipping a feature

1. Add a concise, version-cited entry to [`documents/docs/features.md`](documents/docs/features.md).
2. Update [`README.md`](README.md) only when the feature changes the user-facing product story or setup.
3. Update the nearest `AGENTS.md` map when a subsystem's ownership or entry points change.

When removing a feature, mark it *(deprecated)* in `features.md` for at least one release before deleting.
