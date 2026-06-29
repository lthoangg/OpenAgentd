---
title: Chat Input & Message Queue
description: How queued follow-up messages work while the team lead is streaming.
status: stable
updated: 2026-07-10
---

# Chat Input & Message Queue

**Sources:** `web/src/stores/useTeamStore/`, `web/src/components/TeamChatView/index.tsx`, `web/src/components/FloatingInputBar.tsx`, `web/src/components/InputBar.tsx`, `web/src/components/PendingMessageQueue.tsx`, `web/src/components/InputBar.mentions.ts`, `web/src/components/InputBar.overlay.tsx`, `web/src/components/AgentView.tsx` (`renderMentionSegments`), `app/api/routes/team/_helpers.py` (`collect_mention_attachments`)

---

## Consecutive message behaviour

The input bar (`FloatingInputBar` + `InputBar`) is never disabled. Submitting text while a lead turn is active persists the message to the backend queue; it is not kept only in browser memory.

**Guard condition:** the UI enqueues when the lead reports `working`; the backend also treats an already-active turn as busy, so rapid double-sends queue safely even before status updates reach the client.

Only the **lead turn** matters. Members running background sub-tasks do not block new input.

Explicit file attachments are supported on queued messages. The backend validates and persists uploaded files to disk at queue time, and the queued row carries `extra.attachments` just like a directly-dispatched message. If the queued message is cancelled, its persisted files are deleted. `@mention` context is queued too, but only as hidden inline context rows — not as uploads.

---

## Queue lifecycle

| Step | What happens |
|------|-------------|
| User submits text while a lead turn is active | `POST /api/team/chat` stores a hidden `SessionMessage` with `extra.queue_status="queued"` and returns its `message_id` |
| Lead reaches an iteration boundary while using an interruptible provider | Backend may pop queued rows and splice them into the running lead loop before the next LLM call. The same `queued_turn_start` event unblurs the queued bubbles. |
| Lead finishes its current activation | Backend emits `queued_turn_start`, pops queued rows in order, keeps the same SSE connection alive, and sends each queued message to the lead mailbox immediately. Team-level `done` still waits for all members to finish; the queue handoff does not wait for every member status to become `idle`. For providers with `support_interrupt = False`, this after-loop handoff is the only queued-message activation path; queued rows are not injected mid-loop. |
| User clicks `/stop` while messages are queued | Backend releases queued rows into normal visible history, removes their queued metadata, stops the stream, and does not activate those messages. Frontend reloads the session so the released messages can be edited with `/undo` or followed by a new message. |
| User reloads or switches sessions | Session history includes queued rows; the frontend rehydrates `_pendingMessages` for the active session |
| User clicks × on a queued item | Frontend removes it from `_pendingMessages` and calls `DELETE /api/team/sessions/{session_id}/queued-messages/{message_id}`; backend hard-deletes the row (no soft-cancel) |
| `newSession()` called | Queue cleared |

Queued messages are never concatenated. Multiple queued messages become separate user rows and separate lead activations unless the user clicks `/stop`, which pauses the queue by converting pending rows into normal history without running them. Queues are session-scoped, so switching from session A to session B does not display A's queued messages under B.

Unsent composer text is also session-scoped in the frontend: if you type a draft in session A, switch to session B, then return to session A, the original unsent text is restored for that session.

Session Settings may override the lead model and thinking level for the current chat. Sends include those settings, and queued rows keep the effective model metadata so history labels stay tied to the original turn.

---

## `PendingMessage` shape

```ts
interface PendingMessage {
  id: string      // backend message id, used for cancellation
  sessionId?: string | null
  content: string
}
```

Stored in `useTeamStore._pendingMessages: PendingMessage[]`.

---

## UI

`PendingMessageQueue` renders queued messages inside the conversation timeline below the streaming assistant response. Each queued item uses the normal right-aligned user bubble shape with a small × button (labelled "Edit queued message") and a `Queued` label. Clicking × dispatches a `queue:restore-draft` `CustomEvent`; `TeamChatView` listens for it and moves the queued text back into the composer (overwriting any current draft, matching `/undo` semantics) before removing the queued row — so the user can edit or resend instead of losing what they typed.

The desktop floating composer starts as a compact action strip and expands on explicit focus, `Ctrl+I`, attachment/content insertion, the Chat affordance, or type-to-focus: when no editable element is focused, pressing a printable key on the cockpit/coding chat surface focuses the composer and inserts that first character. Pressing `Escape` while focus is inside the expanded composer minimizes it back to the compact strip; sending a message also returns the composer to the compact strip. If the desktop composer is empty and focus moves outside it, it auto-minimizes back to the compact strip. While the lead is streaming, the composer may still minimize when empty and blurred; the compact strip remains recoverable with File, Voice, Chat/Expand, and Send/Stop controls. The streaming placeholder tells the user they can queue a follow-up, type `/stop`, or click stop.

Keyboard submit differs by viewport: desktop `Enter` submits and `Shift+Enter` inserts a newline; mobile `Enter` inserts a newline and the Send button submits.

### Shell mode

Typing `!` as the first character enters shell mode, matching opencode's shortcut.
The `!` is not inserted into the textarea; instead the placeholder changes to
`Enter shell command...`. This also works from the desktop compact strip's
type-to-focus path: pressing `!` expands the composer directly into shell mode.
Desktop and mobile shells also expose a terminal button in the expanded composer
for entering shell mode without typing `!`. In shell mode, attach/voice controls
collapse into the active Shell button. Backspace on an empty shell command, or
Escape, exits back to normal chat mode.

Submitting shell mode prefixes the visible history/API message with `!`, sets the
`shell=true` API flag, and marks the optimistic user block as `extra.kind =
"user_shell"` so it renders with shell styling immediately. Reloaded history uses
the same metadata persisted by the backend.

