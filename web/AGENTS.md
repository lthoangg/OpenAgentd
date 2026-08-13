# web/ — Agent Instructions

React/Vite frontend for OpenAgentd, embedded in the Tauri shell and served by the backend in packaged builds.

## Tech stack

- Bun, React 19, TypeScript 5.9, Vite 7, Tailwind v4 + `tw-animate-css`.
- TanStack Router/Query, Zustand + Immer, Tauri JS plugins.
- Bounded TanStack pilots: Table + Virtual power the telemetry trace list;
  Form owns the sidebar title and scheduler create/edit forms; Hotkeys owns
  fixed global commands and the workspace-panel close shortcut; Pacer debounces
  scheduler search. Unified Query/Router/Form/Hotkeys/Pacer devtools load in
  Vite development only. TanStack DB is not part of the current state model;
  Query remains server state and Zustand remains client/stream state.
- UI primitives are **zero-dependency** hand-rolled components in `src/components/ui/`
  (no shadcn, no Base UI, no CVA, no clsx/tailwind-merge — see `src/AGENTS.md`).
- Tests use Bun test with Happy DOM and Testing Library.

## Layout

```
src/           Application code, routes, components, stores, queries, tests
public/        Static assets
vite.config.ts Vite config and API/SSE dev proxy
eslint.config.js ESLint config
```

## Code style

- ESM only; no `require()`.
- Import app modules through `@/`.
- Prefer functional components with explicit props.
- Use TanStack Query for server state and Zustand stores for client state.
- Keep UI mobile-first and consistent with existing Tailwind v4 patterns.
- **Multi-platform / multi-screen:** the same components run on Tauri
  mobile (iOS/Android), Tauri desktop (macOS/Linux), and the browser.
  Author base styles for the smallest viewport, then enhance with
  `sm:`/`md:`/`lg:`. Desktop side-panels/splits must collapse to overlay
  drawers or a single column on mobile. Branch behaviour with
  `useIsMobile()` / `usePlatform()`, route touch gestures through
  `use-edge-swipe` (see *Mobile touch gestures* in `src/AGENTS.md`), and
  verify every change on both a narrow (≤768px) and a wide viewport.

## Running tests

Always run with `--parallel` — the suite is isolated per file and runs ~4× faster:

```bash
bun test --parallel
```

All other dev commands (`bun dev`, `bun run lint`, `bun run typecheck`, `bun run build`, …) are in the root `Makefile`. Run `make help` for a full list.
