---
title: Features
description: Canonical, version-cited catalogue of shipped user-visible OpenAgentd features.
status: stable
updated: 2026-08-03
---

# Features

The canonical source of truth for shipped user-visible capabilities. Every feature lists the
release that introduced it (where known). When you ship something new, **add it here first** — README and external copy should cite this page.

> **Headline.** OpenAgentd is the desktop cockpit for local AI agents — a
> double-clickable app that runs a team of AI agents on your machine, with a
> real UI to watch every step. Open source (Apache 2.0). 16 providers. Your keys.

**Latest release:** v1.126.0 · August 3, 2026 · [release notes](https://github.com/lthoangg/openagentd/releases/tag/v1.126.0)

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

The product's primary surface. A native double-click app on macOS, Windows,
and Linux that hosts the same FastAPI sidecar + React UI you would otherwise
run from the terminal.

- **Native desktop app for macOS, Windows, Linux** `[since v1.0; Windows restored v1.106.0]` — Tauri 2 shell,
  bundled Python sidecar, embedded Web UI, one process, no terminal required.
- **Explicit backend connection state** `[v1.68.0, v1.99.8, v1.113.0]` — desktop connection options
  are limited to the builtin sidecar and saved servers; no-backend dev windows
  show **Backend unreachable**, active server removal clears the current backend,
  the builtin row exposes **Stop** whenever the sidecar process is already
  running, and **Use builtin** starts + attaches the bundled backend when needed.
  If bundled startup exceeds 15 seconds, the native splash offers Retry, server
  selection, and backend-log-path copy actions instead of waiting indefinitely;
  native startup failures surface immediately, and Retry re-spawns the builtin
  backend without allowing duplicate sidecar processes `[v1.113.0]`.
- **Connection-ready screen warmup** `[v1.113.3]` — after either the bundled
  sidecar or an external server connects, the app preloads shared Cockpit and
  Coding data in the background so the first mode switch can render from cache.
  Packaged desktop launches also canonicalise the `index.html` entrypoint to Home
  instead of showing the client-side 404 screen.
- **In-app crash recovery** `[v1.113.0]` — an unexpected UI render failure opens
  a recovery screen with Reload and copyable error details instead of leaving a
  dead webview that must be force-quit.
- **In-app auto-updater** `[v1.22.0, v1.99.8, v1.115.1]` — bottom-right update card + Settings → About
  → Updates, cached downloads, install-and-restart, signed minisign payloads,
  GitHub release notes rendered inline. Desktop checks at startup and every 6
  hours, including on a foreground return once that interval is due; choosing
  Later suppresses the automatic reminder for the full 6-hour interval in the
  current app run; relaunching performs the normal startup check `[v1.115.1]`.
  Mobile leaves updates to its platform distribution channel.
  Earlier iterations: `[v1.18.0]`, `[v1.20.0]`, `[v1.21.0]`.
- **Native app notifications** `[v1.19.0]` — finished assistant turns and
  scheduled reminders in the desktop app, plus local native
  notifications in the remote-backend mobile shell `[v1.34.0]`. Clicking a
  desktop completion or reminder notification restores OpenAgentd and opens
  its linked Cockpit or Coding session `[v1.113.4]`. Per-session context
  (coding workspace name when available). Settings → Notifications to toggle
  or send a test. Notification sounds are handled by the operating system;
  OpenAgentd does not play an extra in-app sound. Background-process completion
  alerts are deprecated and no longer emitted by app clients.
- **Command palette** `[since v1.0, v1.61.0]` — `⌘P`/`Ctrl+P`. Search
  sessions, agents, files, slash commands, settings. Cleaner, faster with a
  tighter animation and a curated command set that drops low-value entries.
  Command and file search overlays use the compact warm-paper surface treatment
  across desktop and mobile `[v1.74.0]`.
- **Platform-aware keyboard shortcuts** `[v1.93.1]` — `⌘` on macOS, `Ctrl`
  elsewhere, applied consistently across in-app shortcuts, the Command
  Palette, and native Tauri menu accelerators. Session Settings moved to
  `⌘⇧A`/`Ctrl+Shift+A` to avoid clobbering Select All; view-mode cycling and
  session-list refresh lost their dedicated shortcuts (palette-only, low
  frequency).
- **Smooth close animations on UI components** `[v1.77.0]` — dropdown, tooltip,
  and popover now play a 100–150 ms exit animation (fade-out + zoom-out) before
  unmounting, matching the open transitions. Dialog and sheet retain their
  existing close animations. Tooltip gains a CSS arrow and correctly appears
  over disabled buttons via a transparent span wrapper.
- **In-app toasts pause on hover/focus** `[v1.101.0]` — the auto-dismiss timer
  for toast notifications now pauses while the pointer or keyboard focus is on
  the toast, resuming with the remaining time once it clears, so a toast can no
  longer disappear mid-read.
- **Keyboard-operable overlays and dropdowns** `[v1.125.0]` — select/menu
  dropdowns navigate with `ArrowUp`/`ArrowDown`/`Home`/`End` and commit with
  `Enter`/`Space`, announcing the active option via `aria-activedescendant`
  (focus stays on the trigger because the panel is portalled outside the modal
  focus trap). `Escape` now closes the innermost layer first, so dismissing an
  open list no longer closes the surrounding modal. Session Settings opens with
  focus in the model field instead of the close button.
- **Type-to-focus composer** `[v1.40.0]` — in cockpit and coding chat, start
  typing on the chat surface to expand/focus the composer and capture the first
  character without pressing `⌘I`/`Ctrl+I` first.
- **Developer-friendly word navigation in composer** `[v1.86.0]` *(deprecated — replaced by native browser word navigation; the custom interceptor that stopped at programming separators like `.`, `-`, `_` was removed so `Option + Arrow`/`Ctrl + Arrow` now follow each platform's standard word-jump semantics)*.
- **Native menu/tray shortcuts** `[v1.39.0, v1.93.1]` — menubar shortcuts for Home,
  Cockpit, Coding, Command Palette, Scheduled Tasks, Session Settings,
  key settings pages, updates, reload, config folder, and backend log; compact
  tray dropdown for status, quick navigation, reload, settings, and quit.
  Command Palette, Scheduled Tasks, and Session Settings accelerators now use
  `CmdOrCtrl` (Session Settings requires Shift) to match the in-app
  platform-aware shortcuts `[v1.93.1]`.
  - **Tray "Usage Limits" submenu** `[v1.92.0]` — the macOS tray polls
    `GET /api/settings/providers/usage-summary` (stale-while-revalidate
    backend cache; per-provider last-known-good fallback on transient
    failures) and lists live quota usage for every *connected* OAuth
    provider — both builtin and provider plugins that expose a `get_usage`
    hook under `{OPENAGENTD_CONFIG_DIR}/plugins/`. User-disconnected
    providers are excluded, and per-model limits are filtered to the
    user's visible-model selection (fuzzy id matching; conservative
    fallback keeps non-model-keyed quota windows). Opening the tray menu
    triggers an opportunistic refresh (rate-limited), with a relaxed
    10-minute background poll behind it. Providers with one limit render
    a single flat row; multi-limit providers group indented limit rows
    under a header carrying the worst limit's
    🟢/🟠/🔴 threshold glyph, percent used, and a relative reset countdown;
    providers needing reconnection or temporarily unreachable get their own
    row instead of silently disappearing, and a failed poll keeps the last
    numbers on screen with a "refresh failed" footer. Crossing the 90%
    critical threshold fires a one-shot native notification (re-armed when
    the quota resets) and badges the tray icon. "Refresh Usage Now" forces
    a live re-check past the cache; "Manage Providers…" deep-links into
    Settings → Providers. Each measurable row also carries a compact
    block-character meter (`████░░░░░░`) between the percent and reset
    countdown — a CodexBar-style bar rendered in plain text, since native
    tray `MenuItem`s can't host custom widgets `[v1.94.0]`.
  - **Settings → Providers usage panel redesign** `[v1.94.0]` — the
    per-provider "Usage" card in Settings → Providers (`UsagePanel.tsx`)
    was restyled after CodexBar's menu-bar popover: a bold label per limit
    window, a flat progress bar with a leading dot marker, `N% used ·
    Resets in Xh Ym` under each bar, a header strip showing "Updated Xm
    ago" plus the plan badge, and a dedicated rate-limit-reached banner.
    The same `ProviderUsageLimit` payload comes from
    `GET /api/settings/providers/{provider}/usage`; period-only billing data
    renders as neutral availability rather than an invented percentage or
    unlimited allowance `[v1.112.0]`.
- **Touch back/forward navigation** `[v1.53.1]` *(deprecated)* — desktop Tauri windows support
  edge swipes on touch/pen devices: right from the left edge goes back, left
  from the right edge goes forward, while editable fields and scroll-like
  vertical gestures are ignored.
- **Multiple desktop windows** `[v1.41.0]` — open additional cockpit windows from
  File → New Window, the tray menu, or `⌘/Ctrl+N`; windows share the bundled
  sidecar and desktop auth token, while each window can independently switch to
  a saved external server `[v1.47.0]`. New windows now inherit the active
  window's current backend selection instead of failing when the bundled sidecar
  is unavailable `[v1.64.1]`. View → Zoom In / Out / Reset now applies per
  desktop window instead of globally across all open windows `[v1.66.1]`. On
  macOS, each desktop window now updates its native title to the active coding
  workspace name or cockpit session title so the Dock window list distinguishes
  open windows `[v1.66.1]`. Fixed a bug where switching one window's CLI server
  could still redirect other open windows onto the same server: the backend
  now targets its "backend ready" notification at the switching window only,
  and the frontend listens for it on a per-window channel instead of the
  app-wide broadcast channel it was previously (incorrectly) using `[v1.99.1]`.
  - **Hold Command + click session to open in new window** `[v1.62.1, v1.64.1]` — in the desktop app, holding `Cmd` (macOS) or `Ctrl/Cmd` (Linux) and clicking a session in either sidebar opens that session directly in a new independent desktop window; failures now surface an in-app error toast instead of silently doing nothing.
- **Editable session titles** `[v1.27.0]` — double-click a session card or use its
  edit affordance in the sidebar to rename saved sessions.
- **Mode-scoped recent-session lists** `[v1.66.1]` — cockpit and coding sidebars
  now fetch their own session pages (`mode=normal` vs `mode=coding`) instead of
  sharing one mixed cache, preventing intermittent empty recent-session lists
  when prior conversations exist.
- **Slash commands** `[since v1.0]` — `/init`, `/continue`, `/compact`, `/undo`,
  `/redo`, plus user-defined commands.
  - **`/plan` slash command** `[v1.96.0]` — triggers a research-then-approve
    workflow: the agent investigates the problem space and proposes a step-by-step
    implementation plan, then waits for explicit approval before writing any code.
    Loaded via the `oad/plan` skill.
- **Bang shell commands** `[v1.39.0]` — start a message with `!` to run the
  remainder directly through the shell tool without a model turn; history stores
  the run as structured shell tool output. Stop terminates active direct and
  foreground shell process groups; acknowledged background PIDs remain managed
  through `bg`. Background waits are session-scoped and bounded to 30 seconds by
  default (300 seconds maximum), returning a still-running result without
  terminating the process `[v1.105.0]`. Background process lists, status, wait
  metadata, and final output render as compact structured cards with bounded
  scroll regions on mobile and desktop `[v1.113.0]`. Raw ANSI/CSI/OSC escape
  sequences (colors, cursor movement, hyperlinks) from color-forcing CLIs are
  stripped from foreground results, live streamed output, and background
  process buffers before reaching the LLM or the UI `[v1.120.0]`. Background
  starts return as soon as the process exits or its first output settles
  (previously a fixed 3-second wait); exited background processes stay
  inspectable via `bg` for ~10 minutes after `wait`/`stop`; every `bg` action
  and session interrupt stays bounded even when an orphaned child still holds
  the output pipe; foreground output memory is bounded, with oversized output
  streamed incrementally to a session spill file `[v1.120.1]`.
- **Drag-and-drop files into chat** `[since v1.0, v1.82.0]` — drag files (images, PDFs, text, etc.) anywhere onto the chat area (both cockpit and coding views) to show a drop overlay and attach them to the composer. Supports multi-file drops, file-type filtering, and cancellation.
- **Composer history navigation** `[v1.32.0]` — when the input is empty, `↑` / `↓`
  walks previous user prompts from the current chat plus local submissions.
- **Clickable URLs in user message bubbles** `[v1.77.0]` — plain-text URLs typed
  or pasted into a user message are rendered as tappable links; style matches
  agent response links.
- **Mermaid diagrams in agent responses** `[v1.121.0, v1.123.0]` — completed
  `mermaid` code fences render as responsive diagrams with Diagram and Code
  views. A fence now renders as soon as it closes while later response content
  is still streaming; unfinished and invalid diagrams retain readable source.
  Full-screen diagrams keep the chrome minimal while supporting keyboard,
  wheel/trackpad and pinch zoom, double-click/double-tap, and drag-to-pan;
  diagram text selection is disabled so gestures stay responsive.
- **Stream auto-stick restored after scroll-to-bottom on mobile** `[v1.77.0]` —
  tapping the scroll-to-bottom button no longer detaches the stream
  auto-follow; direction-based detach logic removed from `onScroll` (was
  indistinguishable from smooth-button animation on mobile); user intent is
  now detected via `onWheel` / `onTouchMove` only. `AgentPane` gains a
  `ResizeObserver` so content reflow (markdown, images, syntax highlight) also
  re-sticks correctly.
- **Mobile keyboard viewport guardrails** `[v1.99.1]` — virtual-keyboard detection now uses the pre-keyboard layout height, the mobile shell stays pinned instead of following `visualViewport.offsetTop`, and chat auto-stick ignores keyboard-only scrollport resizes so manual transcript scrolling no longer flickers on iOS/WebViews.
- **Tool-call inspector** `[since v1.0]` — every tool call expands to show
  arguments, status, results, and inline Git-like diffs for file edits. Read
  results and file-change diffs keep line numbers visible while scrolling
  horizontally. Long read-result lines wrap safely without forcing horizontal
  page overflow, and diff/read cards clip cleanly inside rounded warm-paper
  containers `[v1.74.0]`.
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
  folders render orange. Mentioned files inject inline hidden context on the
  turn without becoming uploads; mentioned folders inject a lightweight `ls`-
  style listing without becoming uploads. In coding sessions,
  clicked file mentions in sent user messages open that file in the workspace
  files sidebar. Caps at 20 mentions / 20 MB / ~32k chars per turn. Persists
  on queued messages.
- **Multi-type file lightbox** `[since v1.0, v1.92.0, v1.99.8, v1.123.0]` — click any
  generated or attached file to open `FileLightbox`, a full-screen gallery
  covering images, video, audio, PDFs, text, and generic file types in one modal.
  Images support 50%-400% zoom through keyboard, wheel/trackpad, pinch, and
  double-click/double-tap gestures, plus drag-to-pan and swipe-to-close without persistent
  zoom chrome or selectable overlay text; keyboard/swipe navigation moves
  between attachments, and
  `AttachmentStrip` unifies the previous separate image/file card render paths.
  PDF documents render the first two pages immediately, then
  rasterize later pages near the viewport with stable page geometry and bounded
  device-pixel ratio. Multi-file paste into the composer now attaches every
  pasted file instead of only the last one `[v1.92.0]`.
- **Unified download architecture** `[v1.92.0]` — FileLightbox, workspace
  downloads, and coding-workspace downloads share one download path instead of
  three duplicated blob-to-base64 implementations; iOS downloads now present a
  native `UIActivityViewController` share sheet instead of silently failing.
- **Workspace files panel** `[since v1.0, v1.92.0, v1.93.1]` — every file the agent reads,
  writes, or generates appears in the left drawer as a recursive, VSCode-style
  collapsible file tree with folder chevrons, depth indentation, and
  material-icon-theme file/folder icons `[v1.92.0]`. Click to preview or
  download; desktop downloads use a native save dialog instead of navigating
  away from the app `[v1.52.0]`. Image and video previews in the coding
  workspace panel now open in the shared full-screen lightbox on click
  `[v1.93.1]`.
- **Header context meter** `[v1.53.0]` — desktop and mobile chat headers show an
  icon-sized input-token progress ring against the backend's model-aware
  summarization trigger; hover, focus, or tap/click reveals input/output/cache
  details and the estimated USD used across the active session `[v1.107.0]`; the estimate sums provider-reported input, output, and cache-read usage at the active model's registry rates, so compaction never reduces previously incurred spend.
- **Todos panel** `[since v1.0]` — task board with a topbar progress badge
  `<finished>/<total>` `[v1.17.0]`. Live invalidation.
- **Mobile / phone-first layout** `[since v1.0]` — breakpoints, safe areas, drawer
  shapes, composer keyboard avoidance, touch row actions, pull-to-refresh,
  haptics, and legibility guards optimized for small screens `[v1.45.2]`;
  long-press rows get native impact haptics (`tauri-plugin-haptics`) and an
  iOS-style press-and-hold scale animation `[v1.47.0]`.
- **macOS overlay + Tauri drag region** `[since v1.0]` — the header doubles as the
  window drag region; macOS gets the proper traffic-light overlay.
- **Restored desktop window size** `[v1.52.0]` — desktop windows reopen at the
  last normal size saved on quit, while minimized/maximized dimensions are ignored.
- **Remote-backend mobile shell** `[v1.34.0, v1.106.0]` — Tauri mobile app scaffold embeds
  the shared Web UI and connects to saved remote API servers. Foreground resume
  now reconciles missed history and replaces potentially frozen chat streams;
  remembered-server launches prefetch and reuse native credentials.
- **LAN access key for external clients** `[v1.43.0, v1.103.0]` — `openagentd start --lan --key`
  stores the CLI server's bind address, port, and bearer key in `server.yaml`, separate from the desktop builtin sidecar's ephemeral token while agents, providers, sessions, and other settings remain shared. Restart and upgrade preserve that key without exposing it in process arguments. OpenAgentd-managed launchers refuse non-loopback binds without a configured key `[v1.101.0]`.
- **Desktop server connection manager** `[v1.43.4, v1.99.8, v1.104.0]` — the desktop **Server connection** dialog switches the current window between the builtin sidecar and saved external servers, normalizes pasted `/api` URLs, and preserves other open windows' backend choices. Typed servers now require a successful health and access-key test before they can be named, saved, and connected. Saved LAN access keys are scoped per backend origin and stored in the native OS credential store on installed desktop/mobile shells; browser development keeps the per-origin localStorage fallback. Remembered external servers reconnect on app launch with sidecar fallback, while the desktop window opens immediately as backend startup continues asynchronously `[v1.57.1]`.
  - **Reload after switching backend servers** `[v1.98.1]` — after connecting a desktop window to a different saved or typed external server, the webview reloads so stale frontend state is discarded and the window comes back against the newly selected backend cleanly. Reconnecting to the already active backend does not reload.

---

## 2. Agents and teams

OpenAgentd is multi-agent by default. A lead agent drives the conversation and
spawns specialist members on demand.

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
  command palette and assistant footer. Continuations use the session's model
  and reasoning settings.
- **Automatic empty-after-tool recovery** `[v1.36.0]` — if a provider returns
  an empty assistant response immediately after a tool result, the lead keeps
  the same turn moving instead of silently ending after the tool call.
- **Provider-timeout resume for long tasks** `[v1.37.0]` — when a slow or flaky
  model endpoint exhausts its retry budget mid-task (`ReadTimeout` /
  `ConnectError`), the loop resumes the same turn from where it left off
  instead of dropping the agent after a tool call. Bounded and interrupt-aware.
- **Automatic max-tokens truncation recovery** `[v1.87.0]` — when a provider
  hits the output token limit (`finish_reason="max_tokens"` or `"length"`), the
  loop automatically injects a recovery message (requesting a continuation for
  text, or advising surgical/smaller steps for truncated/malformed tool calls)
  and continues the turn instead of stopping mid-process.
- **Queued follow-up messages** `[v1.12.0, v1.14.0]` — send another message
  while the agent is still replying; it's queued and dispatched in order. Long
  queued messages are collapsible while a response runs `[v1.22.0]`. Queued
  messages now splice into the running turn at the next LLM-step boundary
  (not mid-tool-call), so the agent sees them on the very next iteration
  instead of waiting for the current turn to finish `[v1.25.0]`. File
  attachments queue too: attaching files while the agent is replying no longer
  errors — the queued bubble lists the filenames, and cancelling the queued
  message restores both text and files into the composer `[v1.113.0]`.
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
- **Stop cancels the whole active session run** `[v1.101.1]` — Stop directly
  cancels the lead and working members, in-flight model/tool work, direct shell
  commands, and session-owned background shell processes before the request
  returns. Queued and late mailbox work cannot restart the stopped turn.
- **Stop pauses queued follow-ups instead of dropping them** `[v1.17.0]` — Stop
  releases queued hidden user messages into visible history so you can
  `/undo`, edit, or append before resuming.
- **Session-level model + thinking-level override** `[v1.16.0, v1.66.1, v1.79.0, v1.104.3, v1.125.0]` — override the
  lead agent's model and thinking level for the current chat. The thinking
  picker uses each model's advertised reasoning levels when registry metadata is
  available, and history keeps the model used for each user turn. Codex keeps
  the configured thinking level across provider reconstruction and streams
  readable reasoning summaries on supported models.
  Selections apply immediately (no Apply step) and `Use agent default` clears the
  override; a half-typed or emptied model field is never committed `[v1.125.0]`.
- **Coding team variant** `[since v1.0]` — `agents/coding/` ships a separate
  compact team (`coding/openagentd`, `coding/coder`, `coding/explorer`) tuned for
  workspace-aware sessions; the coding explorer focuses on inspecting the current
  codebase before implementation.
- **Built-in first-party agent profiles** `[v1.23.0, v1.118.0]` — the default `openagentd`
  lead and shipped member blueprints keep their core prompts, tools, and
  descriptions versioned in code for normal and coding modes; generated/user
  `.md` files remain lightweight extension points for model knobs, extra
  capabilities, and extra prompt text.
- **Automatic first-run materialization** `[v1.37.0, v1.118.0]` — application
  startup creates missing first-party agent profiles and editable runtime
  configuration directly from code. No separate initialization command or
  downloaded template bundle is required, and existing user files are preserved.

---

## 3. The coding workspace

Coding mode (`/coding`) opens a local project folder and runs a workspace-aware
team against it.

- **Open any local project folder** `[since v1.0]` — server-local paths only.
  Coding mode shows file tree + live git diff (staged, unstaged, and untracked
  files) in
  the side drawer. Desktop uses the native folder picker only for the bundled
  sidecar or loopback backends; LAN/external backends use the web folder browser
  so the selected path exists on the backend host.
- **Git worktree sessions** `[v1.41.0, v1.61.0]` — create an isolated git worktree
  from an existing coding workspace, start a new coding session in that worktree,
  list existing worktrees, edit sidebar titles without renaming git directories,
  and remove OpenAgentd-managed worktrees. Removing a worktree asks for confirmation
  first, warning that uncommitted changes will be lost `[v1.101.0]`.
- **Warm-paper cockpit refresh** `[v1.74.0]` — coding panels, chat-adjacent
  surfaces, scheduled tasks, telemetry, home, provider/settings detail views,
  command/file search, and input attachments now share the custom warm-paper
  visual system: compact controls, crisp 1px borders, muted text hierarchy,
  mobile-safe overlays, and balanced secondary actions.
- **Coding workspace dock** `[v1.61.0]` — right-side dock panel for coding
  sessions with a permanent Changes tab showing staged/unstaged diff hunks with
  context lines and expand/collapse rows and status badges, file tabs for read-only
  current-file previews with line numbers and syntax highlighting, and a
  file-search overlay. File search is full-viewport on desktop and centered
  inside the safe-area-aware workspace panel on mobile. File selection persists
  across dock close/reopen; clicking inline `@file` mentions opens the
  referenced file in the dock. Dock, sidebar, and viewer widths are
  independently resizable via drag handles on desktop.
  - **Git Commits & Commit Tree in workspace dock** `[v1.70.2]` — additional sub-tabs inside the "Changes" panel to see recent git commits and a visual branch graph. The commits list supports high-performance cursor-based infinite scrolling (fetching more commits on scroll using a native `IntersectionObserver`) and inline expansion to view the files modified in any commit and their interactive diff previews. The visual tree graph renders the textual `git log --graph` output with branch splits, merges, and an "All Branches" toggle. **Workspace Git UI state (including the selected sub-tab, All Branches toggle, expanded commits, and expanded file diffs) is persisted in the local browser state, maintaining your context across dock toggles and workspace switches** `[v1.73.0]`.
    - **Git Commit Actions (Undo & Revert)** `[v1.88.0]` — right-clicking a commit/file on desktop opens a native-feeling context menu at the cursor, while long-pressing on mobile opens a touch-friendly action sheet. Allows you to **Undo commit** (soft-resets the last commit, keeping all changes staged in your working copy) or **Revert commit** (creates a new commit that reverts the changes of the selected commit, with auto-abort protection if conflicts occur), and confirmation dialogs use responsive side-by-side buttons on desktop.
    - **Time shown alongside date in commit history** `[v1.92.0]` — the commits
      sub-tab shows a 24-hour `HH:MM` alongside the date so same-day commits
      are distinguishable without expanding each one.
    - **Ahead/behind origin badges in the Commits sub-tab** `[v1.98.1]` — the
      workspace dock now shows both local commits waiting to push (`↑`) and
      remote commits waiting to pull (`↓`) next to **Commits** when the current
      branch tracks an upstream. When no upstream is configured, both badges are
      omitted.
- **Compact coding sidebar** `[v1.61.0]` — single-line session entries with
  status dots and tooltip dates; flattened repository/worktree/session hierarchy
  without nested group labels; session context menu / action sheet options include editing title
  and deleting session `[v1.117.0]`; repository/worktree context menu / action sheet includes
  copying the repo or worktree's absolute path `[v1.120.0]`; scroll-triggered pagination replaces
  the Load more button.
- **Changed-file highlights in the workspace tree** `[v1.30.0]` — modified and
  untracked files are marked directly in the Files tab, parent folders show a
  changed-state indicator, and the tab badge reports the changed-file count.
- **Two-layer workspace file viewer** `[v1.29.0]` — clicking a file in the coding
  workspace side drawer opens a read-only viewer beside it with line numbers,
  lightweight syntax highlighting, image previews, inline HTML5 video previews `[v1.90.0]`,
  extensionless text files, and binary download fallback. Copy and download
  buttons sit in the file tab header for one-click copy of the full content or
  download of the file `[v1.92.0]`.
  Select lines and click **Add comment** to insert an `@path#Lx-Ly` composer
  reference; the backend auto-attaches only the selected file lines.
- **Open file from git changes on mobile and desktop** `[v1.92.0]` — right-click
  (desktop) or long-press (mobile) a changed file inside the Changes tab or a
  commit's detail view to open, copy, or otherwise act on that file, including
  deleted files, which render a dedicated deleted-file view in the editor panel.
- **Persisted coding sessions per workspace** `[v1.18.0]` — `/coding/{session_id}`
  restores workspace context from the saved session. Bare `/coding` is the
  launcher or last-workspace restore. New empty sessions exist before the
  first message.
- **Workspace sidebar pagination** `[v1.18.0]` — each main/worktree list shows
  roughly 5 sessions and loads more when scrolled to the bottom, so one busy
  workspace doesn't crowd the others.
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
  with multiple hunks, real line numbers, collapsible previews. The `patch`
  tool accepts a `*** Begin Patch` / `*** End Patch` envelope with
  `*** Add File:`, `*** Update File:`, `*** Delete File:`, and `*** Move to:`
  operations; the full format spec is embedded in the tool's schema so the
  LLM always has it in context. Hardened against LLM formatting variance:
  accepts alternate parameter names, extracts envelopes embedded in markdown
  code blocks or surrounding commentary, and falls back to line-aligned fuzzy
  context matching when whitespace doesn't match exactly, without
  mis-patching an earlier occurrence of the same text or rewriting file line
  endings `[v1.120.0]`. The activity header lists the comma-separated,
  deduplicated basenames of every touched file instead of collapsing
  multi-file patches into a bare count `[v1.120.0]`.
- **Interactive terminal tab** `[v1.98.1]` — a real PTY shell (backend
  `subprocess.Popen` + `pty.openpty()`, streamed over WebSocket to an
  xterm.js instance) attached to the coding workspace panel, alongside
  Changes/Commits/file tabs. Coding-mode only — there is no cockpit-mode
  terminal. The session survives tab switches (detached PTYs idle-close
  after 15 minutes of no input; the backend reaper is the 30-minute
  backstop). Includes PTY output backpressure, GPU-accelerated WebGL rendering `[v1.118.0]`,
  debounced SIGWINCH resizing, and mobile key bar ergonomics (touch-and-hold arrow repeat,
  soft-keyboard focus preservation, quick symbol row).
  Terminal font defaults to a best-guess Nerd Font stack
  (MesloLGS NF and similar) for correct Powerlevel10k/Starship glyph
  rendering; Settings → Terminal lets you type the exact name and font size (9–24px) `[v1.118.0]`
  of any font installed on your machine and verifies it resolves via the Font Loading API
  before applying it live to every open terminal.
- **Workspace status card** `[v1.18.0]` — empty coding sessions show the
  workspace path, branch, dirty state, last commit instead of the old
  agent-selection fallback.
- **Sessions ≥ 100 messages load completely with scroll preserved** `[v1.9.0]`.

---

## 4. Memory and context

OpenAgentd carries context across sessions via rolling-window summarization.

- **`/compact` rolling-window summarization** `[v1.5.0]` — compresses old turns
  into a single summary message kept in context; UI shows the unabridged
  conversation. Preserves reasoning and loaded skill/tool context; skill
  instruction tool-call pairs remain active after repeated compaction while the
  summarizer keeps the same cacheable prompt prefix as normal chat turns.
- **`AGENTS.md` at repo root and subfolders** `[v1.9.0]` — written by `/init`;
  standard repo- and folder-scoped agent context files. Coding workspaces fall
  back to root `CLAUDE.md` when root `AGENTS.md` is absent.
- **Per-message provider metadata** `[v1.17.0]` — assistant messages persist
  the model that generated each reply (visible in inspector).

---

## 5. Providers and models

Switch providers with one line in your agent config. The product is provider-
agnostic by design.

**18 first-class providers:**

| Provider | Config syntax | Auth |
|---|---|---|
| Anthropic Claude | `anthropic:claude-sonnet-4-6` | `ANTHROPIC_API_KEY` `[v1.14.0]` |
| Google Gemini | `googlegenai:gemini-3.1-flash` | `GOOGLE_API_KEY` |
| Google Vertex AI | `vertexai:gemini-3-flash-preview` | `VERTEXAI_API_KEY` or GCP creds |
| OpenAI | `openai:gpt-5.5` | `OPENAI_API_KEY` |
| OpenCode Zen | `opencode:deepseek-v4-flash-free` | none for free models; `OPENCODE_ZEN_API_KEY` for paid models `[v1.124.0]` |
| OpenCode Go | `opencode-go:deepseek-v4-flash` | `OPENCODE_GO_API_KEY` `[v1.124.0]` |
| OpenRouter | `openrouter:qwen/qwen3.6-plus:free` | `OPENROUTER_API_KEY` |
| ZAI / GLM | `zai:glm-5-turbo` | `ZAI_API_KEY` |
| xAI Grok | `xai:grok-4.20` | `XAI_API_KEY` |
| Grok Build | `grok:grok-4.5` | `openagentd auth grok` `[v1.112.0]` |
| DeepSeek | `deepseek:deepseek-v4-flash` | `DEEPSEEK_API_KEY` |
| AWS Bedrock | `bedrock:anthropic.claude-sonnet-4-6` | Bedrock Mantle bearer token (`AWS_BEARER_TOKEN_BEDROCK`) or AWS profile/default credential chain `[v1.110.0]` |
| NVIDIA NIM | `nvidia:stepfun-ai/step-3.5-flash` | `NVIDIA_API_KEY` |
| GitHub Copilot (OAuth) | `copilot:gpt-4.1` | `openagentd auth copilot` |
| OpenAI Codex (OAuth) | `codex:gpt-5.5` | `openagentd auth codex` |
| Router9 (local) | `router9:cc/claude-sonnet-4-5` | `ROUTER9_API_KEY` (optional) |
| CLIProxyAPI (local) | `cliproxy:gemini-2.5-pro` | `CLIPROXY_API_KEY` (optional) |
| Ollama (local + cloud) | `ollama:llama3.2` · `ollama:kimi-k2.6-cloud` | none (cloud: `ollama signin`) |

- **Keyless first-run model** `[v1.124.0]` — new installations start with
  `opencode:deepseek-v4-flash-free` across the built-in agent team, while
  existing agent model choices remain unchanged.
- **Drop-in provider plugins** `[v1.6.0]` — Python files in the configured
  plugins directory register new providers at startup.
- **Resilient provider construction** `[v1.17.0]` — missing/unavailable
  providers no longer block startup; an unconfigured stub surfaces an
  actionable UI error on first use.
- **Chat-completions-only compatible routing** `[v1.44.3]` — OpenAI-compatible
  providers that do not expose OpenAI's Responses API stay on `/v1/chat/completions`
  even when session or agent thinking settings are enabled.
- **AWS Bedrock Mantle-only routing** `[v1.110.0]` — Bedrock models use Mantle's
  Anthropic- or OpenAI-compatible route metadata and bearer-token auth; native
  Converse and the access-key/secret-key Settings path were removed. This is an
  explicit user-approved hard conversion, so it did not follow the normal
  feature deprecation period.
- **Anthropic-compatible custom endpoints** `[v1.16.0]` — providers needing
  custom headers or alternate message endpoints are supported.
- **Anthropic prompt caching + full input accounting** `[v1.66.0]` — Claude
  requests now place explicit `cache_control: {type: "ephemeral"}` markers on
  the system block and latest cacheable turn block, matching Anthropic's
  breakpoint model instead of marking every block. Stored/model usage now counts
  total prompt input as cold + cache-read + cache-write tokens while preserving
  cached reads as a separate metric.
- **Budget-based thinking metadata synthesis** `[v1.83.0]` — models whose
  registry metadata exposes raw `budget_tokens` reasoning support but no named
  effort levels now surface standard `none/low/medium/high` thinking choices in
  Settings, with Anthropic runtime mapping those levels to proportional token
  budgets.
- **`openagentd://` deep links and OAuth callback handoff** `[v1.116.0]` — system protocol registration for desktop and mobile apps, with cold- and warm-start routing. Navigation links (`openagentd://cockpit/...`, `openagentd://coding/...`) open the requested session. OAuth providers that implement a callback exchange can use `openagentd://auth/callback?provider=...&code=...`; OpenAgentd validates the link shape and forwards the opaque callback payload to the active backend, while the provider remains responsible for state and PKCE verification. Isolated desktop development bundles and physical-device iOS development builds use `openagentd-dev://` so they do not claim the production protocol.
- **OAuth subscription support** `[v1.8.0]` — Copilot, Codex, others via the
  built-in OAuth helper.
- **Grok Build subscription provider** `[v1.112.0]` — `grok:` uses xAI's
  device OAuth flow and refreshable session credentials independently of the
  direct API-key-backed `xai:` provider, with live model discovery and the
  Grok Build proxy's required model-routing headers. Grok billing usage is
  available in Settings, the native usage tray, and the manual provider smoke
  script; billing periods with no measurable allowance stay period-only and
  zero values are not treated as unlimited.
- **Codex usage monitor** `[v1.32.0]` — Settings → Providers shows live Codex
  OAuth usage windows, resets, credits, unlimited plans, and spend-cap/limit states.
- **Priority / Fast mode** `[v1.90.0, v1.92.0]` *(deprecated)* — opt new messages into Fast/Priority mode. Supported on models and providers that implement service/latency tiers (Anthropic maps to `auto`, Google Gemini maps to `priority`, OpenAI maps to `auto`, and ChatGPT Codex maps to `priority`). Availability is driven by a `supports_fast_mode` registry flag instead of a hard-coded provider-prefix list, so plugin providers can opt in without frontend changes `[v1.92.0]`. The web Session Settings control was removed in `v1.125.0`; the session field, API parameter, and provider mapping still work, so sessions that set it elsewhere (TUI, API) are unaffected.
- **Disconnect a provider** `[v1.92.0]` — Settings → Providers lets you
  temporarily disconnect a configured provider; its models disappear from
  every picker and the warm-cache loop skips it, while saved credentials stay
  on disk and a single click reconnects it.
- **Copilot usage monitor** `[v1.33.0]` — Settings → Providers shows live Copilot
  premium request quota from the saved OAuth token.
- **Provider plugin usage hooks** `[v1.33.0]` — OAuth provider plugins can
  surface live usage in the same Settings → Providers panel as built-ins.
- **Provider-scoped visible models** `[v1.57.0, v1.63.0]` — Settings → Providers lets
  users choose which provider models appear in normal model pickers. Session
  settings and other pickers read a cached provider model list for instant
  open; when the cache is empty, `/api/agents/registry` warms configured
  providers' caches on demand, and **List models** remains the per-provider
  manual refresh / verification action. The providers page now includes a
  search plus status/kind filter bar for quickly narrowing long provider lists
  `[v1.74.0]`.
- **Curated multimodal model registry** `[v1.34.0]` — model modality gates,
  token limits, cost, support flags, and thinking-level metadata are maintained
  in one exact-match registry: runtime `models.dev` cache, explicit compatibility
  aliases for runtime provider/model IDs that differ from the upstream source
  IDs, and an optional local YAML overlay.

---

## 6. Built-in tools

Tools the agent can call without any extra configuration. Add more via skills or
MCP.

| Category | Tools |
|---|---|
| Filesystem | `read`, `write`, `edit`, `patch`, `ls`, `glob`, `grep`, `rm` |
| Shell | `shell`, `bg` (background processes) |
| Web | `web_search`, `web_fetch` |
| Generation | `generate_image`, `generate_video` |
| Scheduling | `schedule_task` (reminders + self-scheduling agentic loops) `[v1.70.0]` |
| Tasks | `todo_manage` |
| Team coordination | `team_message`, `team_manage` |
| Utility | `date`, `skill` |

- **Real-time LSP diagnostics injection** `[v1.89.0, v1.105.0]` — in **coding mode**, after a
  `write`, `edit`, or `patch` tool modifies one or more files, OpenAgentd runs the
  matching language server(s) over the changed files and injects the resulting
  errors/warnings straight into the tool result as a compact `[LSP Diagnostics]`
  block, so the agent sees and fixes problems on the very next turn. Servers run
  **on demand** (spawned lazily per project+language, reused warm, reaped after
  ~5 min idle) and are **matched to the project's own toolchain**: detection reads
  `pyproject.toml` / `Cargo.toml` / `package.json`, so a repo that pins `ty` + `ruff`
  gets exactly those. Resolution precedence is **project config → `settings.yaml`
  (`lsp:`) → built-in defaults**. Python is special-cased to run *multiple*
  complementary servers and merge results — a type checker (`ty`/`pyright`) **and**
  a linter (`ruff`) — because neither alone catches both type errors and lint;
  every other language uses its single canonical server (`gopls`,
  `typescript-language-server`, `clangd`). Multi-file `patch` checks run
  concurrently, the report is capped per file (errors first, then a `…and N more`
  summary) to protect the context window, and the whole hook is fail-safe — an LSP
  error never crashes the tool. The cockpit renders the block as a compact,
  color-coded `ERR`/`WARN` strip beneath the diff. Diagnostics depend on the server
  being available and on normal LSP scope rules (e.g. TypeScript honours `tsconfig.json`).
  Pinned `ty` + `ruff` now ship with the Python runtime, while TypeScript is a
  consented, on-demand backend component with a verified Bun download, locked
  npm packages, a cross-surface install prompt, and `openagentd lsp` status/install
  commands. Managed tools live under the regeneratable cache and do not modify
  the user's project.
- **Clean tool argument validation errors** `[v1.77.0]` — when a tool call
  fails Pydantic validation, the LLM receives a compact `field: message`
  summary instead of the full Pydantic noise (type codes, raw input value,
  docs URL). Errors with multiple fields are joined with `; `; nested field
  paths use ` -> ` separators.
- **Gemini zero-argument tool calls no longer crash** `[v1.77.0]` — Gemini
  omits the `args` key entirely for tools that take no arguments; the schema
  now defaults `FunctionCall.args` to `{}` so the response parses correctly
  on both streaming and non-streaming paths.
- **Cross-tool `tool_output_delta` streaming** `[since v1.0]` — long-running
  tools (shell, web search) stream output to the inspector as they run.
  - **Live output trimmed to the rendered window** `[v1.120.3]` — each delta now
    carries only the trailing lines the inspector actually paints instead of up
    to 24 KB per flush. A noisy command (`bun test`, builds) previously streamed
    ~87% bytes that the client discarded on arrival, costing SSE bandwidth plus
    an immer transaction and React re-render per frame on desktop and mobile.
    Full output still reaches the model and the user in the final tool result.
- **Rich inline ToolCall rendering & scroll guardrails** `[since v1.0, v1.72.0]` — compact tool summaries and status lines, sticky headers for diffs, and automatic scroll/truncation boundaries for extremely large outputs.
  - **Tool arguments max-height and recursive JSON formatting** `[v1.72.0]` — tool arguments now respect a compact 10-line max-height scrollable container and recursively parse stringified JSON properties into pretty-printed formatting for optimal readability.
- **Tool result offload** `[since v1.0]` — bulky tool outputs (large file
  reads, shell spills) move to `{OPENAGENTD_DATA_DIR}/sessions/{id}/.tool_results/` and the inspector
  links to them.
- **`.gitignore`-aware file tools** `[v1.20.1]` — `glob`, `grep`, and workspace
  file browsing respect `.gitignore` and skip generated directories.

---

## 7. Extension surface

Four orthogonal ways to add capability.

- **MCP servers** `[since v1.0]` — any Model Context Protocol server, hot-reloaded
  via `POST /api/mcp/apply`. Per-agent scoping. OAuth-backed setup. Session Settings
  can enable/disable scoped MCP servers and connect OAuth-backed servers in place `[v1.52.2]`.
  Each scoped server gets its own row showing connection state and tool count, with a
  toggle and an OAuth connect/reconnect action; the list re-polls while a server is
  starting so a freshly enabled server settles to ready in view `[v1.125.0]`.
  OAuth setup permits empty client ID and secret fields so servers that support
  dynamic client registration can complete setup without app credentials; issuer
  discovery also tolerates a sole trailing-slash difference at the origin root `[v1.124.0]`.
  - **`$VAR` / `${VAR}` expansion in stdio server env** `[v1.122.0]` — stdio MCP
    server `env` entries in `mcp.json` now resolve environment/`.env`-style
    references the same way header values already did, so secrets can be
    referenced instead of written in plain text.
  - **Markdown-rendered tool descriptions in Session Settings** `[v1.96.0]` —
    tool descriptions in the Session Settings tools panel now render as structured
    markdown (bullet lists, inline code, bold/italic, paragraph breaks) instead of
    a plain-text wall. MCP servers that include formatted descriptions in their tool
    schemas benefit automatically; plain-text descriptions render identically to before.
    The tool inventory is grouped by origin (built-in, then one group per MCP server)
    and collapsed by default so it no longer pushes the model and MCP controls out of
    view; the name/description filter appears past eight tools `[v1.125.0]`.
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
  in place `[v1.27.x]`. The bundled `browser-use` skill for CLI-driven browser
  automation is *(deprecated)* `[v1.43.4]`.
  - **Reference files and scripts support** `[v1.87.0, v1.92.0]` — fully compatible with the
    `agentskills.io` specification. Resolves `{SKILL_DIR}` and `${SKILL_DIR}` placeholders
    inside loaded skill instructions. Project-level skill directories resolve to clean relative
    paths (e.g. `.openagentd/skills/my-skill`), while global/bundled skill directories resolve
    to absolute paths, allowing the agent to use standard `read` and `shell` tools to access them.
    `load_skill` now always prepends a `Skill directory: <path>` line to its response so the
    agent finds bundled reference files without relying on the author adding `{SKILL_DIR}`
    tokens `[v1.92.0]`. Skill cache invalidation now also watches project-local skill roots
    (`.openagentd/skills/`, `.opencode/skills/`), not just the global config directory, so
    edits are picked up on the next `discover_skills()` call `[v1.92.0]`.
  - **Semantic docs search skill experiment** `[v1.98.0]` *(beta)* — project workspaces can ship
    an `oad/search-doc` skill plus a turbovec-based document-search experiment for semantic lookup
    over `documents/`, giving agents a higher-level alternative to exact-string grep when docs
    queries are conceptual or paraphrased.
- **Plugins** `[v1.6.0]` — Python files dropped into `OPENAGENTD_PLUGINS_DIRS`.
  Register `@plugin` functions or `Plugin(BaseAgentHook)` classes with
  `tool.before` / `tool.after` / agent lifecycle hooks. Per `(agent, role)` filter.
  - **RTK shell rewriting** `[v1.118.0]` — optional `plugins/rtk_rewrite.py`
    plugin routes foreground `shell` commands through an installed `rtk` CLI to
    reduce tool-output token usage, with pass-through on missing or failed rewrites.
  - **Secret scrubbing** `[v1.118.0]` — optional `plugins/secret_scrubber.py`
    plugin redacts common credential formats and sensitive environment values from
    tool results before they enter model context.
- **Slash commands** `[since v1.0]` — `.md` files with optional frontmatter,
  available globally or scoped to a coding workspace (`[v1.17.0]`). One nested
  namespace level is supported and displayed in the composer as colon syntax
  (`/git:commit`) `[v1.27.x]`.
- **Self-healing skill** `[v1.14.0]` — agent edits its own `.md` config (model,
  tools, MCP) and the runtime picks up the change at end-of-turn.

---

## 8. Sandbox and permissions

Single-user trust model. The host is trusted. The operator is the user.

- **Path denylist** `[since v1.0]` — absolute paths anywhere on disk are accepted
  *unless* they resolve under a denied root (`OPENAGENTD_DATA_DIR`,
  `OPENAGENTD_STATE_DIR`, `OPENAGENTD_CACHE_DIR`) or match a user-defined glob
  in `sandbox.yaml`. User-defined sandbox globs are enforced inside the active
  workspace too, not only outside it `[v1.74.0]`. Symlinks are rejected only
  when targeting a denied root. Tilde paths are always rejected.
- **Self-diagnostic carve-outs** `[v1.120.4]` — agents can read their own
  runtime diagnostics inside the denied state root: `{STATE_DIR}/logs`,
  `{STATE_DIR}/otel` (span/metric rollups), and `{STATE_DIR}/telemetry`
  (per-turn context-window dumps), plus the current session's own artifact dir.
  Credentials (`OPENAGENTD_CACHE_DIR`), the SQLite DB, undo/redo snapshots, and
  other sessions' artifacts stay denied. This is what makes the
  `oad/debug-prod` log/telemetry workflow usable without disabling the sandbox.
- **Permission system: allow / deny / ask** `[since v1.0]` — wildcard rule
  matching per tool. Auto-allow, blocking on user reply, or persistent rules.
- **Shell command pre-scan** `[since v1.0]` — best-effort path-token scan
  inside shell commands.

---

## 9. Observability

Everything stays local. No third-party telemetry SaaS.

- **Built-in telemetry dashboard** `[since v1.0]` — `/telemetry` route in the web
  UI. Focused usage/cost cards, cache hit/miss by step and provider:model,
  scroll-paginated traces, and trace waterfall details.
- **OpenTelemetry spans** `[since v1.0]` — `OpenTelemetryHook` emits spans for
  agent runs, model calls, tool calls. Optional OTLP exporter.
- **Estimated model-call cost telemetry** `[v1.34.0]` — chat, title-generation,
  and summarization spans include estimated USD cost when model-registry pricing
  and provider usage tokens are available.
- **Prompt budget report** `[v1.102.0]` — `make prompt-budget` reports exact
  `o200k_base` counts for the assembled static system prompt, compact tool-schema
  JSON, every first-party base prompt, each tool, and bundled skill bodies;
  `make prompt-budget-json` emits a stable machine-readable baseline for CI.
- **DuckDB-backed query API** `[since v1.0]` — `/api/observability/*` queries
  the local DuckDB span store.
- **Two-tier logging** `[since v1.0]` — app log at `{STATE_DIR}/logs/app/`,
  per-session JSONL transcript at `{STATE_DIR}/logs/sessions/{id}/`. Rotated,
  loguru-based.
- **Persistent reply/tool timing in UI** `[v1.21.0]` — assistant footers show
  full user-turn wall-clock duration; tool rows show individual execution time.
  Durations stay after a reload.
- **Delta turn reconciliation** `[v1.120.4]` — a completed turn transfers only
  the messages it produced (`GET /team/{id}/history?since=`) instead of
  re-downloading the whole visible page, which reaches ~1.7 MB on an active
  session and duplicates what the SSE stream just delivered. Falls back to a
  full page when the client has fallen too far behind. Session-list `running`
  badges, auto-generated titles, and the workspace file tree likewise update by
  in-place cache patching rather than refetching every loaded page.

---

## 10. Voice

Client-side speech recognition. OpenAgentd does not run backend microphone transcription.

- **Mic button in composer** `[since v1.0]` — click to start listening, click to
  stop. Transcript text is inserted into the chat input for review before sending.
- **Browser / OS speech recognition** `[v1.34.0]` — uses the current browser or
  app WebView speech recognizer when available. No `/api/speech/*` backend,
  `speech.yaml`, or bundled `faster-whisper`.

---

## 11. Distribution and updates

Desktop is primary. CLI / server is the developer path.

- **macOS desktop** `[since v1.0]` — Homebrew cask
  (`brew install --cask lthoangg/tap/openagentd`) or `.dmg` with bundled
  `install.sh` (ad-hoc signs locally).
- **Linux desktop** `[since v1.0]` — AppImage (`chmod +x`) or `.deb` for
  Debian/Ubuntu.
- **Windows desktop** `[v1.106.0]` — native x64 `.msi` installer with the
  bundled Python sidecar, WebView2 shell, Job Object process cleanup, native
  PowerShell/cmd shell execution, and signed in-app updates. Interactive PTY
  terminal tabs remain unavailable pending a ConPTY backend.
- **Windows one-command install** `[v1.107.0]` — the `install.ps1` PowerShell
  installer resolves the latest GitHub release, downloads its x64 MSI, rejects
  a non-MSI download before elevation, and invokes Windows Installer.
- **Signed update manifests** `[v1.2.2+]` — minisign-signed `latest.json` at the
  rolling `latest-desktop` release; verified before install.
- **In-app updater** `[v1.22.0]` — see [§1](#1-the-desktop-cockpit).
- **CLI install** `[since v1.0]` — `uv tool install openagentd`, `pipx`, `pip`,
  `brew install lthoangg/tap/openagentd`.
- **CLI server control** `[v1.41.0]` — `restart`, `address`, `health`, and
  `start --lan --key` make the CLI the control plane for desktop/mobile backends.
- **CLI start --wait / --watch** `[v1.73.0]` — starts the background server and polls `/api/health/ready` until the database connection and the agent team are fully ready.
- **CLI upgrade** `[v1.41.0]` — `openagentd upgrade` stops the background
  server, delegates to the detected package manager, then restarts it when it
  was running.
- **Docker** *(deprecated, removed in v1.23.0)* — the `Dockerfile`,
  `docker-compose.yaml`, and the `ghcr.io/lthoangg/openagentd` image are
  no longer maintained. Use the CLI install paths above; revisit if there
  is concrete self-hoster demand.
- **Migration imports** `[since v1.0]` — `openagentd migrate openclaw`,
  `migrate hermes`. Imports identity + context Markdown into one lead agent.
- **Server migration export/import** `[v1.97.0]` — `openagentd export` packs
  agents, skills, commands, plugins, and config files into a timestamped
  `.tar.gz` archive. `openagentd import <archive>` unpacks it on the target
  machine with fill-in-gaps merge (or `--force` to overwrite). API keys in
  `.env` are redacted by default; `--include-secrets` opts in for trusted
  channels. Imports resolve every destination inside the config root and reject
  traversal through pre-existing symlinks `[v1.103.0]`. DB and session
  workspaces are intentionally excluded.
- **Cross-platform single-instance** `[v1.13.0]` — opening the app twice
  focuses the existing window instead of launching a duplicate.
- **Desktop force reload respects backend mode** `[v1.68.0]` — external-server
  windows now do a frontend-only force reload without restarting the bundled
  sidecar, while bundled windows wait for backend readiness before the desktop
  UI finishes bootstrapping after reload.
- **Closest restorable route fallback after backend switches** `[v1.68.0]` —
  when reconnecting to a backend that does not have the previous coding or
  cockpit session, desktop restore now lands on the nearest valid hub page
  instead of reopening a stale session-specific route.


---

## 12. Embed and API

The same HTTP + SSE API drives the desktop, browser, and mobile clients. Embed it elsewhere with no extra work.

- **REST + SSE chat API** `[since v1.0]` — `POST /api/team/chat` is
  fire-and-forget (returns 202 in <50ms); the agent streams events on
  `GET /api/team/{session_id}/stream`. Reconnect-safe replay.
- **Global app event stream** `[v1.103.0]` — first-party clients keep a
  lightweight `GET /api/events/stream` connection for cross-session
  lifecycle and metadata events. Scheduled turns wake the matching session
  stream, completed and stopped turns notify clients to sync and update session
  states globally, generated titles update every session surface, and native
  notifications no longer depend on the originating chat being open.
- **SSE event protocol** `[since v1.0]` — typed events: `thinking`, `message`,
  `tool_call`, `tool_start`, `tool_output_delta`, `tool_end`, `usage`,
  `inbox`, `agent_status`, `queued_turn_start`, `rate_limit`,
  `provider_status`, `permission_asked`, `error`, `done`.
- **Mid-turn reconnect** `[since v1.0]` — close the tab, reopen later; the
  stream replays buffered state then resumes live.
- **Multi-client streaming** `[since v1.0]` — multiple tabs can watch the same
  session simultaneously.
- **Embeddable web UI** `[since v1.0]` — the wheel-bundled UI can be served
  from the API process or behind your own reverse proxy.

---

## Not yet shipped

Future work and known issues are tracked in [GitHub issues](https://github.com/lthoangg/OpenAgentd/issues), not in this feature catalogue.

When a feature ships, add it to the right pillar above with its `[vX.Y.Z]` tag.

---

## How to update this document

When you cut a release:

1. **For each user-visible change**, find the right pillar (1–12) and add a
   one-line entry with the `[vX.Y.Z]` tag.
2. If a pillar doesn't fit, add a new one — but don't shoehorn unrelated work
   into an existing pillar.
3. If the change is important to the product story or setup, also update
   [`../../README.md`](../../README.md).
4. Close the GitHub issue that tracked the feature, or create one if the shipped
   work did not have an issue yet.
5. If the change is technical / architectural, keep its non-obvious rationale
   beside the implementation; git history preserves the historical decision.
6. Bump the `updated:` field in the frontmatter to the release date.
7. If you remove a feature, mark it *(deprecated)* in place for at least one
   release before deleting the entry.

This document is the **canonical** answer to "what does OpenAgentd do?". Slides,
README copy, comparison docs, marketing posts, and investor decks should all
trace their claims back to a line here.