The `InputBarHandle` ref exposes:
- `focus()` — expand the floating composer when needed, then focus the textarea
- `setValue(text)` — expand the floating composer when needed, inject text, and trigger height recalculation
- `insertText(text)` — insert text at the current caret/selection, used by type-to-focus so the first keypress is not lost
- `setFiles(files)` — replace the current attachments with the provided files
- `addFiles(files)` — append the allowed files from the list to the current attachments and expand the composer if minimized

`newSession()` aborts any active team SSE stream and resets the live roster/scroll state without automatically focusing the empty composer, so stale tokens, scroll affordances, or unwanted keyboard capture from the previous session do not leak into the fresh chat.

### Drag-and-drop files

Dragging files anywhere over the chat area (in both cockpit and coding views) shows a clean, blurred, dashed-border drop overlay (`Drop files to attach`). Dropping the files immediately expands the composer (if minimized) and adds them as attachments. Standard file-type filtering is applied, allowing images, PDFs, text, audio, and video files. On desktop, native Tauri drag-and-drop is disabled to allow standard HTML5 drag-and-drop events to reach the webview.

### Composer history navigation

When the composer is empty, `ArrowUp` recalls prior user prompts and `ArrowDown` moves forward until the input is empty again. History combines local submissions with loaded user messages from the current lead chat, newest first, with blank and duplicate prompts skipped. Arrow navigation does not replace a typed draft and modified arrow keys keep their native behaviour.

---

## `@`-mention file/folder picker

Typing `@` (at start of input or after whitespace) opens a picker of workspace files and folders. Same UX as opencode / Cursor / Claude.

| Aspect | Detail |
|---|---|
| Trigger | `@` preceded by start-of-string or whitespace. Email-like `user@host` does **not** trigger. |
| Sources | Files come from `GET /api/team/{sid}/files` (normal mode) or `GET /api/team/workspace/files/list?workspace=…` (`/coding`). Folders are derived from path prefixes client-side. Cached 30s by TanStack Query. Dot-prefixed entries (`.openagentd/skills/…`, `.github/…`, `.env.example`) are tagable when not gitignored — only `.git/` and common generated dirs are hard-excluded; see [API — workspace file listing](../api/index.md#workspace-file-listing). |
| Ranking | Fuzzy subsequence via `fuzzysort` (so `dockcom` matches `docker-compose.yml`). Directories get a small bonus so `@src` surfaces the `src/` directory above its children. Empty query lists top-level folders alphabetically. |
| Inserted text | Plain `@path ` for files, `@dir/ ` for directories. The textarea stays plain-text — no structured chips inside the value. |
| Picker row | A lucide `Folder` or `File` icon, then the path with the parent directory dimmed and the basename in full text colour. Directories show a trailing `/`. |

### Syntax-highlight rendering

Committed mentions are coloured like editor tokens — no background tint:

| Kind | Colour token | Detection |
|---|---|---|
| File | `--accent-blue-text` | default (no trailing `/`) |
| Folder | `--accent-orange-text` | token ends in `/` |

The textarea is rendered with `color: transparent` + `caret-color: var(--color-text)`, and a mirror `<div>` (`InputBar.overlay.tsx`) paints all glyphs — non-mention text in `--color-text`, mention spans in the kind-specific colour. Standard syntax-highlighter pattern (CodeMirror / react-simple-code-editor). Selection is restored via the `selection:` Tailwind variant so highlighted text stays visible.

`--color-accent` is **not** used for mentions — in the dark palette it equals `--color-text` and would be invisible. The dedicated `--accent-blue-text` / `--accent-orange-text` tokens are theme-safe.

The same colours apply in rendered user message bubbles (`AgentView.tsx` → `renderMentionSegments`). Kind is inferred from the trailing slash (immutable per-message), not from a live `fileRefs` lookup — historical messages keep their colours even after the referenced path is renamed or removed. In coding sessions, clicked file mentions in sent user messages open the files tab and preview that workspace file; folder mentions stay visual-only.

Tokens chip **only** when they resolve to a known workspace ref — `@@`, `@nonexistent`, and `@foo@bar` produce no chip. Trailing sentence punctuation (`,` `.` `;` `:` `!` `?` `)`) is stripped before resolution. The actively-typed mention is excluded so the colour doesn't flash on every keystroke.

### Send-time mention context

When the message is dispatched (`POST /api/team/chat`), the backend resolves committed mentions against the session workspace and injects hidden context rows. This applies to both the immediate and queued paths.

| Mention | Send-time behaviour |
|---|---|
| Text file (`.md`, `.txt`, `.json`, …) | Inline the file body into hidden context using the same fenced format as file attachments, without creating an upload. |
| Document / image | Reference only — no inline mention context. |
| Folder | Inline a lightweight directory listing (`ls`-style), without creating an upload. |
| Unresolvable path | Silently skipped — also no chip. |

Helpers live in `InputBar.mentions.ts` (`findActiveMention`, `findCommittedMentions`, `rankFileRefs`). The overlay is `InputBar.overlay.tsx`. The query hook is `useFileRefsQuery.ts`. Backend resolution is `app/api/routes/team/_helpers.py::build_mention_context_blocks`.

---

## Voice transcript insertion

Voice input reuses the normal text input path. The mic button starts the
client-side speech recognizer and appends the final transcript to the existing
draft via the `onTranscript` callback (handled in `InputBar`). It does **not**
call `sendMessage` automatically.

If the input already contains text, the transcript is appended with a space
rather than replacing the draft. See [`voice-input.md`](./voice-input.md) for
the full state machine and runtime support contract.
