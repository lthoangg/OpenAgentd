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

## UI primitives (`components/ui/`)

All UI primitives are **zero external-dependency** implementations — no shadcn, no
`@base-ui/react`, no `class-variance-authority`, no `clsx`, no `tailwind-merge`.

| File | What it provides |
|---|---|
| `button.tsx` | Variants via plain record maps; `buttonVariants()` helper |
| `dialog.tsx` | React portal + backdrop; Escape/click-outside; focus trap; `animate-in`/`animate-out` |
| `sheet.tsx` | Same as dialog but slides in from an edge |
| `popover.tsx` | Portal-anchored via `getBoundingClientRect`; `--anchor-width` CSS var set |
| `dropdown.tsx` | Portal panel; select or action-menu mode; flip-up logic |
| `tooltip.tsx` | Absolute-positioned within `relative` wrapper; directional `slide-in-from-*` |
| `switch.tsx` | `<input type=checkbox role=switch>` in a styled label |
| `tabs.tsx` | Plain record maps for variant classes |
| `_use-deferred-unmount.ts` | `useDeferredUnmount(open, ms)` — plays exit animation before unmount |
| `lib/utils.ts` | `cn()` — 20-line inline class concatenator; no external deps |

**Animations** come from `tw-animate-css` (`animate-in`, `animate-out`, `fade-in-0`,
`zoom-in-95`, `slide-in-from-*`, `slide-out-to-*`). Do **not** remove it.

**Hook order rule:** `useDeferredUnmount` must always be called *before* any
conditional `return null` — place it at the top of the component, above all
`useEffect` calls, to avoid Rules-of-Hooks violations.

## Markdown rendering (`utils/markdown.tsx`)

`MarkdownBlock` renders GFM markdown via `react-markdown` + `remark-gfm`.
Custom component overrides live in the `components` map (memoised on `sessionId`):

| Override | Purpose |
|---|---|
| `pre` | Wraps code fences in the styled `CodeBlock` with copy button |
| `table` | Wraps `<table>` in a `<div class="oa-table-wrap">` for bidirectional scroll on mobile |
| `a` | Forces `target="_blank"` on all links |
| `img` | Routes through `MarkdownImage` for lightbox and workspace-file proxy |

**Table scroll pattern** — `.oa-table-wrap` (defined in `index.css`) sets
`overflow-x: auto` with `-webkit-overflow-scrolling: touch` on the wrapper div,
while the `<table>` itself uses `min-width: max-content` so columns never
compress. Do not add `display: block` or `overflow` directly to `table` —
browsers treat table layout specially and it breaks column alignment.

## Chat stream scroll / attach-to-stream

`AgentView` and `AgentPane` both implement an **attach-to-stream** pattern via
`attachedRef` (a `useRef<boolean>`). Rules:

| Event | Effect on `attachedRef` |
|---|---|
| User sends a message (new `user` block) | → `true` |
| Click chevron-down button | → `true`, instantly `scrollTop = scrollHeight` |
| Scroll event reaches `dist ≤ 40px` from bottom | → `true` |
| Scroll event with `dist > 40px` AND no `data-keyboard-open` | → `false`, show button |
| Virtual keyboard opens (`data-keyboard-open` on `<html>`) | scroll event ignored — viewport shrink is not user scroll |

When `attachedRef.current === true`, a **`ResizeObserver`** on the content
element runs `el.scrollTop = el.scrollHeight` on every layout change (streaming
text, markdown reflow, image load). This is the sole auto-follow mechanism.

**Do not use `scrollTo({ behavior: 'smooth' })` directly** — it is unreliable on iOS
WKWebView (may be instant or silently no-op), which leaves scroll events
mid-flight that falsely detach the view. Always use `el.scrollTop = el.scrollHeight` for auto-scroll. If smooth scrolling is required for user actions (e.g. clicking the scroll-to-bottom button), wrap it using a programmatic scroll ref to ignore intermediate scroll events.

The `data-keyboard-open` attribute is set/cleared by `useMobileViewportGuards`
(`hooks/use-mobile-viewport.ts`) in sync with `window.visualViewport` resize events.

## Gotchas

- Use static ESM imports and `@/` aliases.
- Tests rely on isolated module state; keep using the package test script.
- Store tests usually seed with `useStore.setState(...)` and assert via `useStore.getState()`.
- Preserve desktop token injection rules: only same-origin `/api` requests receive auth.
