---
title: API Reference
description: HTTP routes, SSE event protocol, file upload, workspace listing, media proxy, team chat, and planned speech endpoints.
status: stable
updated: 2026-06-28
---

# API Reference

FastAPI backend running on `:4082`. All routes are served under the `/api` prefix.

## Team endpoints

| Method | Path | Returns |
|--------|------|---------|
| `POST` | `/api/team/chat` | `{status, session_id}` 202 — multipart/form-data |
| `GET` | `/api/team/{session_id}/stream` | SSE stream (all agents) |
| `GET` | `/api/team/{session_id}/history` | `TeamHistoryResponse` (lead + members) |
| `GET` | `/api/team/{session_id}/uploads/{filename}` | File bytes — user-uploaded attachments |
| `GET` | `/api/team/{session_id}/media/{path}` | File bytes — agent workspace output (images, etc.) |
| `GET` | `/api/team/{session_id}/files` | `WorkspaceFilesResponse` — flat recursive listing of the agent workspace |
| `GET` | `/api/team/agents` | `{agents, blueprints, mode, workspace}`. Pass `?workspace=/path` for coding-mode agents. |
| `GET` | `/api/team/workspace/validate` | `{workspace}` — validates and resolves a coding workspace path |
| `GET` | `/api/team/workspace/browse` | `{path, parent, directories}` — browse server-local folders for coding mode |
| `GET` | `/api/team/workspace/files/list` | `{workspace, files, truncated}` for a selected coding workspace |
| `GET` | `/api/team/workspace/git-diff/view` | `{workspace, is_git_repo, diff, truncated}` for the selected coding workspace |
| `GET` | `/api/team/workspace/status` | `{workspace, name, is_git_repo, branch?, dirty?, head?}` — lightweight overview for the coding-mode empty state |
| `GET` | `/api/team/sessions` | `SessionPageResponse` — cursor-paginated, newest-first |
| `POST` | `/api/team/sessions/resolve` | `TeamSessionResolveResponse` — latest matching session or newly-created empty session |
| `GET` | `/api/team/sessions/{id}` | `SessionDetailResponse` — includes `mode`, `workspace`, and `running` for direct `/coding/{id}` loads |
| `DELETE` | `/api/team/sessions/{id}` | 204 — deletes the session row and uploads; coding workspace directories are kept |
| `GET` | `/api/team/sessions/{id}/todos` | `TodosResponse` — current agent todo list for the session |

### GET /api/team/sessions — cursor pagination

Sessions are returned newest-first, 20 per page by default. Filters are applied before cursor pagination.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `before` | ISO 8601 string | — | Cursor: return sessions with `created_at` **older than** this value. Omit for the first page. |
| `limit` | int | `20` | Page size (1–100). The `/coding` workspace sidebar requests 5 at a time. |
| `mode` | `normal` \| `coding` | — | Optional mode filter. Cockpit recent sessions use `mode=normal`; coding sidebars use `mode=coding`. |
| `workspace` | string | — | Optional resolved coding workspace filter. Use with `mode=coding` for per-workspace lists. |

`SessionResponse` includes `mode`, `workspace`, `model`, `thinking_level`, and `running`. `running` is derived from the in-memory stream store and is present in list/detail/history responses.

Pass `next_cursor` as `?before=…` to fetch the next page. `has_more: false` means you have reached the end. No `total` count — the cursor avoids a `COUNT(*)` on every page.

### POST /api/team/sessions/resolve

Resolves the active team session for normal or coding mode.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `mode` | `normal` \| `coding` | `normal` | Session mode. |
| `workspace` | string \| null | — | Required for coding mode; validated and stored as the resolved path. |
| `model` | string \| null | — | Stored only when a new session is created. |
| `thinking_level` | string \| null | — | Stored only when a new session is created. |
| `create` | bool | `false` | When true, bypass latest-session lookup and create a fresh empty session. |

Returns a `SessionResponse` plus `created`. The endpoint does not set `agent_name`; empty-session UIs must use their current lead fallback.

## Agent file management

