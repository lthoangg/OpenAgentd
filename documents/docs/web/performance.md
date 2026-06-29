---
title: Frontend Performance
description: Render optimization patterns used across the web UI — memo, useMemo, useCallback.
status: stable
updated: 2026-06-20
---

# Frontend performance

Patterns applied across the component tree to prevent unnecessary re-renders,
especially during high-frequency SSE streaming.

---

## Patterns in use

### `memo` on list-item and block components

Components that appear in loops and receive stable props are wrapped with
`React.memo` so a parent re-render (e.g. a new streaming delta) doesn't
re-render every sibling:

| Component | Why |
|---|---|
| `BlockRenderer` (AgentView, AgentPane) | Re-renders only when its own block content changes, not on every SSE tick |
| `UserBubble` (AgentPane) | Stable between stream updates |
| `SessionRow` (Sidebar) | Stable when session list is unchanged |
| `FileRow` (WorkspaceFilesPanel) | Stable when file selection changes elsewhere |
| `HighlightedCode` (CodingFileViewerPanel) | Syntax highlighting only re-runs when the line string changes, not on selection state |

### `useMemo` on derived arrays

| Location | Value memoized |
|---|---|
| `Sidebar` | `normalSessions` (flatMap over pages), `dateGroups` (groupByDate result) |
| `TodosPopover` | `sortedTodos` ([...todos].sort) |
| `CodingFileViewerPanel / TextPreview` | `lines` (content.split('\n')) |

### `useCallback` on stable handlers

| Location | Handler |
|---|---|
| `AssistantTurnFooter` | `handleCopy` — deps: `[textContent]` |
| `AgentPane / UserBubble` | `handleCopy` — deps: `[content]` |
| `Sidebar` | `handleDelete`, `handleEdit` — deps: `[]` (only call setters) |

### Stable Zustand selectors

Inline selector lambdas `(s) => s.someFn` create a new function reference
every render, which can cause spurious re-subscriptions. For selectors that
return store *functions* (already stable), a module-level constant is used:

```ts
// ToastStack.tsx
const dismissSelector = (s: ReturnType<typeof useToastStore.getState>) => s.dismiss
```

---

## Rules of Hooks note

Hooks must not appear after early returns. In `TextPreview` the `useMemo`
for `lines` is declared **before** the `deleted` / `tooLarge` / `loading`
early returns — even though `content` may be `null` at that point — using a
`?? []` fallback to keep the call unconditional.

---

---

## AgentView scroll and pagination

`AgentView` manages two interrelated concerns in a single stable scroll
`useEffect` (dep array `[]`):

### Auto-stick (pinned mode)

`pinnedRef` tracks whether the viewport is glued to the bottom.
`ResizeObserver` on the content element re-sticks after every late layout
reflow (syntax highlighting, image load). Intentional user upward scroll
is detected via `onWheel` (desktop) and `onTouchMove` (mobile) — NOT from
the `scroll` event alone, which fires for programmatic scrolls too.

### Scroll-to-top pagination

When the user scrolls within `LOAD_OLDER_THRESHOLD` (300 px) of the top,
`onScroll` chooses one of two paths:

1. **Local hidden turns** (`hiddenTurnCount > 0`) — `showEarlierTurns()`
   expands the rendered window by `TURN_RENDER_STEP` (80) turns and
   restores the viewport position so the user stays at the same visual
   content. No network request.
2. **Server fetch** (`hiddenTurnCount === 0 && hasMore`) —
   `useTeamStore.getState().loadOlderMessages()` is called. On success,
   older blocks are prepended to the store and the viewport is restored to
   the same visual position.

**Ref pattern for live values** — `hiddenTurnCount` and `showEarlierTurns`
are written to `hiddenTurnCountRef` / `showEarlierTurnsRef` on every render
so `onScroll` always reads the current value without the effect needing to
re-register its listeners. Putting these values directly in the dep array
caused a stale-closure bug: after each `loadOlderMessages` call the effect
re-ran with `hiddenTurnCount > 0` (new pages pushed turn count above the
render window), trapping every subsequent scroll-to-top in the local-turns
branch and blocking further server fetches.

**Restore unpin** — the scroll-position restore effect sets
`pinnedRef.current = false` *before* writing `el.scrollTop`. This prevents
the `dimensionsChanged` guard inside `updatePinnedFromPosition` from
snapping the user back to the bottom when `scrollHeight` has grown.

### Tests

| File | Coverage |
|---|---|
| `AgentView.scroll.test.tsx` | Scroll-to-bottom button, pinning, touch/wheel detach |
| `AgentView.pagination.test.tsx` | Threshold boundary, local-vs-server priority, stale-closure regression, restore-unpin regression |

---

## Tests

`web/src/__tests__/components/performance.memo.test.tsx` — behavioral
coverage for the memoized sort order in `TodosPopover`, copy-button stability
in `AssistantTurnFooter`, and progress-bar accuracy.
