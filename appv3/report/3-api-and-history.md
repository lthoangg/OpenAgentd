# REPORT §3: the HTTP API, sessions and history

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

## Session-pinned credentials and run settings

Migration 00000030 adds `chat_sessions.credential_id` (nullable; NULL is
Auto). `SessionResponse` gains `credential_id`, omitted on Auto, so v2
response shapes are unchanged. The session list, detail, history, resolve
and PATCH responses also carry `credential_label`, the pinned credential's
name, omitted on Auto or once the credential is gone (the desktop tray shows
it without reading credentials).

`PATCH /api/agent/sessions/{id}` additionally accepts `model`,
`thinking_level` and `credential_id`: a present key sets the field, `null`
clears it (the agent's model or level, or Auto). The model must be in the
registry; the credential must exist, be enabled, belong to the session
model's provider, and that provider must pool its credentials without an
exported key overriding them (422 otherwise). Changing the model to another
provider returns the session to Auto. The body error for an empty PATCH now
names all six fields. `POST /api/agent/chat` (form field) and
`POST /api/agent/sessions/resolve` (new sessions only) accept
`credential_id`, saved before the first turn starts.

A pinned session's requests start on that credential while it is ready,
and never move the provider's shared "in use" choice. Its members
(subagents) follow the lead's pin, as do goal checks, side questions and
titles generated on the session's provider (also by a configured title model
on that provider). Cooldowns stay shared. While the pin cools down (a quota,
rate limit, rejection or spend cap), its requests fall through to the other
ready credentials in priority order, like an unpinned session's, and return to
the pin once it recovers. The turn waits (`waiting_quota`) only when every
credential is cooling, for the first to recover. Older transcripts may hold
a `waiting_credential` status (same fields as `waiting_quota`), which v3 no
longer emits. A `switched_credential` `provider_status` also carries
`credential_label`, the account the turn moved to. A pin whose credential was
removed or turned off is cleared at the next turn, with a `provider_status`
`pin_released` note.

Assistant rows' `extra` gains `credential_id` and `credential_label`, the
stored credential that answered (pooled providers only). `GET
/api/settings/providers/{id}/credentials` adds `pinned_sessions` per
credential. Each `GET /api/settings/providers/usage-summary` item adds
`account`, the label of the credential its limits belong to (the one the
provider's next request uses) when the provider pools two or more enabled
credentials, else `null`.

## Account-scoped provider usage and throttling

Provider metadata adds `supports_usage` alongside `supports_credential_usage`.
Successful `GET /api/settings/providers/{id}/usage` responses keep `provider`
and `limits` and add `updated_at` (Unix seconds when fetched successfully).
The endpoint accepts `force_refresh=true`; it bypasses the measurement TTL,
not an active Retry-After cooldown or an in-flight request.

An upstream usage HTTP 429 now returns HTTP 429 (previously generic 502), a
`Retry-After` header and an object `detail` containing `code:
"usage_rate_limited"`, a safe message, `retry_after` seconds, `retry_at` Unix
seconds, and nullable `last_good`. The last-good value is a normal usage
response with its original `updated_at` and `stale: true`, retained for at
most 30 minutes. Other usage errors have stable codes `usage_unsupported`
(404), `usage_credentials` (404), `usage_rejected` (422) and
`usage_unavailable` (502); transient failures may also include `last_good`.
Raw upstream bodies, secrets and arbitrary headers are not forwarded.

The summary keeps its envelope and adds item status `rate_limited` plus
optional `retry_after`/`retry_at`. Stale readings retain an explicit failure
status rather than masquerading as fresh success. Its `checked_at` describes
the summary check; nested `usage.updated_at` describes the measurement.
The summary envelope is assembled per call (`cached: false`); measurements
share the same 60-second, per-resolved-account cache as the detail endpoint.
This replaces the provider-only summary cache and prevents mixing readings
when the active account changes. In-flight requests are joined per account,
and requests across accounts have bounded concurrency. A valid Retry-After
is honored without shortening; missing/invalid values use bounded backoff.
Cache and usage cooldown live only in memory and never affect chat-pool
cooldowns. Reconnect, credential replacement and removal invalidate account
state; ordinary token refresh and quota redemption do not bypass cooldown.

The existing plugin `HttpError` headers option is used to carry Retry-After;
there is no new plugin API. Old plugins without headers use default backoff.
Spend payloads may include optional `currency` for client formatting; unknown
units remain numeric instead of being assumed to be money. No on-disk
credential or database format changes.

## Deviations, one per item

- **Performance changes to the wire format** (v3 only; v2 parity is no
  longer a goal):
  - *History pages* (`GET /api/agent/{sid}/history`,
    `api/src/routes/agent/chat/history.rs`). Member rows and the session-wide
    `estimated_cost_usd` / `completion_tokens` totals come only on the
    newest page and on `since` deltas. Older (`before`) pages return
    `members: []` and omit the lead's totals. v2 paged each member with
    the lead's `(seq, id)` cursor, but `seq` is per session, so every
    older page re-sent each member's newest rows, which the web client
    then prepended twice. Member pages run concurrently, and the totals
    for the lead and all members come from one grouped scan. Covered by
    `history_paging_flow` in `api/tests/http_api.rs`.
  - *JSON bytes* (`api/src/util.rs`, `db/src/codec.rs`). Responses and the
    DB's JSON columns (`extra`, `tool_calls`, tool-call `arguments`) are
    compact `serde_json`, with non-ASCII written as UTF-8. v2 used
    Python's `json.dumps` style (`", "`/`": "` separators, `\uXXXX`
    escapes), about 6× the bytes for non-ASCII text in rows and provider
    requests. Rows written in the old style still parse. History messages
    are serialized straight from the row (`db::api::MessageView`), so an
    old row's `tool_calls`/`extra` keep their stored spacing and escapes;
    JSON clients read both the same.
  - *History and session-list cursors.* `before` is `seq[|id]` (history)
    or `<created_at>|<uuid>` (sessions), and `since` is a uuid7 message
    id: the forms the server hands out. v2's bare-timestamp cursors now
    get 422. Covered by `history_paging_flow` and
    `session_pages_follow_their_cursor` (`db/tests/queries.rs`).
