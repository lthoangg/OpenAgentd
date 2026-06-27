---
title: Todos Popover
description: Chat header popover showing the agent's current task list with live invalidation on tool_end.
status: stable
updated: 2026-05-22
---

# Todos popover

A popover card anchored to the **Todos** button in the team chat header. Shows
the agent's current task list as a flat scrollable checklist managed by
`todo_manage`, sorted by status and updated automatically after each
`todo_manage` call.

---

## Opening the popover

| Trigger | Notes |
|---------|-------|
| **"Todos" button** in the chat header | Between the view toggles and the **Files** button; disabled when no session is active. |
| **`Ctrl+T`** | Keyboard shortcut registered in `useKeyboardShortcuts`. Disabled when no session is active. |
| **Command Palette** (`Ctrl+P`) | "Task List" entry under the **View** group. |

The popover is controlled (`open` / `onOpenChange`) so the keyboard shortcut
can toggle it programmatically. It is rendered via the shared `Popover` /
`PopoverContent` / `PopoverTrigger` primitives (`@base-ui/react/popover`).

---

## Data flow

### Query

`useTodosQuery(sessionId)` — thin TanStack Query hook over `getTodos(sessionId)`
(`GET /api/team/sessions/{id}/todos`). Query key: `queryKeys.todos(sessionId)`.
Enabled only when `sessionId` is set. `staleTime: 5_000`.

### Live invalidation

`useTeamStore` suppresses `tool_call`, `tool_start`, `tool_output_delta`, and `tool_end` SSE events
for `todo_manage` — no tool block is rendered in the chat. `tool_end` still
triggers a cache invalidation:

```ts
const TODO_MUTATING_TOOLS = new Set(['todo_manage'])

// tool_call / tool_start: early break — no block created
// tool_end: block completion skipped, invalidation still fires
if (TODO_MUTATING_TOOLS.has(toolName)) {
  const sid = useTeamStore.getState().sessionId
  if (sid) queryClient.invalidateQueries({ queryKey: queryKeys.todos(sid) })
}
```

### History reload

`assistantBlocks` in `src/utils/messages.ts` filters out `todo_manage` from
`msg.tool_calls` before creating blocks, so `todo_manage` calls are invisible
on page refresh too — both `parseTeamBlocks` (team history) and
`parseApiMessages` (single-agent history) go through this function.

---

## Display

Items render as a flat checklist sorted `in_progress → pending → completed → cancelled`. Each row is a status-aware checkbox icon followed by the task content; the optional claimed/assigned agent is shown as a small mono-uppercase tag at the row end.

| Status | Icon | Style |
|--------|------|-------|
| `in_progress` | filled `CircleDot` with a soft `animate-ping` halo — `--color-info` | Bolded text, tinted row (`--color-info-subtle`) + left accent rail |
| `pending` | empty square — `--color-text-muted` | Normal text |
| `completed` | checked square — `--color-success` | Dimmed + strikethrough |
| `cancelled` | empty square — `--color-text-subtle` | Dimmed + strikethrough |

Note: `--color-accent` is **not** used for status hue — in the dark palette it resolves to the same value as `--color-text` and would lose contrast. The `in_progress` icon uses `--color-info` (which resolves to `--accent-blue`) so it stays distinct in both themes.

The popover header shows a title with a `ListTodo` glyph, a `{done}/{total}` counter (which turns green when everything is finished), and a slim animated progress bar (`role="progressbar"`) underneath. The bar is blue while work remains and green at 100%. A dot indicator on the button itself appears when any item has `status === 'in_progress'`. The assigned/claimed agent renders as a small pill chip at the row end. Empty state: a faded `ListTodo` glyph above a `No tasks yet` line.

Priority badges, task ids, and dependency lists from the underlying schema are intentionally not rendered — the popover is a quick-glance affordance, not a full task manager. Schema details are still available via `GET /api/team/sessions/{id}/todos`.

---

## Backend

`GET /api/team/sessions/{session_id}/todos` reads `{OPENAGENTD_DATA_DIR}/sessions/{session_id}/.todos.json`. Coding sessions do not store todo state in the project repo. Returns `{todos: []}` when the file does not exist.

See [API reference — todo list](../api/index.md#todo-list) for the full contract.

---

## Related

- [API reference — todo list](../api/index.md#todo-list)
- [Agent tools — todo list](../agent/tools.md)
- [Workspace Files panel](./workspace-files.md) — same header, similar invalidation pattern