Manages per-agent `.md` files under `AGENTS_DIR`, including nested coding-mode
agents such as `coding/openagentd`. Mutations write the
file and validate the new on-disk state; failures roll back the file so
disk state always matches a loadable team. The running team is **not**
rebuilt — drifted agents pick up the new config at the start of their
next turn (mtime-based drift check on the agent `.md`, `mcp.json`, and
referenced `SKILL.md` files). See [`configuration.md`](../configuration.md)
for the frontmatter schema and validation rules.

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/agents` | `{agents: AgentSummary[]}` — name, role, model, tools, skills, validity |
| `GET` | `/api/agents/registry` | `{tools, skills, providers, models}` — dropdown catalog for the settings UI; model entries come from cached provider model lists, not live provider discovery |
| `GET` | `/api/agents/{name}` | `AgentDetail` — raw `.md` content + parsed frontmatter + parse error (if any) |
| `POST` | `/api/agents` | `AgentDetail` 201 — create a new agent |
| `PUT` | `/api/agents/{name}` | `AgentDetail` — overwrite existing |
| `DELETE` | `/api/agents/{name}` | `{name}` — rejected if it would leave the team without a lead |

Request bodies for `POST` / `PUT`:

```json
{
  "name": "orchestrator",
  "content": "---\nname: orchestrator\nrole: lead\nmodel: openai:gpt-5.4\n---\n\nYou are …\n"
}
```

For coding agents, use the path-like API name (`coding/openagentd`) while the
frontmatter `name:` stays `openagentd`.

**Validation** (422 on failure, with rollback of the on-disk file):
- Each path segment in `name` must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`.
- Frontmatter must parse against `AgentConfig` (Pydantic v2).
- Team must have exactly one `role: lead`.
- Every `tools[]` entry must exist in the built-in registry.
- Every `skills[]` entry must resolve to a `{SKILLS_DIR}/{name}/SKILL.md` file.
- `model` must be `provider:model` with a known provider prefix.

**Rollback semantics** — if post-write validation fails, the server
restores the previous file content (PUT) or deletes the just-written
file (POST) before returning 422 so on-disk state always matches a
loadable team configuration.

**Shape changes are out of scope** — adding/removing agent files at
runtime is *not* picked up by drift detection.  A new `member.md`
appearing or the lead being deleted requires a server restart.

## Skill file management

Manages `{SKILLS_DIR}/{name}/SKILL.md` files. Skills are loaded lazily
at tool-call time (via `load_skill`), so writes just invalidate the
discovery cache. Agents whose `skills:` list references a changed file
pick it up on their next turn via drift detection — no team reload.

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/skills` | `{skills: SkillSummary[]}` — name, description, validity |
| `GET` | `/api/skills/{name}` | `SkillDetail` — raw `SKILL.md` content |
| `POST` | `/api/skills` | `SkillDetail` 201 — create |
| `PUT` | `/api/skills/{name}` | `SkillDetail` — overwrite |
| `DELETE` | `/api/skills/{name}` | `{name}` |

## MCP server management

Manages `{OPENAGENTD_CONFIG_DIR}/mcp.json` and the live MCP client runners.
Mutations rewrite the file and reconcile the affected runner; agents
that reference the server pick up the new tool list on their next turn
via drift detection on `mcp.json`. See
[`agent/tools.md`](../agent/tools.md#mcp-servers-appagentmcp) for the
config schema, transports, and lifecycle.

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/mcp/servers` | `ServerListResponse` — every configured server with live status |
| `GET` | `/api/mcp/servers/{name}` | `ServerStatusResponse` — single server (404 if unknown) |
| `POST` | `/api/mcp/servers` | `ServerStatusResponse` 201 — add a server |
| `PUT` | `/api/mcp/servers/{name}` | `ServerStatusResponse` — replace a server |
| `DELETE` | `/api/mcp/servers/{name}` | `{name}` |
| `POST` | `/api/mcp/servers/{name}/restart` | `ServerStatusResponse` — restart one runner |
| `POST` | `/api/mcp/servers/{name}/oauth/connect` | `ServerStatusResponse` — start OAuth for an HTTP MCP server |
| `POST` | `/api/mcp/apply` | `ServerListResponse` — re-read `mcp.json`, reconcile runners |

For HTTP OAuth servers, create/update accepts pasted `oauth.client_id` and
`oauth.client_secret` values. The API stores only `<SERVER>_MCP_CLIENT_ID` /
`<SERVER>_MCP_CLIENT_SECRET` in `{OPENAGENTD_CONFIG_DIR}/.env`, updates the
current process environment for those keys, and persists `${...}` references
in `mcp.json`. Existing unrelated `.env` entries are preserved.

`POST /apply` is the hook the `mcp-installer` skill calls after editing
`mcp.json` directly: it validates the file (422 on parse error before
any side effect), then reconciles runners. The running team and any
in-flight turn are not disrupted.

## Scheduler endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/scheduler/tasks` | `ScheduledTaskListResponse` — all tasks |
| `POST` | `/api/scheduler/tasks` | `ScheduledTaskResponse` 201 — create task |
| `GET` | `/api/scheduler/tasks/{slug}` | `ScheduledTaskResponse` |
| `PUT` | `/api/scheduler/tasks/{slug}` | `ScheduledTaskResponse` — full update |
| `DELETE` | `/api/scheduler/tasks/{slug}` | 204 |
| `POST` | `/api/scheduler/tasks/{slug}/pause` | `ScheduledTaskResponse` |
| `POST` | `/api/scheduler/tasks/{slug}/resume` | `ScheduledTaskResponse` |
| `POST` | `/api/scheduler/tasks/{slug}/trigger` | `ScheduledTaskResponse` — fire immediately |