- **Diagnostics fields:** `runtime.python="n/a"` and
  `implementation="Rust"`.
- **HTTP error texts:** network-level failures carry reqwest's wording
  instead of httpx's. OAuth-flow requests send reqwest's `accept: */*`.
- **Validation texts:** pydantic `ValidationError` messages are approximated.
- **Thinking time on assistant rows:** v3 adds `thinking_duration_ms` to
  an assistant message's `extra` when the model streamed reasoning: the
  time from its first reasoning delta to its first content or tool-call
  delta (`agent/src/hooks/publisher.rs`, tested in
  `agent/tests/thinking_duration.rs`). It is an extra key in the existing
  JSON column, not a schema change. v2 never writes it, and the web client
  shows "Thought" without a duration when it is absent.
- **Thinking level on assistant rows:** v3 adds `thinking_level` to an
  assistant message's `extra`, and to the `metadata` of its live `message`
  and `thinking` deltas: the level the turn's provider was built with (the
  session's level, else the agent's own; a session model override drops the
  agent's level, so none is recorded). Set in `agent/src/session/turn.rs`, stamped
  in `agent/src/agent.rs` and `agent/src/hooks/publisher.rs`, tested in
  `agent/tests/turn_thinking_level.rs`. v2 never writes it, and the web
  footer then names the model alone.
