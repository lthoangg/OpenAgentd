---
title: Manual Team Testing Guide
description: Smoke-test recipes for the multi-agent team — delegation, interrupts, drift, recovery.
status: stable
updated: 2026-05-16
---

# Manual Team Testing Guide

**Sources:** `app/api/routes/team/chat.py`, `app/agent/mode/team/`, `manual/`

This guide walks through real, current API calls to exercise the multi-agent team flow end-to-end. For automated coverage see `tests/agent/mode/team/`.

---

## Prerequisites

- A team in `{OPENAGENTD_CONFIG_DIR}/agents/` (exactly one `role: lead`, at least one `role: member`). `openagentd init` seeds a default team.
- At least one provider API key set (or an active OAuth: `openagentd auth copilot|codex`).
- Backend running: `make dev` (port `:8000`, reload) or `openagentd` (port `:4082`, packaged).

This guide uses `http://localhost:8000` (the `make dev` default). For the packaged binary swap in `:4082`.

---

## Surface to know

All team endpoints are mounted under `/api/team` and use **multipart/form-data**, not JSON.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/team/chat` | Send / interrupt / send+interrupt. Form fields: `message`, `session_id?`, `interrupt?`, `mode?`, `workspace?`, `files[]?`. Returns 202 with `session_id`. |
| `GET /api/team/{session_id}/stream` | SSE stream for the turn. Replays buffered state on reconnect. |
| `GET /api/team/agents` | List of available agents (lead + members). |
| `GET /api/team/sessions` | Paginated session list (`limit`, `before`). |
| `GET /api/team/sessions/{id}` | One session with messages. |
| `DELETE /api/team/sessions/{id}` | Delete the session + its workspace. |
| `GET /api/team/{session_id}/history` | Full message history for a session (paginated). |

Active team tools (each has a `@tool` registration in code):

- `team_message` — peer-to-peer message between team agents. The only way members reach the lead and each other.
- `team_manage` — lead-only roster operations.
- `todo_manage` — task board, injected for lead and members.

> Older docs referenced `send_message`, `create_tasks`, `claim_task`, `broadcast`, `message_leader` — those tool names no longer exist. The current surface is `team_message` + `todo_manage`.

---

## Smoke scripts

```bash
uv run python -m manual.team_spawn --message "Spawn three executor agents and ask each to reply with its handle"
uv run python -m manual.team_timeline <SESSION_ID> --full
```

See `manual/AGENTS.md` for the full set.

---

## Recipe 1 — Basic delegation

**Terminal A — open the SSE stream first.** You'll need a `session_id` once the POST returns; this recipe creates a new session, so connect to the stream right after the POST.

**Terminal B — send a delegation prompt:**

```bash
curl -X POST http://localhost:8000/api/team/chat \
  -F 'message=Research the latest advances in quantum computing in 2025 and analyse the key trends.'
```

Response (202):

```json
{"status": "accepted", "session_id": "019d70…"}
```

**Open the SSE stream** in Terminal A:

```bash
curl -N "http://localhost:8000/api/team/{session_id}/stream"
```

**Expected event sequence (abridged):**

```
event: agent_status   data: {"agent": "<lead>", "status": "working"}
event: thinking       data: {"agent": "<lead>", "text": "..."}
event: tool_start     data: {"agent": "<lead>", "name": "todo_manage", ...}
event: tool_end       data: {"agent": "<lead>", "name": "todo_manage", ...}
event: tool_start     data: {"agent": "<lead>", "name": "team_message", ...}
event: tool_end       data: {"agent": "<lead>", "name": "team_message", ...}
event: agent_status   data: {"agent": "<lead>", "status": "idle"}

event: agent_status   data: {"agent": "<member>", "status": "working"}
event: inbox          data: {"agent": "<member>", "from_agent": "<lead>", "text": "..."}
event: tool_start     data: {"agent": "<member>", "name": "web_search", ...}
event: message        data: {"agent": "<member>", "text": "..."}
event: agent_status   data: {"agent": "<member>", "status": "idle"}

event: agent_status   data: {"agent": "<lead>", "status": "working"}
event: message        data: {"agent": "<lead>", "text": "Here is the synthesis..."}
event: agent_status   data: {"agent": "<lead>", "status": "idle"}
event: done           data: {}
```

**Pass:**
- 202 returned immediately (POST is non-blocking).
- Lead creates todos via `todo_manage` and delegates via `team_message`.
- Each member wakes, processes its inbox, and replies with `team_message`.
- If a member claims/owns a todo but stops without `<sleep>` or `team_message`,
  the runtime injects one hidden open-task reminder and reactivates that member.
- Lead synthesises member outputs into a final assistant message.
- `done` fires exactly once after every active agent becomes idle.

---

## Recipe 1a — Member open-task nudge

Use the deterministic no-server smoke when validating the safety net. It forces
a member to claim a todo, stop with plain text, then verifies the hidden nudge
reactivates it so it reports via `team_message`:

```bash
uv run python -m manual.team_open_task_nudge --direct
```

The live-server mode exists, but real models may correctly refuse to stop
incorrectly, so it is less deterministic:

```bash
uv run python -m manual.team_open_task_nudge
```

---

## Recipe 2 — Session continuity

Use the `session_id` from Recipe 1:

```bash
curl -X POST http://localhost:8000/api/team/chat \
  -F 'message=Can you go deeper on the second trend you mentioned?' \
  -F 'session_id=019d70…'
