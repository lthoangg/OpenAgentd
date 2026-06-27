# OpenAgentd — Agent Instructions

The mobile-first cockpit for local AI agents — a Tauri 2 mobile + desktop shell wrapping a FastAPI backend + React web UI. Apache 2.0, ships as `openagentd` (CLI + sidecar) on every platform. Canonical feature catalogue: [`documents/docs/features.md`](documents/docs/features.md) — check there before claiming the product does (or doesn't) something.

## Tech stack

- **Backend:** Python `>=3.14`, FastAPI, SQLModel, Pydantic v2, SQLite (WAL), SSE, loguru.
- **Frontend:** React 19, TypeScript 5.9, Vite 7, Bun, Tailwind v4, Zustand + Immer, TanStack Query.
- **Mobile/Desktop:** Tauri v2 shell with a Python sidecar; Rust 2021 / minimum Rust 1.77.
- **Agent config:** `.md` files with YAML frontmatter in `{OPENAGENTD_CONFIG_DIR}/agents/`.

## Layout

```
app/         FastAPI backend (agent/, api/, core/, models/, services/, cli/)
web/         React frontend
desktop/     Tauri v2 shell
seed/        Default agents and empty mcp.json (installed by `openagentd init`)
tests/       pytest suite (mirrors app/)
documents/   Developer docs (see documents/docs/index.md)
```

## Essential commands

```bash
# Backend
uv sync                           # install
make dev                          # backend (:8000 reload) + Vite (:5173)
uv run ruff check app/ tests/             # lint
uv run ruff format --check app/ tests/    # format check
uv run ty check app/                      # type check
uv run pytest --no-cov -q                 # fast tests

# Frontend
cd web && bun dev                         # :5173, proxies /api → :8000
cd web && bun run lint
cd web && bun run typecheck
cd web && bunx tsc -p tsconfig.test.json --noEmit
cd web && bun run test
```

Full command + style reference: [`documents/docs/guidelines.md`](documents/docs/guidelines.md).

## Manual smoke/debug helpers

`manual/` contains API-driven smoke scripts for live-server debugging (`make run` or `make dev`, default `http://localhost:8000/api`). Prefer these before ad-hoc DB/API probing when investigating a user-reported session or symptom:

```bash
uv run python -m manual.health
uv run python -m manual.team_sessions --id <SESSION_ID>
uv run python -m manual.team_history <SESSION_ID>
uv run python -m manual.team_timeline <SESSION_ID> --full
uv run python -m manual.team_sse "message" --session <SESSION_ID>
uv run python -m manual.queued_injection
```

See [`manual/AGENTS.md`](manual/AGENTS.md) for the full script catalogue.

## Design principle: mobile-first, multi-platform

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

## Code style (summary)

- **Python 3.14+** — `|` unions, `from __future__ import annotations`, strict type hints, Pydantic v2, absolute imports from `app`, loguru `logger.info("event key={}", val)`.
- **TypeScript** — `strict: true`, functional components with explicit props, TanStack for server state, Zustand + Immer for client state, ESM only. Mobile-first design before desktop layouts; ensure the same component renders correctly across desktop/mobile and large/small screens; account for mobile safe areas/notches without wasting header space.
- **General** — thin routes, logic in services/hooks, no unnecessary abstractions, always invoke the `guidelines` skill.

## Post-implementation checklist

```bash
uv run ruff check app/ tests/ && uv run ruff format --check app/ tests/ && uv run ty check app/ && uv run pytest --no-cov -q
cd web && bun run lint && bun run typecheck && bunx tsc -p tsconfig.test.json --noEmit && bun run test  # if frontend changed
```

## Documentation

Start at [`documents/docs/index.md`](documents/docs/index.md) — it groups every doc by audience (getting-started / architecture / operations / frontend / contributing). Tracked tech debt: [`documents/techdebts/`](documents/techdebts/).

## When shipping a feature

Update in this order so docs stay coherent:

1. [`documents/docs/features.md`](documents/docs/features.md) — add a one-line entry under the right pillar with the `[vX.Y.Z]` tag. This is the canonical record.
2. [`README.md`](README.md) — refresh "What you get" / comparison table only if the change is user-visible and pitch-worthy.
3. [`documents/docs/comparison.md`](documents/docs/comparison.md) — add a row if it's a capability that differentiates against Claude Code / Codex CLI / Cursor / Aider / opencode.
4. Deeper doc under `documents/docs/` (e.g. `agent/teams.md`) — link it back from the `features.md` entry.

When removing a feature, mark it *(deprecated)* in `features.md` for at least one release before deleting.
