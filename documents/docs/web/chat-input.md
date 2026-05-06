---
title: Chat Input & Message Queue
description: How the frontend queues messages while the lead is working and drains them after each turn.
status: stable
updated: 2026-04-30
---

# Chat Input & Message Queue

**Sources:** `web/src/stores/useTeamStore/`, `web/src/components/FloatingInputBar.tsx`, `web/src/components/PendingMessageQueue.tsx`

---

## Consecutive message behaviour

The input bar (`FloatingInputBar` + `InputBar`) is never disabled. Submitting while the agent is busy does not block or discard the message — it enters a client-side queue.

**Guard condition** (`sendMessage` in `useTeamStore/index.ts`):

```
lead.status === "working"  →  enqueue
lead.status !== "working"  →  POST /api/team/chat immediately
```

Only the **lead's** status matters. Members running background sub-tasks do not block new input.

---

## Queue lifecycle

| Step | What happens |
|------|-------------|
| User submits while lead is busy | Message pushed to `_pendingMessages` (no API call, no optimistic block) |
| SSE `done` event fires | All pending messages combined into one turn (`\n\n` join), files merged, sent as a single `POST /api/team/chat` |
| User clicks × on a queued item | Removed from store; text restored to the input bar |
| `newSession()` called | Queue cleared |

The drain happens in `sse-reducer.ts` inside the `done` case — after flushing `currentBlocks`, the entire queue is consumed at once. This means two queued messages ("then say hi" + "also summarise") become one combined turn, not two sequential ones.

---

## `PendingMessage` shape

```ts
interface PendingMessage {
  id: string      // stable id (pm-<timestamp>), used as React key and for removal
  content: string
  files?: File[]
}
```

Stored in `useTeamStore._pendingMessages: PendingMessage[]`.

---

## UI

`PendingMessageQueue` renders above the input bar (both mobile and desktop). Each item shows a clock icon, truncated message preview, optional file count badge, and an × button. Clicking × calls `removePendingMessage(id)` and restores the text via `InputBarHandle.setValue()`.

The `InputBarHandle` ref exposes:
- `focus()` — focus the textarea
- `setValue(text)` — inject text and trigger height recalculation

---

## Voice transcript insertion

Voice input reuses the normal text input path. The mic button records browser
audio, sends it to `POST /api/speech/transcribe`, then appends the returned
transcript to the existing draft via the `onTranscript` callback (handled in
`InputBar`). It does **not** call `sendMessage` automatically.

If the input already contains text, the transcript is appended with a space
rather than replacing the draft. See [`voice-input.md`](./voice-input.md) for
the full state machine and backend contract.