- **Agent thinking level in `GET /api/agent/agents`:** v3 adds
  `thinking_level` (the agent file's level, or `null`) to each agent entry
  (`api/src/routes/agent/chat.rs`, `serialize_agent`). The web footer shows
  it next to the agent's model until the session sets its own level or model.
  v2 omits the key, and the footer then names the model alone.
- **Active sessions filter:** `GET /api/agent/sessions?active=true` returns
  every top-level session that is running or waiting on a question, as one
  page (`next_cursor: null`, `has_more: false`), newest first. `limit` and
  `before` are ignored and `workspace` still narrows it
  (`api/src/routes/agent/chat/sessions.rs`, tested in
  `api/tests/http_api.rs`). The sidebar's **Needs you** list uses it, whatever
  page the sessions are on. v2 ignores the parameter and returns a normal
  page, which the web client filters to the same rows.
- **Session title search:** `GET /api/agent/sessions?q=…` keeps sessions
  whose title contains the text, ignoring ASCII case, with `%` and `_`
  matched literally. It pages like the normal list
  (`db/src/queries/sessions.rs`, tested in `api/tests/http_api.rs`) and
  backs the sidebar's session search. v2 ignores `q`, and the web client then
  filters the page it gets.
- **Multi-workspace session list:** `GET /api/agent/sessions?workspaces=…`
  (repeatable) keeps sessions in any of the listed paths, newest first, and
  pages like the normal list; a `workspace` value joins the same list, and
  `active=true` is narrowed the same way
  (`api/src/routes/agent/chat/sessions.rs`, `db/src/queries/sessions.rs`,
  tested in `api/tests/http_api.rs`). The sidebar uses it to list a
  repository and its worktrees as one list. v2 ignores `workspaces`, and the
  web client then filters the page it gets.
- **Session list sort:** `GET /api/agent/sessions?sort=activity` orders by
  `updated_at` (most recently touched first) and pages with a
  `"<updated_at>|<uuid>"` cursor; `sort=created`, the default, keeps v2's
  order, and any other value is a 422 `Invalid 'sort'.`. Migration 00000024
  adds the `(parent_session_id[, workspace], updated_at, id)` indexes behind
  it (`db/src/queries/sessions.rs`, tested in `db/tests/queries.rs` and
  `api/tests/http_api.rs`). The sidebar's default "Recent activity" sort
  uses it. v2 ignores `sort` and returns created order.
- **Pinned sessions:** `chat_sessions.pinned_at` (migration 00000024) backs
  the sidebar's **Pinned** section. `PATCH /api/agent/sessions/{id}` accepts
  `{"pinned": true|false}`, alone or with `title`/`interaction_mode`; pinning
  does not move `updated_at`, and a child session is not found, as for other
  updates. `SessionResponse` gains `pinned_at`, omitted when unpinned.
  `GET /api/agent/sessions?pinned=true` returns every pinned session as one
  page (most recently pinned first); `pinned=false` leaves pinned sessions
  out of a normal page. `active=true` ignores both. v2 has no pins: it
  ignores the filter and the PATCH field, so a pin-only PATCH fails there as
  an empty update.
- **Chat-created sessions register their folder:** `POST /api/agent/chat`
  without a `session_id` starts a session, and v3 now records its folder as a
  sidebar workspace the same way `/sessions/resolve` does (a managed worktree
  under its source repository; never the Chat workspace). The web's lazy
  new-session draft relies on it so a first message in a new folder lands in
  the tree. v2 does not register the folder here.
- **ETag on workspace listings (v3 only):** `GET /api/agent/{sid}/files`,
  `/api/agent/workspace/files/list`, `/api/agent/workspace/status`,
  `/api/agent/workspace/git-diff/view`, `/git-diff/files` and every
  `/api/agent/{sid}/history` page send an `ETag` (64-bit hash of the JSON
  body) with `Cache-Control: private, no-cache`, and answer `304` with an
  empty body when `If-None-Match` matches. The body is still computed on
  every request. CORS exposes `ETag` so the phone app (`tauri://localhost`,
  cross-origin) can read it; the web client revalidates the newest history
  page of its last four sessions. Tests: `api/src/routes/agent/files/tests.rs`,
  `api/tests/http_api.rs` (`history_etag_flow`). v2 always returns 200.
- **Uploads and media revalidate (v3 only):** `GET /api/agent/{sid}/uploads/…`
  and `/media/…` answer a matching `If-None-Match` (weak comparison, `*`),
  or without one an `If-Modified-Since` no older than the file, with `304`
  and no body (Starlette always sends the file). Uploads, which get a new
  name each (`dedupe_upload_filename`), send `Cache-Control: private,
  max-age=31536000, immutable`; media, which can change under its path,
  `private, no-cache`. Tests: `api/src/fileresp.rs`, `api/tests/http_api.rs`
  (`files_revalidate_flow`). v2 sends neither.
- **Members without rows in history (v3 only):** the newest history page and
  the `since` delta carry each member's `name`, `session_id`, `running`,
  `estimated_cost_usd` and `completion_tokens` with `messages: []` (v3
  earlier sent its newest 10 rows within 128 KB; v2 sends 100). The lead's
  view never renders them, and opening a member loads its own session. A
  busy member no longer sets `truncated` on the delta. Tests:
  `api/tests/http_api.rs` (`history_paging_flow`, `history_first_page_flow`).
- **Joined live deltas (v3 only):** the stream store sends the first
  `message`, `thinking`, `tool_output_delta` or `summarization_content`
  piece of a stream (an agent's text, one tool's output) at once, then joins
  the pieces that follow within 50 ms (or up to 8 KB) into one frame, keyed
  by event, agent and `tool_call_id`, so tools running side by side are
  joined each on its own. An agent's reply, thinking and summary share one
  order: a piece of one sends the held piece of another first (the client
  appends them to one transcript in arrival order). Held text goes out
  before any other event, before
  an attach (whose replay already has it) and at the end of the turn. The
  replay blob still takes every piece. The SSE writer sends events that are
  ready together as one write and pings only after 15 s of silence.
  `sse_stream_close` logs events, writes, pings, bytes, path and whether
  the peer is remote; `stream_deltas` logs pieces received and frames sent
  per turn; `history_page_served` (info) and `history_page_breakdown` log
  what each history page weighed. Tests: `agent/src/stream_store/tests.rs`,
  `api/src/sse.rs`, `api/src/middleware.rs`. v2 sends one frame per chunk.
- **History leaves out provider replay state (v3 only):** a message's
  `extra` goes out without `raw_content_blocks`, `reasoning_signature` and
  `reasoning_items` (as it already went without `parts`); the agent reads
  them from the database. Test:
  `db/src/api.rs`. v2 sends them.
- **History rows carry only what clients read (v3 only):** message rows
  drop `session_id`, `is_summary` (a summary is `kind: "summary"`) and
  `file_message`; `extra` drops `finish_reason`, `credential_id`,
  `snapshot` and its copy of `attachments` (sent once, beside it); `usage`
  keeps `input`, `output`, `cache`, `cache_percent`, `estimated_cost_usd`
  and `cost.estimated_usd`. Test: `db/src/api.rs`. v2
  sends them.
- **Gzipped event streams for remote clients (v3 only):** `text/event-stream`
  responses to a client that is remote (`Peer::remote()`) and accepts gzip
  go out gzipped with a sync flush after every frame, so each frame decodes
  as soon as it arrives (`middleware::gzip_event_stream`); `sse_gzip_closed`
  logs bytes in and out. A 24 s streamed reply: 51.6 KB → 5.9 KB. Loopback
  stays identity. Tests: `middleware.rs`. v2 sends identity.
- **The global event stream resumes (v3 only):** every global event has an
  SSE `id:` (`<boot>-<seq>`; `boot` is new on each server start), and the
  server keeps the last 500 of them, at most 15 minutes old
  (`agent/src/broadcaster.rs`). `GET /api/events/stream` (plain or with
  `client_id=`) starts with a `stream_resume` event,
  `{"replay": n, "resync": bool}`. With `?since=<id>` (the last id a client
  saw) the `n` events after it follow; when that id is from another boot or
  older than what is kept, `resync` is true and nothing is replayed (the
  client refreshes as it did on every reconnect). Without `since` the
  `stream_resume` carries the current position as its id. A `since` that is
  not shaped like an id is ignored. Session streams are not replayed here
  (they have their own replay). `events_stream_open` logs `resumed`,
  `replayed` and `resync`. Tests: `agent/src/broadcaster.rs`,
  `api/src/routes/events.rs`. v2 sends no ids and no `stream_resume`.
- **No `permission_asked` (v3 only):** tools are always allowed, so the
  per-call announcement after `tool_start` is gone from the stream and the
  event contract. Test: `agent/tests/session_turn.rs`. v2 sends it.
- **Tool output on demand (v3 only):** history tool rows and `tool_end`
  (live and replayed) leave out every tool's output except the answers a
  collapsed card is built from (`appv3_db::api::result_rides_inline`):
  all of `ask_user`, `plan`, `submit_plan` and `update_goal`; `preview`
  only for "Opening …"; `workspace` only for "Sent to '…'" or the
  confirmation placeholder, `mcp` only for that placeholder; `team`,
  `team_*` and `delegate` only when the first line names the subagent;
  `patch` only when it failed. `todo` and `schedule` output is always left
  out. Such a row has no
  `content` and carries `result_omitted: true` and `result_bytes`;
  `tool_end` sends `result: null` with the same two keys in `metadata`.
  `GET /api/agent/{sid}/tool-results/{tool_call_id}` returns
  `{tool_call_id, name, content}` for a call in the session or any session
  under it (404 otherwise); the web card calls it when the user opens the
  row or copies its result. Revision 00000032 adds the partial index
  `ix_session_messages_tool_call_id`, so this lookup seeks instead of
  reading the session tree, and the arguments endpoint walks back from the
  result to its call. `tool_output_delta` still streams while a tool
  runs, and the agent still reads full output from the database. Tests: `db/src/api.rs`,
  `agent/src/events.rs`, `agent/src/stream_store.rs`,
  `api/tests/http_api.rs` (`tool_result_on_demand_flow`). v2 sends every
  result.
- **Short tool arguments in history (v3 only):** history `tool_calls` send
  a short form of three tools' arguments, with the full size as
  `arguments_bytes` on the call: `shell` without its `command` when it has
  a `description` (otherwise the command's first line, at most 200 chars,
  with `command_truncated: true`), `patch` as
  `{files: [{path, kind, additions, deletions, move_to?}]}`, and `plan`
  without `content` and `edits` (`edit_count` instead). Calls with nothing to
  cut go out as stored. `GET
  /api/agent/{sid}/tool-calls/{tool_call_id}/arguments` returns
  `{tool_call_id, name, arguments}` from the session or any session under
  it; the web card calls it when the user opens the row or copies its
  arguments. Live and replayed `tool_start` keep full arguments: a running
  call is not in the database yet. Tests: `db/src/tool_args.rs`,
  `db/src/api.rs`, `api/tests/http_api.rs`
  (`tool_arguments_on_demand_flow`). v2 sends them whole.
- **Changed-files list (v3 only):** `GET /api/agent/workspace/git-diff/files`
  lists every changed path with status and +/− counts from
  `git diff --name-status/--numstat` and `ls-files --others` (capped at 5,000
  with the uncapped `total`), so the Review dock's list no longer depends on
  the diff text that `git-diff/view` cuts at 512 K characters. The dock now
  fetches bodies one file at a time from `git-diff/view?paths=…`, which reads
  paths literally (`--literal-pathspecs`) and keeps the `untracked` list when
  the tracked diff is cut. Test: `api/src/routes/agent/files/git/tests.rs`. v2 has
  only the whole diff.
- **Three v2 routes are gone (v3 only):** `GET
  /api/agent/{session_id}/permissions`, `POST
  /api/agent/{session_id}/permissions/{request_id}/reply` and `GET`/`PUT
  /api/settings/sandbox` now answer 404 (405 where the path still matches
  another method). The first two were stubs since tool approvals were
  removed (an empty list, and a 404 for every reply); the third was an
  alias of `/api/settings/denied-paths`. No client called them.
- **Message wording (v3 only):** an OAuth provider with no sign-in, or one
  whose refresh fails, says "… is not signed in. Sign in under Settings →
  Providers, or run `agentd auth <provider>`." where v2 said "… credentials
  not found. Run: agentd auth <provider>" (Copilot, Codex, Grok, and the
  Codex image backend). The 400s for chatting with or running a command on
  a subagent's session, and the 404 for a missing parent session, say "main
  agent" where v2 said "lead agent" / "Lead session". Nothing matches on
  these texts.
- **Default model on the first credential (v3 only):** `PUT
  /api/settings/providers/{id}` and `POST
  /api/settings/providers/{id}/credentials` set the provider's suggested
  model on every agent whose model is still unconfigured
  (`loader::has_unconfigured_agent_models`), and add `default_model` (the
  `<provider>:<model>` set, or `null`) and `agents_updated` to their
  responses. The model comes from `providers/src/suggest.rs`: the catalog's
  `suggested_models` patterns, where `*` matches a version, applied to the
  provider's live models, newest first by registry release date. `POST
  /api/settings/default-model` also takes `{"provider": "<id>"}` in place of
  `provider_model`, returns the model it applied as `provider_model`, and
  writes to `settings().agents_dir` (it used `config_dir/agents`, which
  ignored `AGENTS_DIR`). With no agent name, the unconfigured-model error now
  reads "No model is configured yet." instead of "Agent '?'". In v2, saving a
  key never changed an agent's model. Tests:
  `api/tests/default_model_on_save.rs`, `providers/src/suggest.rs`.
