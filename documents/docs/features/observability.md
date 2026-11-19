---
title: "Features: Observability"
description: "Logs, telemetry, usage and cost, all kept on the machine."
---

# Observability

Part of the [feature catalogue](../features.md), under *9. Observability*. The index explains the version tags.

Everything stays local. No third-party telemetry SaaS.

- **Built-in telemetry dashboard** `[since v1.0]` — `/telemetry` route in the web
  UI. Focused usage/cost cards, cache hit/miss by step and provider:model,
  scroll-paginated traces, and trace waterfall details.
- **Usage overlay** `[v3.0.0]` — usage telemetry opens over the current screen from
  the status-bar spend, the mobile drawer, or **Open Usage** in the palette (it
  was named Telemetry until `[v3.36.0]`, and the palette still finds it by that
  name); `/telemetry`
  links (`?days=`, `?traceId=`, `?session=`) open it too. It shows spend, turns
  (and how many failed), median turn time, tokens, and cache hit rate, per-day
  spend or turns, and spend by workspace, session, model, and tool. Filter by
  range (24h to 90d), workspace, model, or session; clicking a workspace,
  session, or model row applies that filter, so a session becomes a per-session
  view with an **Open session** action. Recent turns can be limited to failed ones,
  and a turn opens to its facts (workspace, model, duration, tokens, cost),
  **Copy trace ID**, **Open session**, and the span waterfall. Turns record their
  workspace from v3.0.0. Failed turns, stopped turns, and compaction-only turns
  (`/compact`, idle compaction) count as turns, and spend and turns from older
  telemetry are credited to their session's workspace. Only spend whose session
  was deleted, or that ran outside a session, shows as **Not recorded**
  `[v3.21.0]`.
  A `/telemetry` link opens Usage once: closed, it stays closed when the app
  opens again (before `[v3.59.0]` every later launch reopened it). While a
  session filter's title loads, its chip shows a visible placeholder
  `[v3.59.0]`. Since `[v3.62.0]` the line "Update the server to filter by
  workspace or model." shows only for a server that answered without
  filters; it used to flash on every load.
- **Model speed in telemetry** `[v3.0.0]` — every streamed model call records
  its time to first token and its output speed in tokens per second. The
  overview shows the median first token (with p95) and the median output speed
  (with the slowest 5%), each model row shows its median of both, and a
  model-call span lists them. Calls recorded earlier count toward everything
  else but not toward speed.
- **Prompt-cache miss causes** `[v3.28.0]` — each model-call span records a
  fingerprint of the system prompt, the tool list, and the first changed
  message, so a turn that missed the provider's prompt cache shows what changed.
- **Sub-agents in session telemetry** `[v3.0.0]` — a session's telemetry view
  counts the sub-agent sessions it started in its spend, turns, and tokens, and
  says how many. The Sessions card lists each sub-agent under its session (in
  the overview too), and recent turns name the agent that ran them.
- **90-day telemetry retention** `[v3.13.0]` — local traces and metrics are
  kept for 90 days by default (traces were previously kept for 30), so the
  90-day telemetry range shows full trace history. Older data is removed by a
  daily sweep. Since `[v3.35.0]` the period is set in **Settings → Data retention** (named Telemetry before v3.36.0);
  the `OPENAGENTD_OTEL_SPAN_RETENTION_DAYS` and `OPENAGENTD_OTEL_METRIC_RETENTION_DAYS`
  variables are no longer read.
- **Telemetry retention setting** `[v3.35.0]` — **Settings → Data retention**
  sets how many days local traces and metrics are kept (0 to 3650, default
  90; 0 keeps them forever). Saving a shorter period deletes older telemetry
  right away instead of at the next daily sweep. This replaces
  `OPENAGENTD_OTEL_RETENTION_ENABLED`, which is no longer read.
- **No more local metric files** `[v3.47.0]` — telemetry keeps traces only.
  The daily `{STATE_DIR}/otel/metrics` files fed nothing (every number in
  Usage comes from traces) yet grew every day until the retention sweep.
  The folder is deleted on the first start of this version.
- **OpenTelemetry spans** `[since v1.0]` — `OpenTelemetryHook` emits spans for
  agent runs, model calls, tool calls. Optional OTLP exporter.
- **Estimated model-call cost telemetry** `[v1.34.0]` — chat, title-generation,
  and summarization spans include estimated USD cost when model-registry pricing
  and provider usage tokens are available. Cost lookups now always use the
  fully-qualified `provider:model` id, so Anthropic's cache-write bucket is
  priced at the cache-write rate instead of being silently dropped by a bare-id
  registry miss, and the estimate applies DeepSeek's published off-peak rates
  (50% of peak outside Mon–Fri 01:00–04:00 and 06:00–10:00 UTC) `[v2.4.2]`.
  Since `[v3.29.0]` DeepSeek replies use DeepSeek's current peak prices,
  including `deepseek-flash` (also used for the retired `deepseek-v4-flash`
  names), and get the off-peak half price again, by the time each reply
  finishes. Chinese public holidays are priced as peak.
  The telemetry dashboard also reports cache-write tokens separately from cache
  reads in the totals, provider:model, and cache-by-step views `[v2.4.2]`.
- **Fast JSONL-backed query API** `[v2.0.0]` — `/api/observability/*` queries
  local OpenTelemetry span logs directly using `orjson` parsing, delivering faster
  query execution and lower latency without DuckDB binary dependency weight.
- **Two-tier logging** `[since v1.0]` — app log at `{STATE_DIR}/logs/app/`,
  per-session JSONL transcript at `{STATE_DIR}/logs/sessions/{id}/`. Rotated,
  loguru-based. `OPENAGENTD_FILE_LOG_LEVEL` `[v1.130.0]` sets the app-log threshold
  independently of the console's `OPENAGENTD_LOG_LEVEL` (default `DEBUG`, unchanged); the
  error log stays ERROR-only, so raising it never hides crashes.
- **Export diagnostics** `[v3.31.0]` — the desktop **Help → Export
  Diagnostics…** item, also in the Windows/Linux tray, saves an
  `OpenAgentd Diagnostics <time>` folder to Downloads and shows it in the file
  manager. The folder holds the desktop and backend logs, plus an `about.txt`
  with the version and OS. Values that look like API keys, tokens and
  passwords are replaced with `[REDACTED]`. This is best-effort, so check the
  files before sharing them.
- **Persistent reply/tool timing in UI** `[v1.21.0]` — assistant footers show
  full user-turn wall-clock duration; tool rows show individual execution time.
  Durations stay after a reload.
- **Delta turn reconciliation** `[v1.120.4]` — a completed turn transfers only
  the messages it produced (`GET /agent/{id}/history?since=`) instead of
  re-downloading the whole visible page, which reaches ~1.7 MB on an active
  session and duplicates what the SSE stream just delivered. Falls back to a
  full page when the client has fallen too far behind. Session-list `running`
  badges, auto-generated titles, and the workspace file tree likewise update by
  in-place cache patching rather than refetching every loaded page.
