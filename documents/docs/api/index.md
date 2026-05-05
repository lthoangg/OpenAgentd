---
title: API Reference
description: HTTP routes, SSE event protocol, file upload, workspace listing, media proxy, team chat endpoints.
status: stable
updated: 2026-05-05
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
| `GET` | `/api/team/agents` | `{agents: [{name, model, tools, mcp_servers, skills, is_lead, capabilities}]}` — `mcp_servers` lists configured MCP servers (incl. ones not yet ready); the UI groups tools by name prefix `mcp_<server>_<tool>`. |
| `GET` | `/api/team/sessions` | `SessionPageResponse` — cursor-paginated, newest-first |
| `GET` | `/api/team/sessions/{id}` | `SessionDetailResponse` |
| `DELETE` | `/api/team/sessions/{id}` | 204 — also deletes per-session uploads + agent workspace |
| `GET` | `/api/team/sessions/{id}/todos` | `TodosResponse` — current agent todo list for the session |

### GET /api/team/sessions — cursor pagination

Sessions are returned newest-first, 20 per page by default.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `before` | ISO 8601 string | — | Cursor: return sessions with `created_at` **older than** this value. Omit for the first page. |
| `limit` | int | `20` | Page size (1–100). |

`SessionPageResponse`:

```json
{
  "data": [ { "id": "…", "title": "…", "created_at": "…", "sub_sessions": [] } ],
  "next_cursor": "2026-04-17T10:23:45.123456Z",
  "has_more": true
}
```

Pass `next_cursor` as `?before=…` to fetch the next page. `has_more: false` means you have reached the end. No `total` count — the cursor avoids a `COUNT(*)` on every page.

## Agent file management

Manages per-agent `.md` files under `AGENTS_DIR`. Mutations write the
file and validate the new on-disk state; failures roll back the file so
disk state always matches a loadable team. The running team is **not**
rebuilt — drifted agents pick up the new config at the start of their
next turn (mtime-based drift check on the agent `.md`, `mcp.json`, and
referenced `SKILL.md` files). See [`configuration.md`](../configuration.md)
for the frontmatter schema and validation rules.

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/agents` | `{agents: AgentSummary[]}` — name, role, model, tools, skills, validity |
| `GET` | `/api/agents/registry` | `{tools, skills, providers, models}` — dropdown catalog for the settings UI |
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

**Validation** (422 on failure, with rollback of the on-disk file):
- Name must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` (enforced by `app/services/agent_fs.py::_NAME_RE`).
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
| `POST` | `/api/mcp/apply` | `ServerListResponse` — re-read `mcp.json`, reconcile runners |

`POST /apply` is the hook the `mcp-installer` skill calls after editing
`mcp.json` directly: it validates the file (422 on parse error before
any side effect), then reconciles runners. The running team and any
in-flight turn are not disrupted.

## Wiki endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/wiki/tree` | `WikiTreeResponse` — `system` (`USER.md`, `INDEX.md`), `topics`, `notes`. `?unprocessed_only=true` filters notes to files not yet processed by dream. |
| `GET` | `/api/wiki/file?path=USER.md` | `WikiFileResponse` — raw contents + parsed metadata |
| `PUT` | `/api/wiki/file` | `WikiFileResponse` — create or overwrite |
| `DELETE` | `/api/wiki/file?path=topics/foo.md` | `{status, path}` — `USER.md` and `INDEX.md` cannot be deleted |

Paths are relative to `OPENAGENTD_WIKI_DIR`. See [`agent/memory.md`](../agent/memory.md) for the wiki layout.

## Dream endpoint

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/dream/config` | `{content, exists}` — raw `dream.md` content |
| `PUT` | `/api/dream/config` | `{content, exists}` — overwrite `dream.md` and reload the scheduler |
| `POST` | `/api/dream/run` | `{sessions_processed, notes_processed, remaining}` — trigger dream synthesis immediately |

## Scheduler endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/scheduler/tasks` | `ScheduledTaskListResponse` — all tasks |
| `POST` | `/api/scheduler/tasks` | `ScheduledTaskResponse` 201 — create task |
| `GET` | `/api/scheduler/tasks/{id}` | `ScheduledTaskResponse` |
| `PUT` | `/api/scheduler/tasks/{id}` | `ScheduledTaskResponse` — full update |
| `DELETE` | `/api/scheduler/tasks/{id}` | 204 |
| `POST` | `/api/scheduler/tasks/{id}/pause` | `ScheduledTaskResponse` |
| `POST` | `/api/scheduler/tasks/{id}/resume` | `ScheduledTaskResponse` |
| `POST` | `/api/scheduler/tasks/{id}/trigger` | `ScheduledTaskResponse` — fire immediately |

