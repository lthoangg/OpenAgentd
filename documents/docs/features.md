---
title: Features
description: Canonical, version-cited catalogue of every user-visible OpenAgentd feature. Source of truth for slides, README, comparison docs, and marketing copy.
status: stable
updated: 2026-06-22
---

# Features

The single source of truth for everything OpenAgentd does. Every feature lists the
release that introduced it (where known) and links to the deeper doc when one
exists. When you ship something new, **add it here first** — slides, README,
[`comparison.md`](./comparison.md), and external copy should cite this page.

> **Headline.** OpenAgentd is the desktop cockpit for local AI agents — a
> double-clickable app that runs a team of AI agents on your machine, with a
> real UI to watch every step. Open source (Apache 2.0). 15 providers. Your keys.

**Latest release:** v1.57.2 · June 22, 2026 · [release notes](https://github.com/lthoangg/openagentd/releases/tag/v1.57.2)

---

## How this document is organised

Features are grouped by **pillar** — the same surfaces that drive the product
narrative on slides and in the README:

1. [The desktop cockpit](#1-the-desktop-cockpit)
2. [Agents and teams](#2-agents-and-teams)
3. [The coding workspace](#3-the-coding-workspace)
4. [Memory and context](#4-memory-and-context)
5. [Providers and models](#5-providers-and-models)
6. [Built-in tools](#6-built-in-tools)
7. [Extension surface](#7-extension-surface)
8. [Sandbox and permissions](#8-sandbox-and-permissions)
9. [Observability](#9-observability)
10. [Voice](#10-voice)
11. [Distribution and updates](#11-distribution-and-updates)
12. [Embed and API](#12-embed-and-api)

Conventions used in this document:

- `[v1.X.Y]` — release that shipped the feature (where known).
- `[since v1.0]` — present in the v1 line; no precise version known.
- *(beta)* — experimental, may change. *(deprecated)* — removed or replaced.
- Indented sub-bullets are user-visible details, not separate features.

---

## 1. The desktop cockpit

The product's primary surface. A native double-click app on macOS and
Linux that hosts the same FastAPI sidecar + React UI you would otherwise run
from the terminal. Deeper docs: [`desktop.md`](./desktop.md), [`web/chrome.md`](./web/chrome.md).

- **Native desktop app for macOS, Linux** `[since v1.0]` — Tauri 2 shell,
  bundled Python sidecar, embedded Web UI, one process, no terminal required.
  *(Windows desktop builds dropped in v1.23.0 — see [§11](#11-distribution-and-updates).)*
- **Explicit backend connection state** `[v1.44.1]` — desktop connection options
  are limited to the builtin sidecar and saved servers; no-backend dev windows
  show **Backend unreachable**, active server removal clears the current backend,
  and connecting a saved server no longer reloads before it can be named.
- **In-app auto-updater** `[v1.22.0]` — bottom-right update card + Settings → About
  → Updates, cached downloads, install-and-restart, signed minisign payloads,
  GitHub release notes rendered inline. Silent check at startup + every 6 hours.
  Earlier iterations: `[v1.18.0]`, `[v1.20.0]`, `[v1.21.0]`.
- **Native app notifications** `[v1.19.0]` — finished assistant turns,
  background tasks, scheduled reminders in the desktop app, plus local native
  notifications in the remote-backend mobile shell `[v1.34.0]`. Per-session
  context (coding workspace name when available). Settings → Notifications to
  toggle or send a test. Notification sounds are handled by the operating
  system; OpenAgentd does not play an extra in-app sound.
- **Command palette** `[since v1.0]` — `Ctrl+P` (or `Cmd+P`). Search sessions,
  agents, files, slash commands, settings.
- **Type-to-focus composer** `[v1.40.0]` — in cockpit and coding chat, start
  typing on the chat surface to expand/focus the composer and capture the first
  character without pressing `Ctrl+I` first. See [`web/chat-input.md`](./web/chat-input.md).
- **Native menu/tray shortcuts** `[v1.39.0]` — menubar shortcuts for Home,
  Cockpit, Coding, Command Palette, Wiki, Scheduled Tasks, Session Settings,
  key settings pages, updates, reload, config folder, and backend log; compact
  tray dropdown for status, quick navigation, reload, settings, and quit.
- **Touch back/forward navigation** `[v1.53.1]` — desktop Tauri windows support
  edge swipes on touch/pen devices: right from the left edge goes back, left
  from the right edge goes forward, while editable fields and scroll-like
  vertical gestures are ignored.
- **Multiple desktop windows** `[v1.41.0]` — open additional cockpit windows from
  File → New Window, the tray menu, or `Cmd/Ctrl+N`; windows share the bundled
  sidecar and desktop auth token, while each window can independently switch to
  a saved external server `[v1.47.0]`.
- **Editable session titles** `[v1.27.0]` — double-click a session card or use its
  edit affordance in the sidebar to rename saved sessions.
- **Slash commands** `[since v1.0]` — `/init`, `/continue`, `/compact`, `/undo`,
  `/redo`, plus user-defined commands. See [`commands.md`](./commands.md).
- **Bang shell commands** `[v1.39.0]` — start a message with `!` to run the
  remainder directly through the shell tool without a model turn; history stores
  the run as structured shell tool output. See [`shell-commands.md`](./shell-commands.md).
- **Drag-and-drop files into chat** `[since v1.0]` — images, PDFs, text. Multimodal
  parts attach to the user message.
- **Composer history navigation** `[v1.32.0]` — when the input is empty, `↑` / `↓`
  walks previous user prompts from the current chat plus local submissions. See
  [`web/chat-input.md`](./web/chat-input.md#composer-history-navigation).
- **Tool-call inspector** `[since v1.0]` — every tool call expands to show
  arguments, status, results, and inline Git-like diffs for file edits. Read
  results and file-change diffs keep line numbers visible while scrolling
  horizontally.
- **Inline diff previews with real line numbers** `[v1.20.0]` — file-changing tools
  show affected file's actual line numbers (not "starting at 1"), including
  multiple hunks. Collapsible per file. Delete counts shown in headers.
- **Persistent timing on every reply + tool call** `[v1.21.0]` — reply durations
  measure full user-turn wall-clock time; tool durations measure execution time.
  Both stay visible while streaming and after reloading a session.
- **Effective model on assistant replies** `[v1.42.0]` — assistant footers show
  the model that produced the reply, including fallback transitions, next to the
  copy and timing metadata.
- **`@file` / `@folder` mentions in composer** `[v1.17.0]` — files render blue,
  folders render orange. Inline auto-attach: mentioned file body is sent on
  the first turn so the agent doesn't need a round-trip `read` call; folder
  mentions load that folder's `AGENTS.md` when present. In coding sessions,
  clicked file mentions in sent user messages open that file in the workspace
  files sidebar. Caps at 20 mentions / 20 MB / ~32k chars per turn. Persists
  on queued messages.
- **Image viewer (full-screen)** `[since v1.0]` — click any generated or attached
  image to open in a lightbox; touch shells support swipe-down dismissal,
  double-tap zoom, and pinch zoom `[v1.45.2]`.
- **Workspace files panel** `[since v1.0]` — every file the agent reads, writes, or
  generates appears in the left drawer. Click to preview or download; desktop
  downloads use a native save dialog instead of navigating away from the app
  `[v1.52.0]`. See [`web/workspace-files.md`](./web/workspace-files.md).
- **Header context meter** `[v1.53.0]` — desktop and mobile chat headers show an
  icon-sized input-token progress ring against the backend's model-aware
  summarization trigger; hover, focus, or tap/click reveals input/output/cache
  details. See [`web/chrome.md`](./web/chrome.md).
- **Todos panel** `[since v1.0]` — task board with a topbar progress badge
  `<finished>/<total>` `[v1.17.0]`. Live invalidation. See [`web/todos.md`](./web/todos.md).
- **Mobile / phone-first layout** `[since v1.0]` — breakpoints, safe areas, drawer
  shapes, composer keyboard avoidance, touch row actions, pull-to-refresh,
  haptics, and legibility guards optimized for small screens `[v1.45.2]`;
  long-press rows get native impact haptics (`tauri-plugin-haptics`) and an
  iOS-style press-and-hold scale animation `[v1.47.0]`. See
  [`web/mobile.md`](./web/mobile.md).
- **macOS overlay + Tauri drag region** `[since v1.0]` — the header doubles as the
  window drag region; macOS gets the proper traffic-light overlay.
- **Restored desktop window size** `[v1.52.0]` — desktop windows reopen at the
  last normal size saved on quit, while minimized/maximized dimensions are ignored.
- **Remote-backend mobile shell** `[v1.34.0]` — Tauri mobile app scaffold embeds
  the shared Web UI and connects to saved remote API servers. See [`mobile.md`](./mobile.md).
- **LAN access key for external clients** `[v1.43.0]` — `openagentd start --lan --key`
  stores a `settings.yaml` bearer key so desktop, mobile, and browser clients need the key before controlling a LAN-exposed server. See [`cli.md`](./cli.md).
- **Desktop server connection manager** `[v1.43.4]` — the desktop **Server connection** dialog switches the current window between the builtin sidecar and saved external servers, validates LAN access keys, normalizes pasted `/api` URLs, and preserves other open windows' backend choices. Remembered external servers reconnect on app launch with sidecar fallback, while the desktop window opens immediately as backend startup continues asynchronously `[v1.57.1]`. See [`desktop.md`](./desktop.md).

---

## 2. Agents and teams

OpenAgentd is multi-agent by default. A lead agent drives the conversation and
spawns specialist members on demand. Deeper docs: [`agent/teams.md`](./agent/teams.md),
[`agent/loop.md`](./agent/loop.md), [`agent/hooks.md`](./agent/hooks.md).

- **Lead agent + member blueprints** `[since v1.0]` — exactly one `role: lead`
  agent; any number of `role: member` blueprints in `agents/`. Lead drives
  every conversation.
- **Live member spawning** `[since v1.0]` — `team_manage` spawns live instances
  such as `executor#1`, `explorer#1`, or `coder#1` on demand. Dismissing only
  removes the live instance; the blueprint stays. Re-spawning restores the same
  instance's history within the current lead session.
- **`team_message` peer delegation** `[since v1.0]` — async mailbox between
  agents. Lead delegates with `team_message`; the recipient's next turn drains
  its inbox.
- **Split-pane live view** `[since v1.0]` — each active agent gets its own pane,
  streamed independently. See live whose turn is current, who's idle.
- **Unified team view** `[since v1.0]` — single chronological transcript across
  the whole team for reading or sharing.
- **`/continue` resumes interrupted work** `[v1.5.0]` — restores the team's
  pending plan and resumes streaming from the last turn. Available in the
  command palette and assistant footer.
- **Automatic empty-after-tool recovery** `[v1.36.0]` — if a provider returns
  an empty assistant response immediately after a tool result, the lead keeps
  the same turn moving instead of silently ending after the tool call. See
  [`agent/loop.md`](./agent/loop.md#empty-after-tool-recovery).
- **Provider-timeout resume for long tasks** `[v1.37.0]` — when a slow or flaky
  model endpoint exhausts its retry/fallback budget mid-task (`ReadTimeout` /
  `ConnectError`), the loop resumes the same turn from where it left off
  instead of dropping the agent after a tool call. Bounded and interrupt-aware.
  See [`agent/loop.md`](./agent/loop.md#provider-timeout-resume).
- **Queued follow-up messages** `[v1.12.0, v1.14.0]` — send another message
  while the agent is still replying; it's queued and dispatched in order. Long
  queued messages are collapsible while a response runs `[v1.22.0]`. Queued
  messages now splice into the running turn at the next LLM-step boundary
  (not mid-tool-call), so the agent sees them on the very next iteration
  instead of waiting for the current turn to finish `[v1.25.0]`.
- **`provider_status` SSE events in stream** `[v1.17.0]` — retry, exhaustion,
  and fallback transitions surface live in single-agent and split-pane views.
- **Actionable provider HTTP errors** `[v1.56.0]` — non-retryable provider
  responses (400/401/403/404/422) are classified into typed errors that carry
  the provider's own explanation instead of a bare status code. 401/403 render
  the "configure / reconnect provider" banner; 400-class errors surface the
  specific reason (bad model, unsupported parameter, context too long) in the
  error event and lead notification. Exhausted connection/timeout failures
  likewise become a typed `ProviderConnectionError` naming the transport error
  and pointing at the provider's base URL.
- **Stop pauses queued follow-ups instead of dropping them** `[v1.17.0]` — Stop
  releases queued hidden user messages into visible history so you can
  `/undo`, edit, or append before resuming.
- **Session-level model + thinking-level override** `[v1.16.0]` — override the
  lead agent's model and thinking level for the current chat. History keeps
  the model used for each user turn.
- **Coding team variant** `[since v1.0]` — `agents/coding/` ships a separate
  compact team (`coding/openagentd`, `coding/coder`, `coding/explorer`) tuned for
  workspace-aware sessions; the coding explorer focuses on inspecting the current
  codebase before implementation.
- **Built-in first-party agent profiles** `[v1.23.0]` — the default `openagentd`
  lead and shipped member blueprints keep their core prompts, tools, and
  descriptions versioned in code for normal and coding modes; seed/user `.md`
  files remain lightweight extension points for model knobs, extra capabilities,
  and extra prompt text. Seed install also removes obsolete untouched first-party
  files from older curated sets while preserving custom files.
- **Automatic first-party member materialization** `[v1.37.0]` — missing shipped
  member blueprints are restored from code when a team loads, so production builds
  do not depend on bundling the source `seed/` tree.

---

## 3. The coding workspace

Coding mode (`/coding`) opens a local project folder and runs a workspace-aware
team against it. Deeper doc: [`web/coding-sessions.md`](./web/coding-sessions.md).

- **Open any local project folder** `[since v1.0]` — server-local paths only.
  Coding mode shows file tree + live git diff (including untracked files) in
  the side drawer. Desktop uses the native folder picker only for the bundled
  sidecar or loopback backends; LAN/external backends use the web folder browser
  so the selected path exists on the backend host.
- **Git worktree sessions** `[v1.41.0]` — create an isolated git worktree from
  an existing coding workspace, start a new coding session in that worktree,
  list existing worktrees, and remove OpenAgentd-managed worktrees.
- **Changed-file highlights in the workspace tree** `[v1.30.0]` — modified and
  untracked files are marked directly in the Files tab, parent folders show a
  changed-state indicator, and the tab badge reports the changed-file count.
- **Two-layer workspace file viewer** `[v1.29.0]` — clicking a file in the coding
  workspace side drawer opens a read-only viewer beside it with line numbers,
  lightweight syntax highlighting, image previews, extensionless text files,
  and binary download fallback.
  Select lines and click **Add comment** to insert an `@path#Lx-Ly` composer
  reference; the backend auto-attaches only the selected file lines.
- **Persisted coding sessions per workspace** `[v1.18.0]` — `/coding/{session_id}`
  restores workspace context from the saved session. Bare `/coding` is the
  launcher or last-workspace restore. New empty sessions exist before the
  first message.
- **Workspace sidebar pagination** `[v1.18.0]` — each workspace shows 5 sessions
  with a bottom *Load more* control; one busy workspace doesn't crowd the others.
- **`@file` / `@folder` auto-attach** `[v1.17.0]` — see [§1](#1-the-desktop-cockpit).
- **Slash commands scoped to coding workspaces** `[v1.17.0]` — project-local
  commands in `.openagentd/commands/**/*.md` and `.opencode/commands/**/*.md`
  load only when a workspace is attached. Local commands win on name conflict.
  Cockpit chat stays global-only.
- **Snippet picker** `[v1.31.0]` — in coding workspaces, type `#` anywhere
  in the composer to pick prompt snippets from `.openagentd/snippets/**/*.md`
  or `{OPENAGENTD_CONFIG_DIR}/snippets/**/*.md` and insert the rendered body.
- **Git-backed `/undo` and `/redo`** `[v1.11.0]` — restore workspace files
  (created, modified, deleted) to the exact prior state from any prior turn in
  chat history. Different from editor undo: this is tied to chat turns.
- **`/init` scaffolds AGENTS.md** `[v1.9.0]` — writes AGENTS.md files at the
  repo root and meaningful subfolders from the workspace.
- **Inline patch tool for multi-file edits** `[v1.5.0]` — structured patches
  with multiple hunks, real line numbers, collapsible previews.
- **Workspace status card** `[v1.18.0]` — empty coding sessions show the
  workspace path, branch, dirty state, last commit instead of the old
  agent-selection fallback.
- **Sessions ≥ 100 messages load completely with scroll preserved** `[v1.9.0]`.

---

## 4. Memory and context

OpenAgentd carries durable, editable memory across sessions. Deeper doc:
[`agent/memory.md`](./agent/memory.md), [`agent/context.md`](./agent/context.md),
[`agent/summarization.md`](./agent/summarization.md).

- **`USER.md` auto-injection** `[since v1.0]` — pure YAML durable user facts,
  injected into every prompt. Identity, preferences, projects, standing context.
- **Editable wiki memory** `[since v1.0]` — Karpathy-style wiki at
  `{OPENAGENTD_WIKI_DIR}` with `sources/`, `topics/`, `entities/`,
  `comparisons/`, `notes/`. Browse and edit from the Wiki panel.
- **`wiki_search` tool** `[since v1.0]` — explicit search across wiki pages.
  Pages are not auto-injected — the agent queries them when it decides.
- **Dream agent (idle consolidation)** `[since v1.0]` — runs at idle, reads
  notes + recent sessions, promotes durable concepts into wiki pages, maintains
  `INDEX.md` and `LOG.md`.
- **`/compact` rolling-window summarization** `[v1.5.0]` — compresses old turns
  into a single summary message kept in context; UI shows the unabridged
  conversation. Preserves reasoning and loaded skill/tool context; skill
  instruction tool-call pairs remain active after repeated compaction while the
  summarizer keeps the same cacheable prompt prefix as normal chat turns.
- **Notes** `[since v1.0]` — `note` tool writes append-only daily files at
  `wiki/notes/{date}.md`. The dream agent reads these.
- **`AGENTS.md` at repo root and subfolders** `[v1.9.0]` — written by `/init`;
  standard repo- and folder-scoped agent context files.
- **Per-message provider metadata** `[v1.17.0]` — assistant messages persist
  the model that generated each reply (visible in inspector).
- **Memory v2 / Dream v2 wiki** `[v1.41.0]` — Karpathy-style markdown memory
  with `SCHEMA.md`, `INDEX.md`, `LOG.md`, `notes/`, `imports/`, and `wiki/`;
  deterministic Dream maintenance compiles canonical DB sessions, notes, and
  imports into cited active fact bullets; explicit `memory_search`, conservative
  automatic relevant-memory injection, a VSCode-like memory tree UI, and manual
  LongMemEval-style retrieval/injection evals expose quality and false-positive
  failures. See [`agent/memory.md`](./agent/memory.md).

---

## 5. Providers and models

Switch providers with one line in your agent config. The product is provider-
agnostic by design. Deeper doc: [`configuration/providers.md`](./configuration/providers.md).

**15 first-class providers:**

| Provider | Config syntax | Auth |
|---|---|---|
| Anthropic Claude | `anthropic:claude-sonnet-4-6` | `ANTHROPIC_API_KEY` `[v1.14.0]` |
| Google Gemini | `googlegenai:gemini-3.1-flash` | `GOOGLE_API_KEY` |
| Google Vertex AI | `vertexai:gemini-3-flash-preview` | `VERTEXAI_API_KEY` or GCP creds |
| OpenAI | `openai:gpt-5.5` | `OPENAI_API_KEY` |
| OpenRouter | `openrouter:qwen/qwen3.6-plus:free` | `OPENROUTER_API_KEY` |
| ZAI / GLM | `zai:glm-5-turbo` | `ZAI_API_KEY` |
| xAI Grok | `xai:grok-4.20` | `XAI_API_KEY` |
| DeepSeek | `deepseek:deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| AWS Bedrock | `bedrock:anthropic.claude-sonnet-4-6` | AWS profile/access keys via Settings → Providers or AWS default chain `[v1.54.0]` |
| NVIDIA NIM | `nvidia:stepfun-ai/step-3.5-flash` | `NVIDIA_API_KEY` |
| GitHub Copilot (OAuth) | `copilot:gpt-5.4-mini` | `openagentd auth copilot` |
| OpenAI Codex (OAuth) | `codex:gpt-5.5` | `openagentd auth codex` |
| Router9 (local) | `router9:cc/claude-sonnet-4-5` | `ROUTER9_API_KEY` (optional) |
| CLIProxyAPI (local) | `cliproxy:gemini-2.5-pro` | `CLIPROXY_API_KEY` (optional) |
| Ollama (local + cloud) | `ollama:llama3.2` · `ollama:kimi-k2.6-cloud` | none (cloud: `ollama signin`) |

- **Auto-fallback chain** `[since v1.0]` — set `fallback_model` in an agent
  config; rate limits and 5xx errors automatically retry on the fallback.
- **Fast fallback on long retry-after** `[v1.18.2]` — agents with a configured
  `fallback_model` skip remaining primary retries when the retry delay ≥ 60s.
- **Drop-in provider plugins** `[v1.6.0]` — Python files in the configured
  plugins directory register new providers at startup.
- **Resilient provider construction** `[v1.17.0]` — missing/unavailable
  providers no longer block startup; an unconfigured stub surfaces an
  actionable UI error on first use.
- **Chat-completions-only compatible routing** `[v1.44.3]` — OpenAI-compatible
  providers that do not expose OpenAI's Responses API stay on `/v1/chat/completions`
  even when session or agent thinking settings are enabled.
- **Anthropic-compatible custom endpoints** `[v1.16.0]` — providers needing
  custom headers or alternate message endpoints are supported.
- **OAuth subscription support** `[v1.8.0]` — Copilot, Codex, others via the
  built-in OAuth helper.
- **Codex usage monitor** `[v1.32.0]` — Settings → Providers shows live Codex
  OAuth usage windows, resets, credits, unlimited plans, and spend-cap/limit states.
- **Codex Fast mode** `[v1.45.0]` — when the lead model is `codex:*`, session
  settings can opt new messages into ChatGPT-subscription Fast mode.
- **Copilot usage monitor** `[v1.33.0]` — Settings → Providers shows live Copilot
  premium request quota from the saved OAuth token.
- **Provider plugin usage hooks** `[v1.33.0]` — OAuth provider plugins can
  surface live usage in the same Settings → Providers panel as built-ins.
- **Provider-scoped visible models** `[v1.57.0]` — Settings → Providers lets
  users choose which live-discovered models appear in normal model pickers;
  failed auth or unreachable discovery returns an empty list instead of curated
  defaults.
- **Curated multimodal model registry** `[v1.34.0]` — model modality gates,
  token limits, cost, support flags, and thinking-level metadata are maintained
  in one exact-match registry: bundled JSON snapshot, runtime `models.dev`
  cache, explicit compatibility aliases for runtime provider/model IDs that differ
  from the upstream source IDs, and optional local YAML overlay.

---

## 6. Built-in tools

Tools the agent can call without any extra configuration. Add more via skills or
MCP. Deeper doc: [`agent/tools.md`](./agent/tools.md).

| Category | Tools |
|---|---|
| Filesystem | `read`, `write`, `edit`, `patch`, `ls`, `glob`, `grep`, `rm` |
| Shell | `shell`, `bg` (background processes) |
| Web | `web_search`, `web_fetch` |
| Memory | `wiki_search`, `note` |
| Generation | `generate_image`, `generate_video` |
| Scheduling | `schedule_task` |
| Tasks | `todo_manage` |
| Team coordination | `team_message`, `team_manage` |
| Utility | `date`, `skill` |

- **Cross-tool `tool_output_delta` streaming** `[since v1.0]` — long-running
  tools (shell, web search) stream output to the inspector as they run.
- **Tool result offload** `[since v1.0]` — bulky tool outputs (large file
  reads, shell spills) move to `{OPENAGENTD_DATA_DIR}/sessions/{id}/.tool_results/` and the inspector
  links to them.
- **`.gitignore`-aware file tools** `[v1.20.1]` — `glob`, `grep`, and workspace
  file browsing respect `.gitignore` and skip generated directories.

---

## 7. Extension surface

Four orthogonal ways to add capability. Deeper docs:
[`agent/plugins.md`](./agent/plugins.md), [`configuration/skills.md`](./configuration/skills.md),
[`configuration.md`](./configuration.md).

- **MCP servers** `[since v1.0]` — any Model Context Protocol server, hot-reloaded
  via `POST /api/mcp/apply`. Per-agent scoping. OAuth-backed setup. Includes a
  bundled MCP installer skill `[v1.8.0]`. Session Settings can enable/disable
  scoped MCP servers and connect OAuth-backed servers in place `[v1.52.2]`.
- **Sandboxed UI artifacts** `[v1.36.0]` *(beta)* — tool-produced HTML UI
  resources render as sandboxed sibling chat artifacts. The first producer is
  MCP Apps: MCP tools that declare `_meta.ui.resourceUri` can render `ui://`
  resources with MIME `text/html;profile=mcp-app`. First slice targets
  interactive Excalidraw diagrams; fullscreen now uses the full viewport with
  mobile safe-area padding, and the host exposes its own fullscreen button
  `[v1.45.2]`. If later tool results reference the same UI resource, chat shows only the
  newest artifact for that resource. The same-server bridge can invoke tools
  currently advertised by the artifact's originating MCP server only `[v1.37.0]`.
  Production desktop and mobile Tauri shells allow `about:` frames so `srcdoc`
  MCP Apps render interactively under the packaged CSP `[v1.44.11]`.
- **MCP `PATH` resolution on desktop** `[v1.17.x]` — desktop auto-resolves the
  shell `PATH` so `npx` / `uvx` stdio servers can find their commands. Restart
  any MCP server in Settings to re-detect.
- **Skills** `[since v1.0]` — markdown `SKILL.md` files, lazy-loaded, hot-reload
  on mtime change, token substitution. Compatible with the opencode skill spec.
  One nested namespace level (`parent/sub`) is supported `[v1.27.x]`; Settings
  lists the full runtime-visible catalog and can edit/delete non-bundled skills
  in place `[v1.27.x]`. Bundled first-party skills include `browser-use` for
  CLI-driven browser automation `[v1.43.4]`.
- **Plugins** `[v1.6.0]` — Python files dropped into `OPENAGENTD_PLUGINS_DIRS`.
  Register `@plugin` functions or `Plugin(BaseAgentHook)` classes with
  `tool.before` / `tool.after` / agent lifecycle hooks. Per `(agent, role)` filter.
- **Slash commands** `[since v1.0]` — `.md` files with optional frontmatter,
  available globally or scoped to a coding workspace (`[v1.17.0]`). One nested
  namespace level is supported and displayed in the composer as colon syntax
  (`/git:commit`) `[v1.27.x]`.
- **Self-healing skill** `[v1.14.0]` — agent edits its own `.md` config (model,
  tools, MCP) and the runtime picks up the change at end-of-turn.

---

## 8. Sandbox and permissions

Single-user trust model. The host is trusted. The operator is the user. Deeper
doc: [`configuration/sandbox.md`](./configuration/sandbox.md).

- **Path denylist** `[since v1.0]` — absolute paths anywhere on disk are accepted
  *unless* they resolve under a denied root (`OPENAGENTD_DATA_DIR`,
  `OPENAGENTD_STATE_DIR`, `OPENAGENTD_CACHE_DIR`) or match a user-defined glob
  in `sandbox.yaml`. Symlinks are rejected only when targeting a denied root.
  Tilde paths are always rejected.
- **Permission system: allow / deny / ask** `[since v1.0]` — wildcard rule
  matching per tool. Auto-allow, blocking on user reply, or persistent rules.
- **Shell command pre-scan** `[since v1.0]` — best-effort path-token scan
  inside shell commands.

---

## 9. Observability

Everything stays local. No third-party telemetry SaaS. Deeper doc:
[`observability.md`](./observability.md), [`logging.md`](./logging.md).

- **Built-in telemetry dashboard** `[since v1.0]` — `/telemetry` route in the web
  UI. Focused usage/cost cards, cache hit/miss by step and provider:model,
  scroll-paginated traces, and trace waterfall details.
- **OpenTelemetry spans** `[since v1.0]` — `OpenTelemetryHook` emits spans for
  agent runs, model calls, tool calls. Optional OTLP exporter.
- **Estimated model-call cost telemetry** `[v1.34.0]` — chat, title-generation,
  and summarization spans include estimated USD cost when model-registry pricing
  and provider usage tokens are available.
- **DuckDB-backed query API** `[since v1.0]` — `/api/observability/*` queries
  the local DuckDB span store.
- **Two-tier logging** `[since v1.0]` — app log at `{STATE_DIR}/logs/app/`,
  per-session JSONL transcript at `{STATE_DIR}/logs/sessions/{id}/`. Rotated,
  loguru-based.
- **Persistent reply/tool timing in UI** `[v1.21.0]` — assistant footers show
  full user-turn wall-clock duration; tool rows show individual execution time.
  Durations stay after a reload.

---

## 10. Voice

Client-side speech recognition. OpenAgentd does not run backend microphone transcription.

- **Mic button in composer** `[since v1.0]` — click to start listening, click to
  stop. Transcript text is inserted into the chat input for review before sending.
- **Browser / OS speech recognition** `[v1.34.0]` — uses the current browser or
  app WebView speech recognizer when available. No `/api/speech/*` backend,
  `speech.yaml`, or bundled `faster-whisper`. See [`web/voice-input.md`](./web/voice-input.md).

---

## 11. Distribution and updates

Desktop is primary. CLI / server is the developer path. Deeper doc:
[`install.md`](./install.md).

- **macOS desktop** `[since v1.0]` — Homebrew cask
  (`brew install --cask lthoangg/tap/openagentd`) or `.dmg` with bundled
  `install.sh` (ad-hoc signs locally).
- **Linux desktop** `[since v1.0]` — AppImage (`chmod +x`) or `.deb` for
  Debian/Ubuntu.
- **Windows desktop** *(deprecated, removed in v1.23.0)* — NSIS `.exe`
  and `.msi` installers are no longer produced. The Windows leg of
  `release-desktop.yml` and the `install.ps1` curl-pipe installer were
  also removed. Windows users can still run the CLI/server via WSL2.
- **Signed update manifests** `[v1.2.2+]` — minisign-signed `latest.json` at the
  rolling `latest-desktop` release; verified before install.
- **In-app updater** `[v1.22.0]` — see [§1](#1-the-desktop-cockpit).
- **CLI install** `[since v1.0]` — `uv tool install openagentd`, `pipx`, `pip`,
  `brew install lthoangg/tap/openagentd`.
- **CLI server control** `[v1.41.0]` — `restart`, `address`, `health`, and
  `start --lan --key` make the CLI the control plane for desktop/mobile backends.
- **CLI upgrade** `[v1.41.0]` — `openagentd upgrade` stops the background
  server, delegates to the detected package manager, then restarts it when it
  was running.
- **Docker** *(deprecated, removed in v1.23.0)* — the `Dockerfile`,
  `docker-compose.yaml`, and the `ghcr.io/lthoangg/openagentd` image are
  no longer maintained. Use the CLI install paths above; revisit if there
  is concrete self-hoster demand.
- **Migration imports** `[since v1.0]` — `openagentd migrate openclaw`,
  `migrate hermes`. Imports identity + context Markdown into one lead agent.
- **Cross-platform single-instance** `[v1.13.0]` — opening the app twice
  focuses the existing window instead of launching a duplicate.
- **Desktop force-reload preserves sidecar state** `[v1.12.0]` — refreshes the
  web UI without killing the Python sidecar or auth state.

---

## 12. Embed and API

The same HTTP + SSE API drives the desktop, browser, and mobile clients. Embed it elsewhere with no extra work. Deeper doc: [`api/index.md`](./api/index.md).

- **REST + SSE chat API** `[since v1.0]` — `POST /api/team/chat` is
  fire-and-forget (returns 202 in <50ms); the agent streams events on
  `GET /api/team/{session_id}/stream`. Reconnect-safe replay.
- **SSE event protocol** `[since v1.0]` — typed events: `thinking`, `message`,
  `tool_call`, `tool_start`, `tool_output_delta`, `tool_end`, `usage`,
  `inbox`, `agent_status`, `queued_turn_start`, `rate_limit`,
  `provider_status`, `permission_asked`, `title_update`, `error`, `done`. See
  [`architecture.md`](./architecture.md).
- **Mid-turn reconnect** `[since v1.0]` — close the tab, reopen later; the
  stream replays buffered state then resumes live.
- **Multi-client streaming** `[since v1.0]` — multiple tabs can watch the same
  session simultaneously.
- **Embeddable web UI** `[since v1.0]` — the wheel-bundled UI can be served
  from the API process or behind your own reverse proxy.

---

## Not yet shipped

Future work and known issues are tracked in GitHub issues, not in this feature
catalogue. See [`roadmap.md`](./roadmap.md) for the short priority list and
issue-label links.

When a feature ships, add it to the right pillar above with its `[vX.Y.Z]` tag
and link to the relevant doc.

---

## How to update this document

When you cut a release:

1. **For each user-visible change**, find the right pillar (1–12) and add a
   one-line entry with the `[vX.Y.Z]` tag.
2. If a pillar doesn't fit, add a new one — but don't shoehorn unrelated work
   into an existing pillar.
3. If the change is user-visible, also update:
   - [`../../README.md`](../../README.md) "What you get" section only if it is
     important enough for the short README feature list
   - [`comparison.md`](./comparison.md) if the new feature lands in the capability matrix
4. Close the GitHub issue that tracked the feature, or create one if the shipped
   work did not have an issue yet.
5. If the change is technical / architectural, link the relevant doc under
   `documents/docs/` from the entry.
6. Bump the `updated:` field in the frontmatter to the release date.
7. If you remove a feature, mark it *(deprecated)* in place for at least one
   release before deleting the entry.

This document is the **canonical** answer to "what does OpenAgentd do?". Slides,
README copy, comparison docs, marketing posts, and investor decks should all
trace their claims back to a line here.
