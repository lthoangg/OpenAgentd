---
title: Frontend Performance
description: Render optimization patterns used across the web UI — memo, useMemo, useCallback.
status: stable
updated: 2026-06-13
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

## Tests

`web/src/__tests__/components/performance.memo.test.tsx` — behavioral
coverage for the memoized sort order in `TodosPopover`, copy-button stability
in `AssistantTurnFooter`, and progress-bar accuracy.