```

Lead should reference the prior conversation. Members retain their own per-session state for that turn.

---

## Recipe 3 — Interrupt

Start a long task, then interrupt while it streams.

```bash
# 1. Long task
curl -X POST http://localhost:8000/api/team/chat \
  -F 'message=Research everything about climate change impacts on agriculture across all continents.'

# 2. Wait 2-3 seconds, then interrupt-and-redirect (same session_id)
curl -X POST http://localhost:8000/api/team/chat \
  -F 'message=Stop. Focus only on Africa.' \
  -F 'session_id=019d70…' \
  -F 'interrupt=true'
```

**Interrupt-only** (no follow-up message): omit `message` and send `interrupt=true` alone.

**Pass:**
- Working agents stop mid-stream (`agent_streaming_interrupted` in the app log).
- Partial output is preserved via the most recent `checkpointer.sync()`.
- Lead activates with the new instruction in context.
- A fresh `done` event fires when the redirected work completes.

See [`agent/loop.md#interrupt`](../agent/loop.md#interrupt) for the loop-level mechanics and `app/services/chat_service.py:heal_orphaned_tool_calls` for the orphan-tool-call recovery path.

---

## Recipe 4 — File upload (multimodal)

```bash
curl -X POST http://localhost:8000/api/team/chat \
  -F 'message=Summarise the attached document' \
  -F 'files=@/path/to/file.pdf'
```

Uploads land at `{OPENAGENTD_WORKSPACE_DIR}/{lead_session_id}/uploads/<filename>` (sanitized original names, with ` (n)` suffixes when duplicates exist) and the agent's filesystem tools see them as `uploads/<filename>`. See [`configuration.md#sandbox`](../configuration.md#sandbox) for path semantics.

---

## Recipe 5 — Concurrent user messages

Send two messages without waiting for the first to complete:

```bash
curl -X POST http://localhost:8000/api/team/chat -F 'message=Research topic A' &
curl -X POST http://localhost:8000/api/team/chat -F 'message=Also research topic B'
```

If `session_id` is omitted, two independent sessions are created. To enqueue both onto the same session, pass the same `session_id` on the second call — the message lands in the lead's mailbox and `TeamInboxHook` drains it on the next loop iteration.

---

## Recipe 6 — Drift detection

Edit a member's `.md` file mid-session (e.g. `vim {OPENAGENTD_CONFIG_DIR}/agents/explorer.md` and change its `model:`). Send a follow-up message in the same session.

**Expected:** The member rebuilds itself from disk at the start of its next activation (`TeamMemberBase._refresh_agent_from_disk()`), continues the turn with the new model, and the change is visible in the next `usage` SSE event's `model:` field.

---

## Recipe 7 — Frontend regression: session switch while streaming

Manual check that the UI cleans up streaming indicators when switching sessions mid-stream.

1. Send a long-running prompt in session A so it streams for several seconds.
2. While streaming, click a previously completed session B in the sidebar.

**Expected:** Session B renders immediately with no "..." processing indicator. In DevTools:

```js
useTeamStore.getState().isTeamWorking                  // → false
useTeamStore.getState().agentStreams['lead'].status    // → "available"
```

Regression coverage: `web/src/__tests__/stores/useTeamStore.async.test.ts`.

---

## Common failure modes

| Symptom | Likely cause |
|---------|--------------|
| `done` never fires | A member stuck in `_run_activation`, or lead crashed without becoming idle |
| `done` fires before members finish | `_try_emit_done` guard misfired — check `agent_status` event ordering in the log |
| Lead never wakes | `session_id` not propagated, or `TeamInboxHook` failed to drain the mailbox |
| Member never wakes | `team_message` targeted the wrong name, or inbox not registered for that member |
| 4xx on `POST /api/team/chat` | Sending JSON instead of multipart/form-data, or omitting `message` without `interrupt=true` |
| 5xx with `No tool output found for function call` or OpenAI `tool_calls` pairing errors | A visible orphan tool call survived crash/compaction — `heal_orphaned_tool_calls` should patch this on the next turn |