`PUT` accepts a partial body (`ScheduledTaskUpdate`) — all fields optional. On update the backend cancels the existing timer, recalculates `next_fire_at`, persists to DB, and restarts the timer if `enabled=true`. See [`agent/tools.md`](../agent/tools.md#scheduler-builtinschedulepy) for field semantics and schedule types.

The web UI (`SchedulerPanel`, toggled with `Ctrl+S`) exposes all eight operations. Task detail view includes an **Edit** button that opens an inline edit form pre-populated with current values.

## Settings

User-editable runtime settings persisted under `{OPENAGENTD_CONFIG_DIR}` plus update checks for the running app. Sandbox patterns match resolved absolute paths for filesystem-tool calls; see [`configuration.md`](../configuration.md#sandbox-model-and-permissions).

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/settings/sandbox` | `{denied_patterns: string[]}` — current list (seed defaults when file absent or key missing) |
| `PUT` | `/api/settings/sandbox` | `{denied_patterns: string[]}` — replace the list; blank entries stripped |
| `GET` | `/api/settings/update` | `{current_version, latest_version, update_available, can_install, install_blocked_reason}` — check PyPI for updates |
| `POST` | `/api/settings/update/install` | `{status:"started"}` — start background update + restart when available |

`PUT` writes `{OPENAGENTD_CONFIG_DIR}/sandbox.yaml` atomically. New
patterns take effect on the next agent run (each `SandboxConfig`
re-reads the file at construction). Workspace and memory roots remain
exempt regardless of pattern matches.

Update install can return `409` when automatic install is unavailable, with a user-facing `detail` message.

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
| `files` | UploadFile[] | — | See supported types below (normal send only) |

### Two mutually exclusive modes

**Normal send** (`interrupt=false`):
- `message` is required.
- `session_id` optional — omit to create a new session.
- Returns `{"status": "queued", "session_id": "..."}` with HTTP 202.

**Interrupt** (`interrupt=true`):
- `session_id` is required.
- `message` must be absent.
- Returns `{"status": "interrupted", "session_id": "..."}` with HTTP 200.
- The agent loop breaks mid-stream; the checkpointer has already saved partial output. Completed tools keep their real results; still-running tools return `"Cancelled by user."`.
- The SSE stream emits a final `done` event with `cancelled: true` in metadata:
  ```json
  { "type": "done", "metadata": { "cancelled": true } }
  ```
  Clients should reload the session from `GET /api/team/sessions/{id}` on receiving this event.

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
| `tool_end` | `{name, result, tool_call_id, agent?}` | Tool result returned |
| `usage` | `{prompt_tokens, completion_tokens, cached_tokens?, agent?}` | End of turn |
| `rate_limit` | `{retry_after?, attempt?, max_attempts?}` | Provider rate limit hit; if `fallback_model` is configured, agent will switch to it after exhausting primary retries |
| `error` | `{message, metadata?: {agent, exception}}` | Unrecoverable error. In team mode, emitted when the **lead** fails (member failures are routed to the lead via mailbox — see [`agent/teams.md`](../agent/teams.md#sse-events-team-specific)). |
| `done` | `{metadata?: {cancelled?: true}}` | Turn complete — DB is now authoritative. `cancelled: true` present when interrupted. |
| `title_update` | `{title}` | LLM-generated session title is ready. Fired on the first turn only, concurrently with the agent run. Pub/sub only — not replayed on reconnect. |

### Team-only events

| Event | Payload | When |
|-------|---------|------|
| `agent_status` | `{agent, status: "working"\|"available"\|"error"}` | Agent state change |
| `inbox` | `{agent, content, from_agent}` | Agent received inter-agent message |
| `agent_done` | `{metadata: {agent}}` | Per-agent turn complete |
| `permission_asked` | `{request_id, session_id, tool, patterns}` | Agent requesting approval before executing a tool |
| `permission_replied` | `{request_id, session_id, reply}` | Permission request resolved (`once`\|`always`\|`reject`) |

All team events carry an `agent` field for demultiplexing.

### 3-phase tool lifecycle

```
tool_call  → signals a tool is being called (first delta, args may be partial)
tool_start → full arguments assembled, execution begins
tool_end   → result returned
```

Clients should handle all three phases idempotently — reconnect replays the full event sequence.

### Reconnect-safe events

The following event types are stored in the in-memory state blob and replayed on reconnect: `thinking`, `tool_call`, `tool_start`, `tool_end`, `message`, `inbox`, and `agent_status`. Events like `rate_limit` and `session` are pub/sub-only (live delivery). `agent_done` no longer exists — per-agent completion is signalled by `agent_status: available`.

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

---

## Media proxy

Two endpoints serve on-disk files back to the web UI. Both live under the
per-session workspace (see [`app/core/paths.py`](../../../app/core/paths.py)):

| Endpoint | Source | Scope |
|----------|--------|-------|
| `GET /api/team/{session_id}/uploads/{filename}` | `{OPENAGENTD_WORKSPACE_DIR}/{session_id}/uploads/` | User-uploaded attachments (flat, UUID-named) |
| `GET /api/team/{session_id}/media/{path}` | `{OPENAGENTD_WORKSPACE_DIR}/{session_id}/` | Agent workspace output (nested paths allowed) |

User-uploaded files reach the LLM via the curated multimodal rehydration
pipeline in `app/agent/multimodal.py`, and are *also* reachable by the
agent's filesystem tools as the relative path `uploads/<filename>` — so
user-uploaded images can feed workspace-bound tools (image/video
generation, etc.) without a staging step.

Both endpoints:

- Require `session_id` to be a valid UUID (400 on malformed).
- Reject path traversal (`..`), absolute paths, and symlink escapes (400).
- Return 404 for missing files or directories.
- Set `Content-Type` via `mimetypes.guess_type`.

### Markdown image rendering

Assistant messages are rendered via `MarkdownBlock` in the web UI.  Bare
relative paths in `![alt](path)` are rewritten to the media proxy:

- `![chart](chart.png)` → `GET /api/team/{session_id}/media/chart.png`
- `![logo](https://…)` → passthrough (absolute URLs, `data:`, `blob:` unchanged)

Agents can therefore write an image to the workspace (e.g. via `write` or
`shell`) and reference it in their response — the UI will display it.

---

## Workspace file listing

`GET /api/team/{session_id}/files` returns a flat recursive listing of every
regular file under the agent workspace (`workspace_dir(session_id)`). It powers
the **Files** drawer in the web UI — see
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

- `session_id` must be a valid UUID (400 on malformed).
- Missing workspace directory → `200` with `files: []`.
- Dotfiles and dot-directories are skipped at every depth.
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

`GET /api/team/sessions/{session_id}/todos` reads `.todos.json` from the agent
workspace and returns the current todo list.

**Response — `TodosResponse`:**

```json
{
  "todos": [
    { "task_id": "task_1", "content": "Research the topic", "status": "completed",  "priority": "high" },
    { "task_id": "task_2", "content": "Write the report",   "status": "in_progress","priority": "high" },
    { "task_id": "task_3", "content": "Send summary email", "status": "pending",    "priority": "low"  }
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

Returns `{todos: []}` when `.todos.json` does not exist yet. `session_id` must be a valid UUID (400 on malformed).

**Invalidation:** the frontend refetches via `queryKeys.todos(sessionId)` whenever a `tool_end` event fires for `todo_manage` — see `web/src/stores/useTeamStore.ts`. The **Todos** popover in the chat header displays this data — see [`documents/docs/web/todos.md`](../web/todos.md).

---

## Key patterns

- `POST /api/team/chat` returns 202 immediately. The actual agent run happens in a background task.
- `session_id` comes from the POST response body — no `session` SSE event is emitted.
- After `done` fires, DB is authoritative. Reload the session from `GET /api/team/sessions/{id}`.
- After a `done` event with `meta.cancelled === true`, reload from DB — partial output has been checkpointed.
- `POST /api/team/chat` with `interrupt=true` cancels all working members.
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
| `sub_sessions` | SessionResponse[] | Child member sessions (team lead sessions only) |
