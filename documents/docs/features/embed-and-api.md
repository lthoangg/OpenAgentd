---
title: "Features: Embed and API"
description: "The HTTP and SSE API the apps use, for other clients."
---

# Embed and API

Part of the [feature catalogue](../features.md), under *12. Embed and API*. The index explains the version tags.

The same HTTP + SSE API drives the desktop and mobile apps. Embed it elsewhere with no extra work.

- **REST + SSE chat API** `[since v1.0]` — `POST /api/agent/chat` is
  fire-and-forget (returns 202 in <50ms); the agent streams events on
  `GET /api/agent/{session_id}/stream`. Reconnect-safe replay.
- **Global app event stream** `[v1.103.0]` — first-party clients keep a
  lightweight `GET /api/events/stream` connection for cross-session
  lifecycle and metadata events. Scheduled turns wake the matching session
  stream, completed and stopped turns notify clients to sync and update session
  states globally, generated titles update every session surface, and native
  notifications no longer depend on the originating chat being open.
- **One stream for every window** `[v3.11.0]` — the windows of one app share a
  single connection to the backend: one window reads
  `GET /api/events/stream?client_id=…`, which carries the global events and,
  once a client lists them with `PUT /api/events/subscriptions/{client_id}`,
  the session streams of every window (`session_event`, `session_stream_end`).
  That keeps the app under the webview's six connections per host however many
  windows and sessions run, so approve, stop and list requests are never queued
  behind streams. `GET /api/agent/{session_id}/stream` stays for clients and
  older servers without it.
- **SSE event protocol** `[since v1.0]` — typed events: `thinking`, `message`,
  `tool_call`, `tool_start`, `tool_output_delta`, `tool_end`, `usage`,
  `inbox`, `agent_status`, `queued_turn_start`, `rate_limit`,
  `provider_status`, `error`, `done`. *(`permission_asked` removed in
  v3.46.0: tools are always allowed and no client acted on it.)*
- **Mid-turn reconnect** `[since v1.0]` — close the tab, reopen later; the
  stream replays buffered state then resumes live.
- **Self-healing live feed** `[v3.26.0]` — a session's live feed that goes
  quiet with no error no longer leaves a spinning tool card or an empty chat
  until a reload. A feed attached to a working turn that hears nothing for 10
  seconds, a turn start with no updates after it, or a global "needs input"
  whose question card never arrives makes the app reload the session and
  reattach; after two silent attempts that session uses its own connection.
  A subscription request that never answers (queued behind the webview's
  connection limit) restarts the shared stream after 10 seconds. The replay
  now carries the open question or plan review, a history reload no longer
  clears a newer live question, and a plan review refreshes the Plan panel.
  The server logs `mux_subscriptions_synced`, `mux_subscription_ended` and
  `events_stream_open kind=app|plain`.
- **Multi-client streaming** `[since v1.0]` — multiple tabs can watch the same
  session simultaneously.
