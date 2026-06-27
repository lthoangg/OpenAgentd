# web/src/ — Agent Instructions

Frontend application source: routes, API client, streaming stores, UI components, hooks, and tests.

## Where to look first

```
api/          Backend client, auth token injection, SSE parser
routes/       TanStack Router pages
components/   Reusable UI and feature components
stores/       Zustand stores for team/session/UI state
queries/      TanStack Query hooks and mutations
hooks/        Shared React hooks
utils/        Markdown, formatting, block/event helpers
__tests__/    Bun/Happy DOM tests mirroring app areas
router.ts     Route tree setup
index.css     Tailwind v4 theme/global styles
```

## Common feature checks

- Backend API shape changed: update `api/client.ts`, query hooks, stores, and tests.
- SSE event changed: update `api/sse*`, block helpers in `utils/blocks.ts`, and `stores/useTeamStore*`.
- New page/route: update TanStack route setup and add focused route/component tests.
- Settings form change: check zod/client validation and matching backend schema.
- Tool rendering change: inspect `components/ToolCall*` and copy/formatting tests.

## Commands

```bash
bun run lint
bun run typecheck
bunx tsc -p tsconfig.test.json --noEmit
bun run test
```

## Mobile touch gestures

Touch/swipe behaviour is centralised so drawers can never conflict:

- `hooks/use-edge-swipe.ts` — single controller for all mobile drawers
  (left = sidebar, right = chat-actions / coding-workspace panel).
  Guarantees **one drawer open at a time**, supports swipe-to-close,
  emits a live `drag` descriptor for finger-tracking, and commits on a
  fast fling (velocity) or fixed distance. Active only on Tauri
  iOS/Android shells.
- `hooks/use-history-swipe-navigation.ts` — desktop-Tauri back/forward
  edge swipes. Mutually exclusive with `use-edge-swipe` (gated by OS).
- Opt an element out of edge swipe with `data-swipe-ignore` (e.g.
  toasts, carousels) so its own drag wins.
- `lib/haptics.ts` — `softHapticFeedback` / `mediumHapticFeedback`, plus
  the semantic `haptic('tick'|'select'|'commit')` wrapper. No-ops off a
  touch shell; never make UX depend on haptics succeeding.
- Drag-follow drawers (`Sidebar`, `CodingSidebar`, `MobileChatActions`,
  `CodingWorkspacePanel`) accept a `mobileDragOffset`/`dragOffset` prop:
  apply it as the `x` transform with `transition: { duration: 0 }` while
  dragging, and fall back to the spring when it's `null`.
- `ImageLightbox` supports an optional `images[]` + `index` gallery with
  horizontal swipe, ←/→ keys, and chevrons; single-image callers are
  unaffected. Axis-lock keeps horizontal (navigate) and vertical
  (swipe-to-close) gestures from fighting.

When adding a new mobile panel, route it through `use-edge-swipe` rather
than hand-rolling `onTouch*` handlers.

## Gotchas

- Use static ESM imports and `@/` aliases.
- Tests rely on isolated module state; keep using the package test script.
- Store tests usually seed with `useStore.setState(...)` and assert via `useStore.getState()`.
- Preserve desktop token injection rules: only same-origin `/api` requests receive auth.