Every task delivers to the **team lead** of the routing target — there
is no per-agent routing. The target is set by `mode`
(`"normal"` | `"coding"`) plus `workspace` (required when
`mode="coding"`). Workspace existence and `session_id` ↔ `(mode,
workspace)` compatibility are validated at create/update time and
return HTTP 422 on mismatch.

`PUT` accepts a partial body (`ScheduledTaskUpdate`) — all fields optional. On update the backend cancels the existing timer, recalculates `next_fire_at`, persists to DB, and restarts the timer if `enabled=true`. `max_runs` is an optional positive cap on successful firings; when reached, the task is disabled, marked `completed`, and no further fire time is scheduled. See [`agent/tools.md`](../agent/tools.md#scheduler-builtinschedulepy) for field semantics and schedule types.

`GET /api/scheduler/tasks` returns **all** tasks unfiltered. The web UI (`SchedulerPanel`, toggled with `Ctrl+S`) also shows all scheduled tasks and labels each row with its routing target (`normal` or `coding · <workspace>`). The [`schedule_task` tool](../agent/tools.md#routing-target--auto-injected--enforced) remains scoped to the calling agent's context. Task detail view includes an **Edit** button that opens an inline edit form pre-populated with current values.

## Speech endpoints

OpenAgentd does not expose speech endpoints. Browser/app voice input is
client-side speech recognition documented in [`web/voice-input.md`](../web/voice-input.md).

## Settings

User-editable runtime settings persisted under `{OPENAGENTD_CONFIG_DIR}`. Sandbox patterns match resolved absolute paths for filesystem-tool calls; see [`configuration.md`](../configuration.md#sandbox-model-and-permissions).

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/settings/title-generation` | `{enabled, model, wait_timeout_seconds}` from `settings.yaml` |
| `PUT` | `/api/settings/title-generation` | Persist title generation runtime settings |
| `GET` | `/api/settings/multimodal` | `{image, video}` from `multimodal.yaml` |
| `PUT` | `/api/settings/multimodal` | Persist image/video generation defaults |
| `GET` | `/api/settings/providers/{provider}/usage` | Live usage snapshot when supported (`codex`, `copilot`, or OAuth provider plugins with usage hooks) |

Provider usage responses return `{provider, limits}`. Codex may include rolling
windows, credits, unlimited plans, and reached limit states. Copilot returns the
premium request quota only. OAuth provider plugins can return the same response
shape from their usage hook; providers without usage support return 404.

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/settings/sandbox` | `{denied_patterns: string[]}` — current list (seed defaults when file absent or key missing) |
| `PUT` | `/api/settings/sandbox` | `{denied_patterns: string[]}` — replace the list; blank entries stripped |

`PUT` writes `{OPENAGENTD_CONFIG_DIR}/sandbox.yaml` atomically. New
patterns take effect on the next agent run (each `SandboxConfig`
re-reads the file at construction). Workspace and memory roots remain
exempt regardless of pattern matches.

Application updates have no HTTP surface: desktop bundle users use the
Tauri updater from **OpenAgentd → Check for Updates…** or
**Settings → About → Updates**, and CLI/server users run
`openagentd upgrade` in the shell that launched the process.

## Permission endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/team/{session_id}/permissions` | `{permissions: PermissionRequest[]}` — all pending approval requests |
| `POST` | `/api/team/{session_id}/permissions/{request_id}/reply` | `{status, request_id, reply}` |

### GET /api/team/{session_id}/permissions

Returns all pending permission requests for this session. With `AutoAllowPermissionService` (default) this list is always empty since requests are auto-approved. Poll or listen to `permission_asked` SSE events when a blocking service is wired.

### POST /api/team/{session_id}/permissions/{request_id}/reply

Reply to a pending permission request. Body fields:

| Field | Type | Notes |
|-------|------|-------|
| `reply` | `"once"` \| `"always"` \| `"reject"` | `once`: allow single invocation. `always`: allow this pattern for the session. `reject`: deny and surface error to agent. |
| `message` | `string \| null` | Optional feedback (currently unused). |

Returns `{status: "ok", request_id, reply}` on success; 404 if not found or already resolved.

---

## Misc

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/health/live` | `{status:"ok",version:"..."}` — always 200 |
| `GET` | `/api/health/ready` | 200 when DB is reachable; 503 otherwise |
| `GET` | `/metrics`         | Prometheus exposition (scrape target) |
| `GET` | `/api/observability/summary?days=N` | span-derived aggregates (turns, tokens, latency, errors, `sample_ratio`) |
| `GET` | `/api/observability/traces?days=N&limit=L&offset=O` | trace list (one row per root `agent_run`), newest first |
| `GET` | `/api/observability/traces/{trace_id}?days=N` | full span tree for one trace; 404 when outside the `days` window |
| `GET` | `/api/quote` | `{quote: string, author: string}` — cached daily, fetched from API Ninjas |

---

## POST /api/team/chat — send or interrupt

Accepts `multipart/form-data` validated via `ChatForm`.

### ChatForm fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `message` | string \| null | — | User's typed text; required for normal send |
| `session_id` | string \| null | — | Omit to start a new session |
| `interrupt` | bool | `false` | Set `true` to stop all running members |
| `mode` | `normal` \| `coding` | `normal` | Coding mode loads agents from `{OPENAGENTD_CONFIG_DIR}/agents/coding/` |
| `workspace` | string \| null | — | Required when `mode=coding`; reused automatically when resuming a coding session |
| `files` | UploadFile[] | — | See supported types below (normal send only) |

### Two mutually exclusive modes

**Normal send** (`interrupt=false`):
- `message` is required.
- `session_id` optional — omit to create a new session.
- Returns HTTP 202 with `status: "accepted"`, or `status: "queued"` plus `message_id` when a lead turn is already active.

**Coding send** (`mode=coding`):
- `workspace` must be an existing directory.
- One live team is kept per resolved workspace; multiple workspaces can run at the same time.
- Concurrent sends to the same workspace are serialized per team: if a lead turn is active, the new message is queued and drained in order; otherwise it starts a fresh activation. Same model as normal mode.
- Uploaded files are stored under `<workspace>/uploads/` so the unread hint `./uploads/<filename>` matches the coding sandbox root and explicit `read("uploads/<filename>")` works directly.
- The workspace root's `AGENTS.md`, when present and under the size limit, is appended to the model system prompt.
- The web UI enters coding mode at `/coding`; the last opened workspace is restored locally. Persisted coding session routes use `/coding/{session_id}` without a workspace query param; the workspace is resolved from session detail.

`GET /api/team/workspace/browse?path=...` supports the frontend folder picker. It lists readable child directories only; omit `path` to start at the server user's home directory. The frontend requires an explicit trust confirmation before opening a newly selected directory. The `/coding` workbench also uses workspace file listing and git diff endpoints to render an IDE-like project rail.

**Interrupt** (`interrupt=true`):
- `session_id` is required.
- `message` must be absent.
- Returns `{"status": "interrupted", "session_id": "..."}` with HTTP 200.
- The agent loop breaks mid-stream; the checkpointer has already saved partial output. Completed tools keep their real results; still-running tools return `"Cancelled by user."`.
- The interrupted assistant row is stamped with `extra["interrupted"] = true` (invisible to UI/audit) — content itself is left intact.
- The SSE stream emits a final `done` event with `cancelled: true` in metadata:
  ```json
  { "type": "done", "metadata": { "cancelled": true } }
  ```
  Clients should reload the session from `GET /api/team/sessions/{id}` on receiving this event.

### Mention auto-attachment

The route scans `message` for `@<path>` tokens and resolves each against the session workspace via `app/api/routes/team/_helpers.py::collect_mention_attachments`. Resolved files are appended to the same `attachments: list[RawAttachment]` as the multipart `files`, then flow through the standard `validate_and_persist_attachments` + `build_parts_from_metas` pipeline.

This runs on both the **immediate dispatch path** and the **queued path** — when a lead turn is active, mention attachments and explicit file uploads are persisted to disk at queue time and stored in `extra.attachments` on the queued row. Cancelling a queued message also deletes its persisted files.

| Mention kind | Auto-attached? | Notes |
|---|---|---|
| Text / document | Yes | Reused size limits (`SIZE_LIMITS["text"] = 500 KB`, `SIZE_LIMITS["document"] = 5 MB`). |
| Image | No | Reference only — the agent uses its vision-aware `Read` tool to fetch on demand, so base64 pixels don't ride on every history rehydration. |
| Folder | Yes, if `AGENTS.md` exists | `@folder/` resolves to `folder/AGENTS.md`; missing files are silently skipped. |
| Bad path / traversal / missing | No | Silently dropped. |

Soft constraints: per-message cap of 20 mention attachments, global byte cap of `GLOBAL_SIZE_LIMIT` (20 MB). Capability-incompatible documents are skipped. Mentions never surface a 4xx — explicit paperclip uploads remain the authoritative way to force a file in.

#### Head + tail truncation for inlined content

Mention-sourced `RawAttachment` objects set `truncate_inline_to = 32_000` (chars). `_persist_attachment` in `agent_service` runs `converted_text` through `_maybe_truncate_inline(text, cap)`, which returns the text unchanged when it fits, otherwise keeps the first `cap // 2` chars + a marker line + the last `cap // 2` chars:

```
<first 16,000 chars>

... [Middle truncated — N chars elided. Use the Read tool for full content.] ...

<last 16,000 chars>
```

Paperclip uploads leave `truncate_inline_to = None`, so the full body always reaches the prompt — same behaviour as before. Truncation is mention-only.

#### Attachment fence format

`build_parts_from_metas` wraps text/document attachment bodies in matched open + close tags so the model can tell where the file ends:

```
[File: notes.txt]
<body>
[End file: notes.txt]
```

(Documents use `[Document: …]` / `[End document: …]`.) Without the close tag, agents tended to re-call `Read` on already-inlined files. Image uploads are different: unread uploads contribute only a stable text hint (for example `[Attached image path: ./uploads/photo.png. Use the read tool to inspect it.]`). Actual image bytes enter LLM context only after an explicit `read("uploads/<filename>")` tool call, whose multimodal `ToolMessage.parts` are then replayed durably from the DB.

---

## POST /api/team/commands — slash-command dispatch

Accepts `application/json`. Runs a control operation against an existing session — no new user message is persisted.

### Body

| Field | Type | Notes |
|-------|------|-------|
| `command` | `"continue" \| "compact" \| "undo" \| "redo"` | Control operation to run. |
| `session_id` | string | Existing team-lead session id. |

### `command: "continue"`

Resume the prior assistant turn — useful after the user pressed Stop or the server restarted mid-stream.

- The command persists a short hidden `HumanMessage` directive before activation. It tells the model to continue exactly where the prior response stopped, is hidden from UI history and summarization, and remains in LLM context so persisted history matches the provider payload for prompt-cache consistency.
- If the previous assistant turn stopped during tool execution, unresolved tool calls are completed with synthetic interrupted tool results before continuation.
- The new assistant row is flagged with `extra["is_continuation"] = true` so the UI can render it tight against the prior bubble.
- The directive never appears in the frontend's history view.

Returns 202 with `{"status": "accepted", "session_id": "...", "command": "continue"}`. Subscribe to `GET /api/team/{session_id}/stream` for the SSE feed.

Returns 409 (`{"detail": "..."}`) when continuation is not meaningful:
- **Session not found.**
- **Session belongs to '<name>', not '<lead>'.** — ownership guard.
- **Session has no messages to continue from.** — empty session.
- **Last message is not an assistant message — nothing to continue. Send a new message instead.** — last visible row is a user/tool message.
- **Cannot continue while <lead> is working — wait for the turn to finish.** — concurrent `/continue` requests; the working-state guard is atomic inside `activate_for_continuation`.

### `command: "compact"`

Run a lead turn that forces the existing summarizer before the next model call. For coding sessions, the command resolves the persisted session workspace and dispatches to the coding team so compaction uses the coding-mode structured summary prompt. This streams the same `summarization_*` events as automatic compaction, creates a summary row, excludes compacted rows from future LLM context, and does not add a visible user message.

Returns 202 with `{"status": "accepted", "session_id": "...", "command": "compact"}`. Subscribe to `GET /api/team/{session_id}/stream` for the SSE feed.

Returns 409 (`{"detail": "..."}`) when compaction cannot run:
- **Lead is already working.** — avoid compacting while a turn is mutating history.
- **Session not found.**
- **Session belongs to '<name>', not '<lead>'.** — ownership guard.
- **Session has no messages to compact.** — empty session.

### `command: "undo"`

Move the session revert boundary to the latest visible user message and restore that turn's workspace snapshot. Messages at or after that boundary remain in history for redo, but future LLM context and the web UI render only messages before the boundary. The response includes the reverted user message so the client can place it back into the composer for editing. Clients should apply the boundary to any in-flight local stream blocks as well as persisted blocks, because a stopped turn can leave optimistic user/tool blocks in memory before the final reload arrives.

Returns 202 with `{"status": "accepted", "session_id": "...", "command": "undo", "message": {...}, "changed_paths": [...]}`. `changed_paths` is omitted when scoped workspace refresh is unavailable.

Returns 409 (`{"detail": "..."}`) when the boundary cannot be moved:
- **Lead is already working.** — the lead has an in-flight turn.
- **Agent '<name>' is still working. Stop it before /undo.** — a member is streaming (lead may be idle). Reverting mid-stream would orphan the in-flight assistant tokens on the client; `/stop` first.
- **Session not found.** / **Session belongs to '<name>', not '<lead>'.** — ownership guards.
- **No user message to undo.** — already at the earliest user turn.

### `command: "redo"`

Move the session revert boundary forward by one undone user turn and restore its workspace snapshot. When no later undone user message exists, the boundary is cleared and the session is live again. The web UI repeats this command for `/redo` until all undone turns are visible.

Returns 202 with `{"status": "accepted", "session_id": "...", "command": "redo", "message": {...}, "changed_paths": [...]}` while another undone turn was restored. Returns `message: null` when the boundary is cleared. `changed_paths` is omitted when scoped workspace refresh is unavailable.

Returns 409 (`{"detail": "No undone message to redo."}`) when there is no revert boundary.

Returns 422 for unknown commands (rejected by the `Literal["continue", "compact", "undo", "redo"]` validator before any handler runs).

---

## File upload

Accepts `multipart/form-data`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `message` | string | ✓ | User's typed text |
| `session_id` | string | — | Omit to start a new session |
| `files` | UploadFile[] | — | See supported types below |

**Supported file types:**

| Category | Extensions | Max size |
|----------|-----------|---------|
| Text | `.txt .csv .tsv .json .jsonl .md` | 500 KB |
| Image | `.png .jpg .gif .webp .bmp` | 10 MB |
| Document | `.pdf .docx .doc` | 5 MB |

Global limit: 20 MB total across all files in one request.

File upload requires matching model capabilities — images need `input.vision=true`, documents need `input.document_text=true`. Returns HTTP 422 if capability is missing.

---

## SSE event protocol

The stream emits `text/event-stream` events. Parse the `event:` line explicitly — do not rely on the JSON `type` field alone.

```
event: message
data: {"text": "Hello", "agent": "assistant"}

event: tool_call
data: {"name": "web_search", "tool_call_id": "tc_abc"}
```

### Event types

| Event | Payload | When |
|-------|---------|------|
| `thinking` | `{text, agent?}` | Reasoning token delta |
| `message` | `{text, agent?}` | Text token delta |
| `tool_call` | `{name, tool_call_id, agent?}` | First tool call delta arrives |
| `tool_start` | `{name, arguments, tool_call_id, agent?}` | Full args assembled, tool about to execute |
| `tool_output_delta` | `{name, text, stream, sequence, tool_call_id, agent?}` | Live output from a running tool. Currently emitted by foreground `shell`. |
| `tool_end` | `{name, result, tool_call_id, agent?}` | Tool result returned |
| `usage` | `{prompt_tokens, completion_tokens, cached_tokens?, agent?}` | End of turn |
| `rate_limit` | `{retry_after?, attempt?, max_attempts?}` | Transient provider rate limit hit before a retry sleep. |
| `error` | `{message, metadata?: {agent, exception}}` | Unrecoverable error. In team mode, emitted when the **lead** fails (member failures are routed to the lead via mailbox — see [`agent/teams.md`](../agent/teams.md#sse-events-team-specific)). The frontend surfaces this as an error toast via `useToastStore`. |
| `done` | `{metadata?: {cancelled?: true}}` | Turn complete — DB is now authoritative. `cancelled: true` present when interrupted. Agent streams in `error` or `offline` status are **not** reset to `idle` by this event — those states persist until an explicit later lifecycle event. |
| `title_update` | `{title}` | LLM-generated session title is ready. Fired on the first turn only, concurrently with the agent run. Pub/sub only — not replayed on reconnect. |

### Team-only events

| Event | Payload | When |
|-------|---------|------|
| `agent_status` | `{agent, status: "idle"\|"working"\|"offline"\|"error", metadata?: {message}}` | Agent lifecycle state. `offline` means the member is no longer live; clients should hide it from live panes. On `error`, `metadata.message` carries the human-readable reason. |
| `inbox` | `{agent, content, from_agent}` | Agent received inter-agent message |
| `permission_asked` | `{request_id, session_id, tool, patterns}` | Agent requesting approval before executing a tool |
| `permission_replied` | `{request_id, session_id, reply}` | Permission request resolved (`once`\|`always`\|`reject`) |

All team events carry an `agent` field for demultiplexing.

Split-view clients should compute pane layout from currently visible, non-`offline` agents so remaining panes reclaim space immediately after dismissal.

### 3-phase tool lifecycle

```
tool_call          → signals a tool is being called (first delta, args may be partial)
tool_start         → full arguments assembled, execution begins
tool_output_delta* → optional live output chunks
tool_end           → result returned
```

Clients should handle all three phases idempotently — reconnect replays the full event sequence.

### Reconnect-safe events

The following event types are stored in the in-memory state blob and replayed on reconnect: `thinking`, `tool_call`, `tool_start`, `tool_end`, `message`, `inbox`, and `agent_status`. Events like `tool_output_delta`, `rate_limit`, and `session` are pub/sub-only (live delivery). `agent_done` no longer exists — per-agent completion is signalled by `agent_status: idle`.

`thinking` and `message` are replayed **per agent** — the state blob stores `content` and `thinking` as `{agent_name: accumulated_text}` dicts so each agent's stream is re-emitted with the correct `agent` field after a mid-turn reconnect. `agent_status` is stored as a latest-wins `{agent_name: status}` map and replayed **before** any thinking/message events so the frontend's "working" indicator flips on before text starts arriving.

---

## MessageResponse schema

```json
{
  "id": "...",
  "session_id": "...",
  "role": "user",
  "content": "describe this",
  "file_message": true,
  "attachments": [{
    "filename": "abc123.jpg",
    "original_name": "photo.jpg",
    "media_type": "image/jpeg",
    "category": "image",
    "url": "/api/team/{session_id}/uploads/abc123.jpg"
  }]
}
```

Server-internal fields (`converted_text` — the LLM-only document body — and
`path` — the absolute on-disk location) are always stripped from attachment
metadata before returning to clients. Clients fetch bytes via the
`/api/team/{sid}/uploads/{filename}` endpoint instead.

The `url` field is the canonical client fetch URL for attachments. It may be a
root-relative API path (for example `/api/team/{sid}/uploads/abc123.jpg`); web
clients normalize that path against the configured API base URL before rendering
thumbnails, opening file links, or re-fetching an attachment.

---

## Media proxy

Two endpoints serve on-disk files back to the web UI. Normal sessions use the
per-session workspace; coding sessions use their resolved project workspace for
media/listing, while uploads still live under `OPENAGENTD_WORKSPACE_DIR`.

| Endpoint | Source | Scope |
|----------|--------|-------|
| `GET /api/team/{session_id}/uploads/{filename}` | `{OPENAGENTD_WORKSPACE_DIR}/{session_id}/uploads/` | User-uploaded attachments (flat, sanitized original names with ` (n)` dedupe suffixes when needed) |
| `GET /api/team/{session_id}/media/{path}` | session or coding workspace | Agent workspace output (nested paths allowed) |

User-uploaded files are also reachable by the agent's filesystem tools as
the relative path `uploads/<filename>` — so user-uploaded images can feed
workspace-bound tools (image/video generation, etc.) without a staging
step. Unread image uploads contribute only a stable text hint to LLM
history; actual image bytes enter context after an explicit
`read("uploads/<filename>")` tool call, and that multimodal tool result is
then replayed durably from the DB.

Both endpoints:

- Require `session_id` to be a valid UUID (400 on malformed).
- Reject path traversal (`..`), absolute paths, and symlink escapes (400).
- Return 404 for missing files or directories.
- Set `Content-Type` via `mimetypes.guess_type`.

### Markdown image rendering

Assistant messages are rendered via `MarkdownBlock` in the web UI.  Bare
relative paths in `![alt](path)` are rewritten to the media proxy:

- `![chart](chart.png)` → `GET /api/team/{session_id}/media/chart.png`
- `![upload](/api/team/{session_id}/uploads/abc123.jpg)` → the same API path,
  resolved against the configured API base URL
- `![logo](https://…)` → passthrough (absolute URLs, `data:`, `blob:` unchanged)

Agents can therefore write an image to the workspace (e.g. via `write` or
`shell`) and reference it in their response — the UI will display it.

---

## Workspace file listing

`GET /api/team/{session_id}/files` returns a flat recursive listing of regular files under the session workspace. `GET /api/team/workspace/files/list?workspace=...` does the same for a coding workspace and returns `workspace` instead of `session_id`. These power
the **Files** drawer and `/coding` workspace rail — see
[`documents/docs/web/workspace-files.md`](../web/workspace-files.md). File
bytes are fetched separately through the `/media/` proxy above.

**Response — `WorkspaceFilesResponse`:**

```json
{
  "session_id": "019…",
  "files": [
    {
      "path": "output/chart.png",
      "name": "chart.png",
      "size": 18243,
      "mtime": 1734556812.4,
      "mime": "image/png"
    },
    {
      "path": "notes.md",
      "name": "notes.md",
      "size": 412,
      "mtime": 1734556820.1,
      "mime": "text/markdown"
    }
  ],
  "truncated": false
}
```

| Field | Type | Notes |
|-------|------|-------|
| `path` | string | Relative, POSIX-separated. Safe to pass back to `/media/{path}`. |
| `name` | string | Basename. |
| `size` | int | Bytes. |
| `mtime` | float | Seconds since epoch. |
| `mime` | string | Guessed via `mimetypes.guess_type`; falls back to `application/octet-stream`. |
| `truncated` | bool | `true` when the walk hit the 500-file cap. |

**Rules:**

- `session_id` must be a valid UUID for session-scoped listing (400 on malformed).
- Missing workspace directory → `200` with `files: []`.
- `.git/` and common generated directories (`node_modules`, `dist`, `build`,
  `.venv`, `venv`, `__pycache__`) are always pruned. All other entries —
  including dot-prefixed ones like `.openagentd/`, `.github/`, `.env.example`
  — are surfaced unless filtered by the root `.gitignore`. The picker honours
  `!`-negation, so `.openagentd/*` + `!.openagentd/skills/` re-includes the
  tracked subtree.
- Directories, named pipes, sockets, and symlinks whose resolved target escapes
  the workspace root are skipped.
- Entries are sorted lexicographically; the walk stops at
  `_MAX_FILES_LISTED = 500` (constant in `app/api/routes/team.py`).

**Path safety.** The listing endpoint takes **no client-supplied path
parameter** — the root is always `workspace_dir(session_id)`. A caller cannot
pass `..` to escape the workspace. Per-file fetches go through the media proxy
(`GET /api/team/{session_id}/media/{path}`), which rejects `..`, absolute paths,
and URL-encoded traversal variants, and verifies `resolved.relative_to(root)`
after `Path.resolve()` (symlink-escape guard). See the Media proxy section
above.

**Invalidation:** the frontend refetches this endpoint whenever a
`tool_end` event fires for a mutating filesystem tool (`write`, `edit`, `rm`) —
see `web/src/stores/useTeamStore.ts`. No new SSE event is emitted for workspace
changes.

---

## Todo list

`GET /api/team/sessions/{session_id}/todos` returns the session-scoped todo list from `{OPENAGENTD_DATA_DIR}/sessions/{session_id}/.todos.json`.

**Response — `TodosResponse`:**

```json
{
  "todos": [
    { "task_id": "task_1", "content": "Research the topic", "status": "completed", "priority": "high", "dependencies": [], "assigned_to": "member#1", "claimed_by": "member#1" },
    { "task_id": "task_2", "content": "Write the report", "status": "pending", "priority": "high", "dependencies": ["task_1"], "assigned_to": "member#2", "claimed_by": null }
  ]
}
```

Response model: `TodosResponse` (Pydantic). Each `TodoItemResponse`:

| Field | Type | Values |
|-------|------|--------|
| `task_id` | string | Auto-assigned slug: `task_1`, `task_2`, … |
| `content` | string | Brief task description |
| `status` | string | `pending` \| `in_progress` \| `completed` \| `cancelled` |
| `priority` | string | `high` \| `medium` \| `low` |
| `dependencies` | string[] | Prerequisite task IDs |
| `assigned_to` | string \| null | Concrete agent handle assigned to the task, e.g. `executor#1` |
| `claimed_by` | string \| null | Agent handle that claimed the task |

Returns `{todos: []}` when the session todo file does not exist yet. `session_id` must be a valid UUID (400 on malformed).

**Invalidation:** the frontend refetches via `queryKeys.todos(sessionId)` whenever a `tool_end` event fires for `todo_manage` — see `web/src/stores/useTeamStore.ts`. The **Todos** popover in the chat header displays this data — see [`documents/docs/web/todos.md`](../web/todos.md).

---

## Key patterns

- `POST /api/team/chat` returns 202 immediately. The actual agent run happens in a background task.
- `session_id` comes from the POST response body — no `session` SSE event is emitted.
- After `done` fires, DB is authoritative. Reload the session from `GET /api/team/sessions/{id}`.
- After a `done` event with `meta.cancelled === true`, reload from DB — partial output has been checkpointed.
- `POST /api/team/chat` with `interrupt=true` cancels working members; they remain live and return to `idle`.
- `GET /api/team/{session_id}/history` queries DB via `parent_session_id` FK — not live team state. Safe for historical sessions.

---

## SessionResponse schema

```json
{
  "id": "019...",
  "title": "Research AI agents",
  "agent_name": "orchestrator",
  "created_at": "2026-04-10T...",
  "updated_at": "2026-04-10T...",
  "sub_sessions": [...]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID | Session ID |
| `title` | string? | Session title. Initially set to the first ~100 chars of the user message. Replaced by an LLM-generated title within ~1–2s via `title_update` SSE event on the first turn. |
| `agent_name` | string? | Agent name (team lead for team sessions) |
| `created_at` | datetime? | |
| `updated_at` | datetime? | |
| `model` | string? | Per-session lead model override. Empty/reset means use the lead agent default. |
| `thinking_level` | string? | Per-session lead thinking override: `none`, `low`, `medium`, or `high`. |
| `sub_sessions` | SessionResponse[] | Child member sessions (team lead sessions only) |
