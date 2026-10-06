---
title: Features
description: Canonical, version-cited catalogue of shipped user-visible OpenAgentd features.
status: stable
updated: 2026-10-06
---

# Features

The canonical source of truth for shipped user-visible capabilities. Every feature lists the
release that introduced it (where known). When you ship something new, **add it here first** — README and external copy should cite this page.

> **Headline.** OpenAgentd is a coding-first desktop workspace for a local coding agent — a
> double-clickable app that runs an agent on your machine, with a
> real UI to watch every step. Open source (Apache 2.0). 16 providers. Your keys.

**Latest release:** v3.8.0 · October 6, 2026 · [release notes](https://github.com/lthoangg/openagentd/releases/tag/v3.8.0)

---

## How this document is organised

Features are grouped by **pillar** — the same surfaces that drive the product
narrative on slides and in the README:

1. [The desktop coding workspace](#1-the-desktop-coding-workspace)
2. [Agents and tools](#2-agents-and-tools)
3. [The coding workspace](#3-the-coding-workspace)
4. [Memory and context](#4-memory-and-context)
5. [Providers and models](#5-providers-and-models)
6. [Built-in tools](#6-built-in-tools)
7. [Extension surface](#7-extension-surface)
8. [Path denylist and permissions](#8-path-denylist-and-permissions)
9. [Observability](#9-observability)
10. [Voice](#10-voice)
11. [Distribution and updates](#11-distribution-and-updates)
12. [Embed and API](#12-embed-and-api)

Conventions used in this document:

- `[v2.X.Y]`, `[v1.X.Y]` — release that shipped the feature (where known).
- `[since v1.0]` — present in the v1 line; no precise version known.
- *(beta)* — experimental, may change. *(deprecated)* — removed or replaced.
- Indented sub-bullets are user-visible details, not separate features.

---

## 1. The desktop coding workspace

The product's primary coding surface. A native double-click app on macOS, Windows,
and Linux that hosts the same backend sidecar + React UI you would otherwise
run from the terminal (the native Rust binary since v3.0.0).

- **Native Rust backend engine (OpenAgentd v3)** `[v3.0.0]` — compiles the entire
  backend into one ~43 MB binary (`appv3/`). The desktop app and the CLI release ship it
  in place of the 220 MB Python runtime (`make -C desktop sidecar`).
  It shares v2's DB, config and plugin dirs. Cold start takes 27–38 ms (26–35x faster)
  and idle memory is ~20 MB (8x less). User plugins are TypeScript/JavaScript files run in
  an embedded QuickJS runtime. v3 does not load `.py` plugins; `openagentd.d.ts` in the
  plugin dir types the API. Measurements and remaining differences: `appv3/REPORT.md`.
- **Safer local server and backend auto-restart (v3)** `[v3.0.0]` — without an
  access key, the server refuses requests from other websites and from foreign
  `Host` names, so a page open in your browser cannot drive your agent. The
  desktop, mobile and local dev UIs are unaffected; `CORS_ORIGINS` adds
  origins and `["*"]` restores the open default. The desktop token and access
  key are removed from the environment of every process the agent starts
  (shell, terminal, git, MCP, plugins). The desktop app restarts a crashed
  bundled backend (up to 3 times in 10 minutes) and reconnects open windows.
  Stopping the server with open streams exits at once instead of after 5 s.
  An internal crash in one turn ends that turn with an error instead of leaving
  the session busy, and concurrent messages keep distinct history positions.
- **v3 on macOS, Linux and Windows** `[v3.0.0]` — CI builds and tests all three.
  Snapshots use in-process `gix`, so no `git` binary is needed (up to 6x faster).
  Grep is linear-time and parallel. The file tree, git status and diff refresh live
  when an editor, terminal or `git` changes the workspace (FSEvents / inotify /
  ReadDirectoryChangesW; `OPENAGENTD_FS_WATCH=poll|off`). On Windows the terminal
  works through ConPTY, and background commands no longer open console windows.
- **Faster v3 plugins and shell** `[v3.0.0]` — plugins get a native `regex`
  module in Python syntax. A secret scrubber built on it runs about 20x faster
  than with JS `RegExp`. The `shell` tool reads your rc files (aliases,
  functions, options, PATH) once and reuses them, instead of sourcing
  `.zshrc`/`.bashrc` on every call (about 130 ms saved per call; rebuilt when
  an rc file changes; `OPENAGENTD_SHELL_SNAPSHOT=false` restores v2 behaviour).
- **Faster reopen, streaming and desktop launch** `[v3.4.0]`:
  - Reopening a long session with member agents loads 3 history pages
    instead of 11 (1.7 MB instead of 13.3 MB), and member rows are no longer
    repeated.
  - While a reply streams, only the live turn re-renders, and a long answer
    re-parses only its unfinished tail (0.5 ms per update at 100k characters,
    was 8 ms).
  - Large files, diffs, model lists, trace waterfalls and commit patches open
    and scroll without stalls.
  - The desktop app's bundled backend is ready ~220 ms after launch (was
    ~880 ms). A saved server that is offline costs one 2 s check instead of
    up to 18 s, and in dark mode a new window opens dark instead of
    flashing light.
  - An idle server uses almost no CPU (under 10 ms a minute, was 60 ms).
  - `grep` keeps the matches it found when it times out. `read` caps
    directory listings and reports binary files instead of dumping them.
- **Plugins page and live settings refresh (v3)** `[v3.0.0]` — Settings →
  Plugins lists each plugin with its provider, tool hooks and load errors,
  and flags v2 Python plugins that have no TypeScript port (v3 does not run
  them). A one-time notice appears when a plugin isn't running. Agents,
  skills, commands, snippets, plugins and `mcp.json` edited outside the app
  refresh in open windows immediately. MCP servers report their status as it
  changes instead of being polled. With v2 the UI keeps its previous
  behaviour.
- **Settings draft protection and mobile navigation** `[v2.11.0]` — unsaved
  drafts survive remote refreshes and edits made during a save. Shared settings
  pages and source editors ask before discarding changes on internal navigation
  or close. Mobile exposes every settings category in a grouped section picker.
  Nested confirmation dialogs keep keyboard focus and Escape handling in the
  innermost dialog; shared tabs support arrow keys and Home/End.
- **Reliable Git history paging** `[v2.11.0]` — commit and graph pages advance
  together in single-branch and all-branch views. Commit lists provide an
  explicit Load more action and a retry action for failed history requests.
- **Native desktop app for macOS, Windows, Linux** `[since v1.0; Windows restored v1.106.0]` — Tauri 2 shell,
  bundled backend sidecar (Python until v2, native since v3.0.0), embedded Web UI,
  one process, no terminal required.
- **Explicit backend connection state** `[v1.68.0, v1.99.8, v1.113.0]` — desktop connection options
  are limited to the builtin sidecar and saved servers; no-backend dev windows
  show **Backend unreachable**, active server removal clears the current backend,
  the builtin row exposes **Stop** whenever the sidecar process is already
  running, and **Use builtin** starts + attaches the bundled backend when needed.
  If bundled startup exceeds 15 seconds, the native splash offers Retry, server
  selection, and backend-log-path copy actions instead of waiting indefinitely;
  native startup failures surface immediately, and Retry re-spawns the builtin
  backend without allowing duplicate sidecar processes `[v1.113.0]`.
- **Workspace-required architecture and root redirect** `[v2.4.0, updated v2.19.0]` — OpenAgentd runs on one
  screen built around workspaces. Since `[v3.0.0]` that screen is the root:
  `/` is a new session and `/{session_id}` a session; old `/coding` and
  Cockpit URLs redirect there, and the app's labels no longer call it
  "coding" (the composer reads "Ask anything in <workspace>…", the palette
  "Toggle Sidebar", the tray just the workspace name),
  workspaces are required across chat, scheduler, and terminals, and database
  migration permanently removes legacy workspace-less records. The workspace-less
  chat surface itself returned in v2.19.0 as a pinned Chat workspace rather than a
  separate mode (see below). Telemetry is accessible via the
  desktop status footer and mobile navigation.
- **Chat workspace** `[v2.19.0]` — the prebuilt **Chat** row in the coding
  sidebar runs the same agent on the same screen with its root in your home
  directory, so the agent reads, runs, and edits your own files with relative
  paths. Chat is not a project: workspace instruction files, project skills,
  project slash commands, and project snippets load only for real workspaces,
  while global instructions, skills, commands, and snippets still apply.
  Chat is not a repository either, so the pinned row offers no worktree or
  removal actions and the workspace dock has no Git tab; file-level undo is
  off, and `/undo` moves the conversation boundary only. Set
  `CHAT_WORKSPACE_DIR` to run Chat elsewhere and keep your home directory
  usable as a coding workspace.
- **Connection-ready screen warmup** `[v1.113.3]` — after either the bundled
  sidecar or an external server connects, the app preloads coding data in the
  background so the first session can render from cache.
  Packaged desktop launches also canonicalise the `index.html` entrypoint to Home
  instead of showing the client-side 404 screen.
- **Grouped settings navigation with one save contract** `[v1.128.0]` — the
  settings sidebar is grouped into **Agents & tools**, **Models**, and
  **About** instead of one flat list. **Title generation**, **Summarization**
  and **Multimodal** are consolidated into a single **Automation** section whose
  three groups can be collapsed independently. The shared save bar saves edited
  groups together; validation in an untouched group does not block saving,
  while every edited group must be valid. Every section now saves the same
  way: a sticky bar appears only when there are unsaved edits, with Reset, Save,
  and a `Cmd/Ctrl+S` binding. Notifications no longer writes on toggle, and
  reopening Settings returns to the section you left.
- **In-app crash recovery** `[v1.113.0]` — an unexpected UI render failure opens
  a recovery screen with Reload and copyable error details instead of leaving a
  dead webview that must be force-quit.
- **In-app auto-updater** `[v1.22.0, v1.99.8, v1.115.1]` — bottom-right update card + Settings → About
  → Updates, cached downloads, install-and-restart, signed minisign payloads, draggable and minimizable floating update card `[v2.3.0]`,
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
  its linked coding session `[v1.113.4]`. Per-session context
  (coding workspace name when available). Notification sounds are handled by
  the operating system;
  OpenAgentd does not play an extra in-app sound. Background-process completion
  alerts are deprecated and no longer emitted by app clients.
  Mobile notifications send again after `[v1.113.4]` stopped them; tapping
  one opens its session, and the one for the session already on screen is
  skipped while the app is open `[v3.0.0]`. iOS pauses the app in the
  background, so mobile notifications arrive only while it is running.
  Notifications are shorter `[v3.3.0]`: the title is a status and the workspace
  name (`Done · openagentd`, `Failed · …`, `Needs input · …`, `Plan ready · …`),
  and the session title, question, or plan summary shows as one line of up to
  100 characters. A failed turn now notifies too. Stopping a turn or dismissing
  a question does not, and a lead that is waiting on subagents notifies once,
  after their reports are handled. With several desktop windows open, each
  notification shows once and is skipped while another OpenAgentd window is
  focused, and clicking it opens the session in one window instead of all of
  them.
- **Quick Open and Command Palette** `[v2.3.0]` — `⌘P`/`Ctrl+P` searches and
  opens files in the active workspace; `⌘K`/`Ctrl+K` searches app actions.
  Both use the compact warm-paper search surface, keyboard navigation, and a
  visible warning when a capped workspace listing omits files.
  A Quick Open query ending in `:line` or `:start-end` (`Button.tsx:42-58`)
  opens the pick with those lines selected `[v3.0.0]`.
  `⌘F`/`Ctrl+F` finds user, assistant, and thinking text in the current transcript
  and highlights each match in place;
  `⌘D`/`Ctrl+D` toggles the files and git dock. `⌘N`/`Ctrl+N` starts a new
  session and is a no-op on an already empty idle session. The desktop status
  footer and mobile sidebar name the connected backend (`builtin` or the saved
  server name/host) instead of a hardcoded local label. Mobile chat actions
  expose transcript find and terminal access without a hardware keyboard.
  Empty coding sessions no longer show the Ask about this repo, Generate
  AGENTS.md, and Open terminal starter chips *(deprecated)*; the composer,
  palette, and chat actions drawer cover them. Press and hold the
  pinned Chat row in the mobile sidebar to start a new chat session, since the
  inline `+` is hidden on touch.
- **Palette pages and switching** `[v3.0.0]` — the Command Palette gains
  Switch Session… (recent sessions in every workspace, with running and
  waiting-for-you status) and Switch Workspace… (repositories, worktrees,
  and Chat, most recently active first). Each opens a nested list in place;
  Backspace on an empty query or Escape steps back out. Typing `>` in Quick
  Open searches
  commands instead of files. The desktop app adds Reload Window, since `⌘R`
  no longer reloads.
- **Plan and Code interaction modes** `[v2.14.0, updated v2.15.0, v3.0.0, v3.2.0, v3.8.0]` — the expanded composer switches an
  existing session between Code (default) and Plan without starting a new
  chat; `Tab` also toggles mode from the composer. Mode transitions are preserved via
  append-only hidden context notes in session history. In Plan mode, the agent explores
  the repository and produces decision-complete implementation plans, while the runtime
  strictly blocks mutating file operations and patches while permitting read-only inspection and testing via shell.
  The agent writes its plan with the `plan` tool and submits it with
  `submit_plan` (in either Plan or Code mode), which pauses the turn for review in the **Plan** tab of the
  review dock (full screen on mobile; it opens by itself on desktop). The tab
  shows the rendered plan and its status, and offers **Approve** and
  **Request changes**. Select plan text and choose **Comment** to attach a
  comment to that passage: commented passages stay highlighted, the review
  footer lists your comments (click one to jump to its passage, or remove it),
  and an optional box takes overall feedback. **Request changes** sends every
  comment with its quoted passage plus the overall feedback in one answer;
  unsent comments survive switching tabs. Approving carries on implementing
  the plan (switching the session to Code mode if in Plan mode); requesting
  changes resumes with your feedback in the current mode. The transcript shows a
  plan review card with the outcome, your comments and a button that opens
  the plan; **Open Plan** in the command palette (⌘K) does the same whenever
  the session has a plan. Replying in chat instead supersedes the review.
  Older `<proposed_plan>` answers still render as read-only cards.
  Switching mode while a turn is running no longer stops it: the switch is
  queued and applied when that turn closes, so it binds from the next turn and
  any message queued behind it. The toggle shows the queued mode in italics
  until it lands. Use stop if you actually want to interrupt the turn.
  - **Saved session plan** `[v3.0.0, updated v3.2.0]` — in a project
    workspace the plan is a Markdown file in `.openagentd/plans/`, which
    ignores itself in git unless you delete its `.gitignore`; chat sessions
    keep it in the session's data directory. You can edit it in the Plan tab
    (**Edit**) or in any editor, and **Open file** opens it as a normal file
    tab. The agent is told about your edits once and keeps them. Context
    compaction restates the plan verbatim, with the task list, just before
    the summary, so the agent keeps following the approved plan in long
    sessions (once every tracked task is finished, only a pointer to the
    file is kept). The Tasks tab and popover show a Plan row with its
    revision, **Open** and **Clear**, which stops using the plan in the
    session and leaves the file in place.
- **Fullscreen view mode and traffic-light space reclamation** `[v2.0.0]` — automatically
  detects macOS fullscreen mode and reclaims the window traffic-light header padding to
  maximise message and diff reading area.
- **Design token & UI corner-roundness ramp** `[v2.0.0]` — modernized design tokens with
  a softer corner-roundness ramp across bubbles, composer pills, dialogs, badges, and
  action states.
- **Platform-aware keyboard shortcuts** `[v1.93.1]` — `⌘` on macOS, `Ctrl`
  elsewhere, applied consistently across in-app shortcuts, the Command
  Palette, and native Tauri menu accelerators. Session Settings moved to
  `⌘⇧A`/`Ctrl+Shift+A` to avoid clobbering Select All; view-mode cycling and
  session-list refresh lost their dedicated shortcuts (palette-only, low
  frequency). `⌘S`/`Ctrl+S` no longer opens Scheduled Tasks, so it only saves
  in Settings `[v3.0.0]`.
- **Theme in Settings and the palette** `[v3.0.0]` — Settings → About has an
  **Appearance** section with a System / Light / Dark choice, and the Command
  Palette has **Theme: System**, **Theme: Light** and **Theme: Dark**. The
  mobile drawer keeps its theme button.
- **Smooth close animations on UI components** `[v1.77.0]` — dropdown, tooltip,
  and popover now play a 100–150 ms exit animation (fade-out + zoom-out) before
  unmounting, matching the open transitions. Dialog and sheet retain their
  existing close animations. Tooltip gains a CSS arrow and correctly appears
  over disabled buttons via a transparent span wrapper.
- **In-app toasts pause on hover/focus** `[v1.101.0]` — the auto-dismiss timer
  for toast notifications now pauses while the pointer or keyboard focus is on
  the toast, resuming with the remaining time once it clears, so a toast can no
  longer disappear mid-read.
- **Floating surfaces keep content visible** `[v3.0.0]` — on desktop, toasts,
  the update card, and the language-tools prompt stack in one bottom-right
  column above the status bar instead of overlapping each other.
- **Categorized stream & execution error handling** `[v1.133.0]` — provider stream
  errors (rate limits, auth 401, connection drops) are now displayed directly within
  the chat transcript area as persistent error callout cards, while action validation
  failures (e.g. undo/redo/compaction errors) surface targeted, categorized toast
  notifications with contextual titles.
- **Keyboard-operable overlays and dropdowns** `[v1.125.0]` — select/menu
  dropdowns navigate with `ArrowUp`/`ArrowDown`/`Home`/`End` and commit with
  `Enter`/`Space`, announcing the active option via `aria-activedescendant`
  (focus stays on the trigger because the panel is portalled outside the modal
  focus trap). `Escape` now closes the innermost layer first, so dismissing an
  open list no longer closes the surrounding modal. Session Settings opens with
  focus in the model field instead of the close button.
- **Shortcuts that follow what is on top** `[v3.3.0]` — one keyboard layer
  model for the whole app. Escape closes only what opened last (a popover in
  a dialog, a lightbox under the palette), one thing per press. While a
  dialog, Settings, a lightbox or an MCP app's fullscreen view is open, app
  shortcuts (`⌘N`, `⌘W`, `⌘B`, `⌘[`…) no longer act on the app behind it;
  `⌘K`, `⌘P` and `⌘,` can still switch to another overlay, except over a
  confirmation or form dialog and over Settings with unsaved changes.
  Letters typed in a dialog stay out of the composer, and Escape that closes
  the composer's @-mention or slash menu no longer also minimizes it. App
  shortcuts also work while a Preview page or an MCP app has focus (keys the
  page uses itself stay with it), so `⌘W` there closes the tab instead of the
  window. **Keyboard Shortcuts** (`⌘/`/`Ctrl+/`, or the palette) lists every
  shortcut by area.
- **Keyboard areas, like a desktop app** `[v3.5.0]` *(deprecated — removed in
  v3.6.0: Tab and Shift+Tab move through every control in page order again,
  and arrow keys no longer walk between buttons)* — Tab and Shift+Tab moved
  between areas (header, sidebar, chat, composer, dock, status bar) instead of
  through every button; arrow keys, Home and End moved inside an area.
- **Keyboard paths and focus continuity** `[v3.5.0, v3.6.0]`:
  - Row actions that only show on hover also appear on keyboard focus and keep keys:
    F2 renames, Delete (or `⌘⌫` / `Ctrl+Backspace`) deletes, Shift+F10 or
    the Menu key opens the row's menu. In the sidebar, Left and Right
    collapse and expand a workspace.
  - Focus never drops to the page: after sending, Escape or a deleted row it
    returns to the composer, and a collapsed sidebar or closed drawer cannot
    take it. In the composer, Tab still switches Plan and Code; Shift+Tab or
    Escape leaves it. Focus handed back on page load draws no focus ring
    until you press a key `[v3.6.0]`.
  - The desktop app shows **Skip to main content** on the first Tab `[v3.6.0]`.
  - The Keyboard Shortcuts sheet lists the new keys under **Moving around**.
- **Desktop app polish** `[v3.5.0]` — in the desktop app, dragging across UI
  chrome no longer highlights it (chat, code, diffs and the terminal still
  select), buttons use the arrow cursor, links and images cannot be dragged
  out, and a window in the background dims its highlights. The webview's
  Reload / Back / Inspect menu is gone: right-click in the chat offers **Open
  link** / **Copy link**, **Copy code**, **Copy response** / **Copy as
  Markdown** and, on your messages, **Copy** / **Edit**; text fields and
  selected text keep the native menu. Shift+F10 opens the same menus in the
  browser too.
  - Tooltips wait half a second before appearing, then show at once while you
    move along a toolbar, and only open on keyboard focus, not after a click.
  - Search, palette, find, title and worktree fields, and the desktop
    composer, no longer autocorrect or curl quotes.
- **Type-to-focus composer** `[v1.40.0]` — in coding chat, start
  typing on the chat surface to expand/focus the composer and capture the first
  character without pressing `⌘I`/`Ctrl+I` first.
- **Developer-friendly word navigation in composer** `[v1.86.0]` *(deprecated — replaced by native browser word navigation; the custom interceptor that stopped at programming separators like `.`, `-`, `_` was removed so `Option + Arrow`/`Ctrl + Arrow` now follow each platform's standard word-jump semantics)*.
- **Native menu/tray shortcuts** `[v1.39.0, v1.93.1]` — menubar shortcuts for Home,
  Coding, Command Palette, Scheduled Tasks, Session Settings,
  key settings pages, updates, reload, config folder, and backend log; compact
  tray dropdown for status, quick navigation, reload, settings, and quit.
  Command Palette, Scheduled Tasks, and Session Settings accelerators now use
  `CmdOrCtrl` (Session Settings requires Shift) to match the in-app
  platform-aware shortcuts `[v1.93.1]`.
  - **Platform-standard menus** `[v3.0.0]` — File has New Session (`⌘N`), New
    Window (`⌘⇧N`), Open Workspace… (`⌘O`), and Close Window (`⌘W`, which
    closes an open dock tab first). Edit adds Find in Transcript (`⌘F`); View
    adds Toggle Sidebar (`⌘B`) and Open Terminal (`⌘⇧` + backtick). A new Help menu
    links GitHub, release notes, and issue reporting, and holds the config
    folder and log shortcuts. The macOS app menu gains Services and
    Hide/Hide Others/Show All. Reload and Force Reload no longer have
    accelerators, the duplicate New Window, Quit, and Coding (`⌘⇧K`) items
    are gone, and the Window menu no longer says "Hide to Tray".
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
    tray `MenuItem`s can't host custom widgets `[v1.94.0]`. Workspace spend
    caps get their own metered row next to any rate-limit window
    (`🔴 OpenAI Codex · Spend cap · 259% ██████████ · resets 24d · 1,811.97
    of 700 used`) — the bar clamps at 100% but the percent reports the real
    overage — a reached cap reads "usage limit reached" instead of
    advertising credits, and it counts toward the critical badge and
    notification even when the provider stops returning quota windows
    `[v1.131.1]`.
  - **macOS tray popup** `[v2.4.1]` — on macOS the tray icon opens a custom
    borderless, always-on-top webview popup anchored under the icon instead
    of the native menu, so the usage limit renders as styled CodexBar-style
    meters (thin flat bar, leading dot, `42% · Resets in 2h 14m`, spend-cap
    amount detail, and live credit balances for DeepSeek/OpenRouter-style
    providers) in the app's Paper design, with Open App / Settings / Quit
    actions. Each meter also draws a thin vertical "now" tick at the
    wall-clock position within the quota window — distinct from the bar,
    which tracks usage consumed — so e.g. 1h into a 5h window places the
    tick at 20%. It reads the same polled usage cache and keeps the
    critical-badge and notification logic; Windows/Linux keep the native
    tray menu. The header features a server selector dropdown `[v2.8.0]` that
    allows inspecting usage across local and remote connected backends
    with live reachability filtering.
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
- **Multiple desktop windows** `[v1.41.0]` — open additional coding windows from
  File → New Window, the tray menu, or `⌘⇧N`/`Ctrl+Shift+N`; windows share the bundled
  sidecar and desktop auth token, while each window can independently switch to
  a saved external server `[v1.47.0]`. New windows now inherit the active
  window's current backend selection instead of failing when the bundled sidecar
  is unavailable `[v1.64.1]`. View → Zoom In / Out / Reset now applies per
  desktop window instead of globally across all open windows `[v1.66.1]`. On
  macOS, each desktop window now updates its native title to the active coding
  workspace name or session title so the Dock window list distinguishes
  open windows `[v1.66.1]`. Fixed a bug where switching one window's CLI server
  could still redirect other open windows onto the same server: the backend
  now targets its "backend ready" notification at the switching window only,
  and the frontend listens for it on a per-window channel instead of the
  app-wide broadcast channel it was previously (incorrectly) using `[v1.99.1]`.
  Desktop windows now operate as symmetric peer windows `[v2.8.0]`: closing
  any window destroys its webview and frees memory immediately, while clicking
  the Dock icon or tray reopen action spawns a clean window when none are open.
  - **Hold Command + click session to open in new window** `[v1.62.1, v1.64.1]` — in the desktop app, holding `Cmd` (macOS) or `Ctrl/Cmd` (Linux) and clicking a session in either sidebar opens that session directly in a new independent desktop window; failures now surface an in-app error toast instead of silently doing nothing.
- **Editable session titles** `[v1.27.0]` — double-click a session card or use its
  edit affordance in the sidebar to rename saved sessions.
- **Mode-scoped recent-session lists** `[v1.66.1]` — session sidebars now fetch
  their own coding session pages instead of
  sharing one mixed cache, preventing intermittent empty recent-session lists
  when prior conversations exist.
- **Slash commands** `[since v1.0]` — `/init`, `/compact`, `/undo`,
  `/redo`, `/redo-all`, plus user-defined commands. Commands are contextually
  filtered by active session state `[v2.0.0]`.
  - **`/redo` and `/redo-all` slash commands** `[v2.0.0]` — restore undone chat turns
    step-by-step or fast-forward completely back to the latest turn.
  - **`/init` AGENTS.md analysis & generation** `[v1.9.0, v2.0.0]` — analyzes codebase
    structure and generates standard `AGENTS.md` context files at repository root and
    subdirectories with a guided analysis protocol.
  - **`/plan` slash command** `[v1.96.0]` *(deprecated — superseded by Plan and Code interaction modes in v2.14.0)* — triggers
    a research-then-approve workflow: the agent investigates the problem space and proposes a step-by-step
    implementation plan, then waits for explicit approval before writing any code. Superseded by the first-class
    Plan and Code interaction modes in the input composer.
- **Bang shell commands** `[v1.39.0]` *(deprecated — removed in v2.0.0; use the coding
  workspace terminal instead)* — start a message with `!` to run the
  remainder directly through the shell tool without a model turn; history stored
  the run as structured shell tool output.
- **`shell` tool output handling** — Stop terminates active foreground
  shell process groups; background commands started with `background=true` return
  the spawned PID. Raw ANSI/CSI/OSC escape
  sequences (colors, cursor movement, hyperlinks) from color-forcing CLIs are
  stripped from foreground results and live streamed output before reaching
  the LLM or the UI `[v1.120.0]`. Foreground output memory is bounded, with
  oversized output streamed incrementally to a session spill file `[v1.120.1]`.
  Foreground commands default to a 120-second timeout instead of 60 `[v1.131.3]`.
- **Drag-and-drop files into chat** `[since v1.0, v1.82.0, v1.131.0]` — drag files (images, PDFs, text, etc.) anywhere onto the coding chat area to show a drop overlay and attach them to the composer. Supports multi-file drops, file-type filtering, and cancellation. A drop no longer attaches the same file twice, folders dropped onto the chat are ignored instead of silently swallowed, and a file dropped outside the chat area no longer navigates the app away from the session `[v1.131.0]`.
- **50 MB attachments with in-composer rejection** `[v1.131.0]` — every attachment
  type shares one 50 MB per-message ceiling instead of the previous mix of
  tighter per-category rules behind a smaller request-body cap. Oversize files
  are refused in the composer, by name, with the rest of the batch still
  attached and the draft intact — no more accepting a file and then losing the
  whole message to a bare upload error. `@mention` context keeps its own
  500 KB limit, since mentioned files are read inline rather than uploaded.
- **Composer history navigation** `[v1.32.0, v3.0.0]` — when the input is empty,
  `↑` / `↓` walks previous user prompts from the current chat plus local
  submissions; sub-agent reports are left out. The transcript scrolls to each
  recalled prompt, and back to the latest message when you walk out to an
  empty draft.
- **Clickable URLs in user message bubbles** `[v1.77.0]` — plain-text URLs typed
  or pasted into a user message are rendered as tappable links; style matches
  agent response links.
- **Mermaid diagrams in agent responses** *(deprecated)* `[v1.121.0, v1.123.0, v3.5.0]` —
  completed `mermaid` code fences rendered as diagrams with Diagram and Code
  views and a full-screen pan/zoom view. Since v3.5.0 the chat no longer
  renders diagrams: a `mermaid` fence shows as an ordinary code block with copy,
  and the Mermaid library is no longer shipped. For drawn diagrams, an agent
  writes a self-contained HTML/SVG file and opens it in the Preview tab.
- **LaTeX math rendering** `[v1.133.0]` — inline math (`$math$` and `\(math\)`),
  display math (`$$math$$` and `\[math\]`), and fenced code blocks (`math`, `katex`)
  render formatted LaTeX mathematics via KaTeX. Distinguishes mathematical
  formulas from currency amounts ($50 and $100) and escaped dollar signs (\$50),
  with scrollable containers for wide formulas and theme-aware styling across
  light and dark modes.
- **Fast TanStack Markdown & unified syntax highlighting** `[v2.0.0]` — chat markdown
  rendering is powered by `@tanstack/markdown` and code fences are highlighted with
  `@tanstack/highlight`, sharing one unified highlighter and caching highlights across
  re-renders for fluid scrolling and streaming.
- **Markdown table copy button** `[v2.16.0]` — hovering over rendered markdown tables
  reveals a compact copy button in the top-right corner that copies the table to
  the clipboard as formatted GitHub Flavored Markdown (including column alignments
  and line breaks), with zero overhead during rendering or streaming.
- **As-is reasoning and response formatting** `[v2.17.0]` — agent thinking traces and
  assistant responses render as-is without synthetic newline collapsing or manipulation,
  preserving the exact line breaks and spacing emitted by reasoning and chat models.
- **Pin chat transcript via CSS `overflow-anchor`** `[v2.0.0]` — pins chat transcript
  scrolling using native browser `overflow-anchor` instead of per-frame JS `scrollTop`
  calculations, eliminating stream stutter and CPU churn during fast agent output.
- **On-demand bundle splitting for heavy components** `[v2.0.0, v3.5.0]` — xterm.js,
  KaTeX, and PDF.js load lazily on demand when first needed, accelerating cold-start
  boot time and reducing initial bundle memory.
- **App surfaces open without a loading step** `[v3.0.0]` — Settings pages,
  Telemetry, the review dock with its Tasks and Schedule tabs, the scheduler and
  session settings dialogs, session search, message Markdown, and MCP app
  results ship with the app instead of loading on first open, so none of them
  shows a placeholder first. Only xterm.js, KaTeX, and PDF.js still load on
  demand.
- **Scroll position per session** `[v3.5.0]` — leave a session scrolled up and
  come back to it, and the transcript opens where you were reading; a session
  you left at the bottom keeps following new output. Kept while the app runs.
- **Stream auto-stick restored after scroll-to-bottom on mobile** `[v1.77.0]` —
  tapping the scroll-to-bottom button no longer detaches the stream
  auto-follow; direction-based detach logic removed from `onScroll` (was
  indistinguishable from smooth-button animation on mobile); user intent is
  now detected via `onWheel` / `onTouchMove` only. `AgentPane` gains a
  `ResizeObserver` so content reflow (markdown, images, syntax highlight) also
  re-sticks correctly. Keyboard scrolling (PageUp / Home / arrows) and
  scrollbar or selection drags now detach the transcript too, so reading back
  through a long streaming tool call no longer snaps to the bottom on every
   output update `[v1.132.0]`.
  Auto-follow remains attached when tool output collapses, turn pruning, or layout shrinkage reduces scroll height during token streaming `[v2.12.0]`.
- **Mobile keyboard viewport guardrails** `[v1.99.1]` — virtual-keyboard detection now uses the pre-keyboard layout height, the mobile shell stays pinned instead of following `visualViewport.offsetTop`, and chat auto-stick ignores keyboard-only scrollport resizes so manual transcript scrolling no longer flickers on iOS/WebViews.
- **iOS text size** `[v3.0.0]` — the iOS app follows the system text size
  (Settings or Control Center) while it runs: larger settings scale the text
  and spacing together, up to 125%. Smaller settings keep the design size.
- **A calmer transcript** `[v3.0.0]` — the chat reads as prompts and answers:
  - Every prompt you wrote has Edit (rewind to it and put it back in the
    composer; `/redo` brings the undone turns back), reachable from the
    keyboard.
  - A failed turn ends in an error card with Retry and Switch model, which
    opens Session Settings.
  - `⌥⌘↑`/`⌥⌘↓` (`Ctrl+Alt+↑`/`Ctrl+Alt+↓` elsewhere) jump between your
    prompts; `⌥⌘↑` reaches earlier prompts in one press, loading them when
    they are not loaded yet. On mobile, Previous prompt and Next prompt in the
    chat actions menu do the same.
  - `path:line` and `path:start-end` references (also `#L42-L58`) in replies
    and tool output open the file in the review dock with those lines
    selected. A bare name or partial path (`Button.tsx`,
    `src/app.ts` for `web/src/app.ts`) finds its file, preferring one the
    session read or patched; when several files match, Quick Open opens
    searching for the reference.
  - Clicking an `@path#L42-L58` mention or a design feedback source opens the
    file with that range selected too, not just the file `[v3.6.0]`.
  - On desktop a timeline scrubber replaces the transcript's scrollbar and
    marks prompts, find matches, and a question waiting for you.
  - Reply footers add the turn's output tokens, or its cost when the model
    has a price.
- **Reader transcript** `[v3.0.0]` — an opt-in transcript style (Settings →
  About → Appearance → Transcript, or Toggle Reader Mode in the command
  palette, which also finds it as "compact" or "transcript"). Each turn reads
  as its answer:
  - The thinking, every tool call, and the narration between them fold into
    one row such as "6 reads, 3 searches, 4 commands, 2 edits", with failures
    counted; while the turn runs it names the current step ("Working ·
    Shell: Run web tests"). Opening it shows the steps as in the detailed
    transcript, and transcript find opens it when it matches inside.
    Since `[v3.1.0]` the running row also says how long the turn has run,
    counted from its prompt ("Working · 1m 12s · Shell: Run web tests"),
    leaves failures for the finished row to count, and a turn waiting on
    your answer shows its counts instead of "Working".
  - An open row stays pinned to the top of the transcript while its steps
    scroll under it, and a **Collapse** row ends the steps, so a long fold
    closes without scrolling back up. Closing from either leaves the row
    where you pressed it.
  - A question waiting on the user, interactive MCP apps, errors, and
    compaction dividers stay in place; once answered or closed, a question
    folds in with the rest of the work.
    Since `[v3.1.0]` a compaction divider also splits the work: the steps
    before it fold into a finished row above it, and the steps after it into
    a row of their own below, which is the one that reads "Working".
    A subagent's report that arrives while the lead works folds into the
    same row ("… 1 report") instead of splitting the turn, so the lead's
    answer after it reads as the turn's answer under one footer; while the
    lead picks up after it, the row reads "Working · Report from explorer#1".
  - A finished turn lists the files its `patch` calls changed, with line
    counts; each opens its git diff in the review dock. Since `[v3.1.0]` the list starts
    closed behind its "N files changed" header.
- **The composer while the agent works** `[v3.0.0, updated v3.4.0]`:
  - Scrolled away from the live end, a "↓ N new" chip rides on the
    composer, wherever it is dragged, and counts what arrived since.
  - While a turn runs, Send splits in two. The pill steers: the agent reads
    the message before its next step (`Enter`). The chevron adds Queue until
    done, which holds the message in this window and sends it as a turn of
    its own once the turn ends (`⌥Enter` / `Alt+Enter`), and Stop & send
    (`⌘Enter` / `Ctrl+Enter`). In the transcript, steering messages read
    "Read before the next step" and held ones "Sends when this turn ends".
  - Queued messages reach the agent in the order they go out: steers first,
    then held messages, one turn each. A steer is read before the running
    turn's next step, or starts the next turn if that turn makes no further
    step. Its `@` mentions arrive with it `[v3.4.0]`. A steer sent while a
    question or plan review waits replaces it and starts a new turn; a held
    message waits until the question is answered or dismissed.
  - Stop, or a turn that fails, returns what the agent has not read yet to
    the composer: unread steers, then held messages `[v3.4.0]`. A steer the
    agent read first stays in the transcript. A steer with files sent from
    another window stays with the agent and goes out ahead of the next
    message.
  - Limits: held messages live only in this window and are lost on reload.
    A steer sent late still goes out before an earlier held message. Steers
    read together run with the model and thinking level of the last one
    sent.
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
- **Effective model on assistant replies** `[v1.42.0, updated v3.2.0]` — assistant footers show
  the model that produced the reply, including fallback transitions, next to the
  copy and timing metadata, followed by the thinking level the reply ran at
  (e.g. `gpt-5 · high`). Every reply footer names them, and each prompt's
  hover row names the model and level that answered it (before an answer, the
  ones it was sent with).
- **`@file` / `@folder` mentions in composer** `[v1.17.0]` — files render blue,
  folders render orange. Mentioned files inject inline hidden context on the
  turn without becoming uploads; mentioned folders inject a lightweight directory
  listing without becoming uploads. In coding sessions,
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
- **Header context meter** `[v1.53.0, v2.0.0]` — desktop and mobile chat headers show an
  icon-sized input-token progress ring against the backend's model-aware
  summarization trigger; hover, focus, or tap/click reveals input/output/cache
  details, cache hit rate percentage, reduced compaction input tokens, and estimated USD used across the active session `[v1.107.0, v2.0.0]`; the estimate sums provider-reported input, output, cache-read, and cache-write usage at the active model's registry rates, so compaction never reduces previously incurred spend. Token rows describe the lead while `session cost` covers every agent; live values are published per completed model call from the same usage snapshot the transcript and telemetry store, so the meter no longer disagrees with them, and it stays visible for the duration of a live turn `[v1.132.0]`.
  The meter remains displayed even without any messages or usage in the session `[v2.0.0]`. The summarizer's own LLM call now counts too: its usage (with cost) is
  persisted on the compaction summary row and published as a live usage frame,
  so the running session cost stays `previous cost + current turn cost` across
  compactions, on the live meter and after reload alike `[v2.0.0]`. The server
  now returns the authoritative full-session cost and output-token totals on
  history responses (summed across every message, compaction summaries
  included), so reloading a session longer than one history page no longer
  undercounts the meter — the client adopts the server total instead of
  re-summing the truncated page, and older-page loads no longer re-add usage
  `[v2.4.2]`.
- **Todos panel** `[since v1.0]` — task board with a topbar progress badge
  `<finished>/<total>` `[v1.17.0]`. Live invalidation.
- **Mobile / phone-first layout** `[since v1.0]` — breakpoints, safe areas, drawer
  shapes, composer keyboard avoidance, touch row actions, pull-to-refresh,
  haptics, and legibility guards optimized for small screens `[v1.45.2]`;
  long-press rows get native impact haptics (`tauri-plugin-haptics`) and an
  iOS-style press-and-hold scale animation `[v1.47.0]`.
  The chat actions menu also opens Search files (Quick Open) and the command
  palette `[v3.0.0]`.
- **macOS overlay + Tauri drag region** `[since v1.0]` — the header doubles as the
  window drag region; macOS gets the proper traffic-light overlay.
- **Restored desktop window size** `[v1.52.0]` — desktop windows reopen at the
  last normal size saved on quit, while minimized/maximized dimensions are ignored.
- **Remote-backend mobile shell** `[v1.34.0, v1.106.0]` — Tauri mobile app scaffold embeds
  the shared Web UI and connects to saved remote API servers. Foreground resume
  now reconciles missed history and replaces potentially frozen chat streams;
  remembered-server launches prefetch and reuse native credentials.
- **Sideloadable iOS app** `[v3.7.0]` — each release includes an ad-hoc-signed
  `OpenAgentd_<version>_iOS.ipa` with a checksum. A SideStore/AltStore source at
  `releases/download/latest-ios/source.json` installs the app and offers new
  versions as updates. See [Install the iOS app](../../mobile/INSTALL-IOS.md).
- **LAN access key for external clients** `[v1.43.0, v1.103.0, v2.4.0]` — `openagentd server start --host 0.0.0.0 --key`
  stores the CLI server's bind address, port, and bearer key in `server.yaml`, separate from the desktop builtin sidecar's ephemeral token while agents, providers, sessions, and other settings remain shared. Restart and upgrade preserve that key without exposing it in process arguments. OpenAgentd-managed launchers refuse non-loopback binds without a configured key `[v1.101.0]`.
- **Desktop server connection manager** `[v1.43.4, v1.99.8, v1.104.0]` — the desktop **Server connection** dialog switches the current window between the builtin sidecar and saved external servers, normalizes pasted `/api` URLs, and preserves other open windows' backend choices. Typed servers now require a successful health and access-key test before they can be named, saved, and connected. Saved LAN access keys are scoped per backend origin and stored in the native OS credential store on installed desktop/mobile shells; browser development keeps the per-origin localStorage fallback. Remembered external servers reconnect on app launch with sidecar fallback, while the desktop window opens immediately as backend startup continues asynchronously `[v1.57.1]`.
  - **Reload after switching backend servers** `[v1.98.1]` — after connecting a desktop window to a different saved or typed external server, the webview reloads so stale frontend state is discarded and the window comes back against the newly selected backend cleanly. Reconnecting to the already active backend does not reload.

---

## 2. Agent runtime

OpenAgentd runs as a single-agent runtime cockpit. The agent drives the conversation,
executes tools, manages its task list, and inspects workspace repositories.

- **Single-agent cockpit** `[since v1.0, updated v2.1.0]` — exactly one primary agent
  configuration (`agents/code.md`) drives every conversation.
- **Hub-and-Spoke agent teams** `[v2.16.0, updated v2.17.0]` — the lead coding agent can spawn,
  coordinate, and supervise specialized subagents via the unified `delegate` tool
  loaded from markdown profiles (`agents/*.md`). Profiles and descriptions are dynamically
  reflected in the `delegate` tool description with CommonMark list separation. Subagents run asynchronously in the background,
  automatically returning their deliverables or clarifying questions back to the lead session as
  user messages tagged with `from_agent`. Spawns use monotonic
  instance handles (`profile#N`, e.g. `explorer#1`, `explorer#2`) permitting multiple concurrent
  instances of the same profile. Communication follows a strict hub-and-spoke topology: subagents
  interact exclusively with the lead (`ask_lead`, direct deliverables) and inherit the lead's active
  model fallback and interaction mode (including Plan mode read-only invariants `[v2.17.0]`). Clarifying
  questions via `ask_lead` preserve tool call IDs across turn suspensions, ensuring tool response
  messages persist reliably to the child session database upon lead reply `[v2.17.0]`. Deliverables rendered in the lead chat view are minimized by default with expandable preview toggles to keep transcripts compact. Stopping the lead cascades cancellation to all active child sessions.
- **System prompt editor and profile-scoped tools** `[v2.17.0]` — Agent settings
  features a dedicated System prompt card with a monospace textarea bound to the
  Markdown prompt body across all agent profiles (both the lead coding agent and member subagents).
  For the lead agent, a "Load default prompt" action populates the built-in instructions into
  the editor for customized tuning. Member agent configuration isolates profile-scoped tools,
  filtering out lead-only orchestration tools (`delegate`, `todo_manage`, `schedule_task`,
  `note`) and providing fallback toolsets and default instructions when omitted from disk.
- **Clean taskboard checklist** `[v1.127.0, updated v2.1.0]` — the todo taskboard
  serves as a flat, user-readable checklist of tasks and statuses (`pending`,
  `in_progress`, `completed`, `cancelled`). A `clear` without a status empties
  the board, so a new plan no longer inherits the unfinished tasks of an
  abandoned one; `clear` with a status still removes only those `[v3.0.0]`.
- **High-throughput chat persistence engine** `[v2.0.0]` — remodeled `session_messages`
  onto derived state (`seq` + `kind` + `pinned`) with partial SQL indexing,
  single-allocation checkpointers, and SQL-level compaction keep-tail calculation.
  Checkpointer sync updates defer until the database transaction commits, preventing lost messages on retry `[v2.13.0]`.
- **Incremental session history hydration** `[v2.0.0]` — hydrates session histories
  incrementally and materializes SQLite query-planner statistics (`ANALYZE`) after
  migrations for sub-millisecond query planning.
- **`/continue` resumes interrupted work** `[v1.5.0]` *(deprecated — removed)* — restores
  the agent's pending plan and resumes streaming from the last turn. Available in the
  command palette and assistant footer. Continuations use the session's model
  and reasoning settings.
- **Automatic empty-after-tool recovery** `[v1.36.0]` — if a provider returns
  an empty assistant response immediately after a tool result, the lead keeps
  the same session turn moving instead of silently ending after the tool call.
- **Provider-timeout resume for long tasks** `[v1.37.0]` — when a slow or flaky
  model endpoint exhausts its retry budget mid-task (`ReadTimeout` /
  `ConnectError`), the loop resumes the same turn from where it left off
  instead of dropping the agent after a tool call. Bounded and interrupt-aware.
  Since `[v3.0.0]` a turn's connection retries no longer run out (see below),
  so there is nothing left to resume from.
- **Network blip and disconnection resilience** `[v2.9.0]` — transient network
  drops, socket resets, TLS handshake interruptions, DNS resolution glitches,
  connection/write timeouts, and gateway errors (408, 5xx) automatically retry
  with exponential jittered backoff during LLM generation and summarization,
  while client streams automatically resume and synchronize when network
  connectivity returns. Certificate verification failures, malformed provider
  URLs, and 501/505 responses fail immediately instead of consuming the retry
  budget. On iOS and Android, where the OS suspends background sockets, every
  return to the foreground reconnects; on desktop a still-open stream is left
  alone so switching windows does not tear it down. Replay-state cleanup also
  preserves attached session streams, so long silent tool runs and turns beyond
  the replay-retention window continue delivering later output.
  Since `[v3.0.0]` a dropped connection, DNS failure, or timeout during a turn
  retries every 3–5 seconds for as long as the network is down (Stop ends it),
  so the turn picks up within seconds of the connection returning; the
  transcript keeps one retry notice that counts the attempts. Summarization,
  which cannot be stopped mid-call, gives up after 10 attempts.
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
  Injected queued messages are excluded from pre-promotion LLM windows and pruned from pending state on session reload so they never resurrect in the queue UI `[v2.12.0]`.
  Mid-turn injection preserves attachment path hints and message identity, matching
  reloaded history `[v2.13.0]`.
- **`provider_status` SSE events in stream** `[v1.17.0]` — retry, exhaustion,
  and fallback transitions surface live in single-agent and split-pane views.
- **Automatic provider quota-exhaustion wait and resume** `[v2.20.0, updated v2.22.0]` — when an
  OAuth provider (such as Codex, GitHub Copilot, or Grok) or any configured
  model hits rate-limiting or quota exhaustion with a known reset window
  (detected via headers, JSON metadata, body text phrasing, or live usage API
  lookup), the agent does not abort or fail. It transitions to an
  interruptible quota-wait state, emits live `waiting_quota` status events,
  displays a minute-updating countdown in the transcript, restores an active
  countdown after a browser page reload, and automatically resumes work once
  the window resets. The user can manually stop or interrupt at any time.
- **Actionable provider HTTP errors** `[v1.56.0]` — non-retryable provider
  responses (400/401/403/404/422) are classified into typed errors that carry
  the provider's own explanation instead of a bare status code. 401/403 render
  the "configure / reconnect provider" banner; 400-class errors surface the
  specific reason (bad model, unsupported parameter, context too long) in the
  error event and agent notification. Exhausted connection/timeout failures
  likewise become a typed `ProviderConnectionError` naming the transport error
  and pointing at the provider's base URL.
- **Stop cancels the whole active session run** `[v1.101.1]` — Stop directly
  cancels the agent, in-flight model/tool work, direct shell
  commands, and session-owned background shell processes before the request
  returns. Queued and late mailbox work cannot restart the stopped turn.
  A tool that was still running keeps the output it had streamed, followed by
  "Cancelled by user after N seconds.", both in its card and in what the
  agent sees next turn `[v3.0.0]`.
- **Stop pauses queued follow-ups instead of dropping them** `[v1.17.0]` — Stop
  releases queued hidden user messages into visible history so you can
  `/undo`, edit, or append before resuming.
- **Session-level model + thinking-level override** `[v1.16.0, v1.66.1, v1.79.0, v1.104.3, v1.125.0, v1.126.1]` — override the
  agent's model and thinking level for the current chat. The thinking
  picker uses each model's advertised reasoning levels when registry metadata is
  available, and history keeps the model used for each user turn. Codex keeps
  the configured thinking level across provider reconstruction and streams
  readable reasoning summaries on supported models.
  Selections apply immediately (no Apply step); a half-typed or emptied model
  field is never committed `[v1.125.0]`. To fall back to the agent's default,
  pick it from the model list like any other model — the dedicated
  `Use agent default` reset button was removed `[v1.126.1]`.
- **Coding agent profile** `[since v1.0, updated v2.1.0]` — `agents/code.md` is the
 root profile tuned for workspace-aware coding sessions.
- **Built-in first-party agent profile** `[v1.23.0, v1.118.0, v2.14.0]` — the default `code`
 agent keeps its core prompts, tools, and descriptions versioned in code; generated/user
 `.md` files remain lightweight extension points for model knobs, thinking levels,
 and extra capabilities, while custom instructions are maintained in global and
 repository `AGENTS.md` files.
- **Automatic first-run materialization** `[v1.37.0, v1.118.0]` — application
 startup creates missing first-party agent profile and editable runtime
 configuration directly from code. No separate initialization command or
 downloaded template bundle is required, and existing user files are preserved.

---

## 3. The coding workspace

The coding workspace (`/`) opens a local project folder and runs a workspace-aware
agent against it.

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
  Since `[v3.1.0]` these actions live in the repository's checkout menu (see
  **Compact coding sidebar**), where **New worktree…**, **Rename** and
  **Remove** act on the worktree the list is narrowed to.
- **Warm-paper workspace refresh** `[v1.74.0]` — coding panels, chat-adjacent
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
  - **Review dock tabs and maximize** `[v3.0.0]` — a changed file's diff or a
    commit opens as a full-height tab next to file and terminal tabs, from the
    row's hover action or its right-click / long-press menu. The Git tab has one
    **Changes / History** toolbar with an expand-all toggle; History lists
    commits, and its **Graph** option swaps in the branch graph (with **All
    branches**). The dock's actions are New terminal, Refresh and Maximize;
    files are searched with Quick Open (`Ctrl/⌘+P`). On desktop,
    `Ctrl/⌘+Shift+D`, the dock's maximize button or **Maximize Review Dock** in
    the palette gives the dock the full width over the chat; the conversation
    stays loaded underneath. Tabs close with ×, middle-click or `Ctrl/⌘+W`, and
    focus moves to the neighbouring tab.
  - **Movable dock tabs and Git on demand** `[v3.5.0]` — the dock works like
    an editor's tab bar.
    - A new dock opens empty, on a launcher with Git, Terminal, Preview and
      Open File. Git is an ordinary tab you can close and move; it opens from
      the status-bar branch, `⌘⇧G` / `Ctrl+Shift+G`, **Open Git** in the
      palette, or the launcher. `⌘D` is **Toggle Review Dock**, and `⌘W` on
      the empty launcher closes the dock.
    - New tabs open right after the active one. Drag a tab to move it, or
      use `⌥⇧←/→` (`Alt+Shift+←/→`) or **Move Left / Move Right** in its menu.
      A dragged tab lifts and follows the pointer while the others slide
      aside to show where it lands; it drops on release, and Escape puts it
      back `[v3.6.0]`.
      Closing the active tab activates its right neighbour.
    - `⌘1`–`⌘8` pick a tab and `⌘9` the last; `⌃Tab` / `⌃⇧Tab` step through
      them, also from the terminal. In a browser, which keeps these keys for
      its own tabs, they work in the desktop app only.
    - Right-click or Shift+F10 on a tab: **Close**, **Close Others**, **Close
      to the Right**, **Copy Path**; closing running terminals asks first.
  - **Tasks and Scheduled tasks in the dock** `[v3.0.0]` — on desktop with a
    workspace open, the header's task-list button (`Ctrl/⌘+T`) and **Scheduled
    Tasks** in the palette or the sidebar's Scheduled section open the agent's task list and the
    scheduled-task list (every workspace, with search, details, and **New
    task**) as dock tabs. Pressing the shortcut again while that tab is focused
    hides the dock; the header's review-dock button shows and hides it. On
    phones with a workspace, scheduled tasks open as a tab in the review sheet
    too, while the task list stays a popover so the chat remains visible.
    Hiding the dock keeps it as it was: reopening shows the same tabs with the
    last active one focused (not the Git tab), and preview pages, their unsent
    comments and scroll positions are still there, for as long as the app
    stays open `[v3.5.0]`.
  - **Web preview and design comments in the dock** `[v3.3.0]` — **New
    preview** in the dock's actions, **Open Preview** in the palette, or the
    globe on an HTML file tab opens a **Preview** tab. It shows a local dev
    server (`localhost`, `127.0.0.1` or `::1`) or a workspace HTML file, with
    back, forward, reload, an address bar, **Responsive / Mobile / Tablet /
    Desktop** sizes with rotate, a console with an error count, and **Open in
    browser**. The page runs through a proxy on its own loopback port, so it
    cannot read the app's storage or access key, and dev-server hot reload
    keeps working. File previews reload when the workspace files change.
    **⌘W** / **Ctrl+W** closes the Preview tab, also while the page has focus.
    **Design** (or **⌥C** / **Alt+C**, also while the page has focus) turns on
    an element picker: click an element, write a comment, and a numbered pin
    stays on the page; picking stays on for the next element. Comments can be
    edited in the list. **Send to agent** attaches the comments to the
    composer as one **Design feedback** chip; add your own instruction and
    send. The chip's **×** puts the comments back in the Preview tab's list.
    The agent gets each element's selector, text, opening tag and key styles
    and, for React (18 and 19), Vue or Svelte dev builds, 30 lines of its
    source, attached like an `@path#Lx-Ly` mention. React 19 sources come
    from where the JSX ran, mapped through the dev server's source maps.
    In the chat the feedback shows as a card of numbered comments, and
    restoring the message (undo, edit, history) brings the chip back. The card
    also shows after a reload, with or without text before it `[v3.6.0]`.
    While the agent uses the page, the toolbar shows **Agent**.
    Tabs keep their page and comments while another tab is open. Previews
    need the backend on the same computer; remote servers and the mobile app
    show a notice instead.
- **Keyboard and touch access** `[v3.0.0]` — right-click menus (dock rows,
  terminal tabs, sidebar sessions and workspaces, scheduled tasks, provider
  models) take keyboard focus when they open. Arrow keys, Home and End move
  through the items, and Escape closes the menu without closing the panel
  around it, then returns focus. On touch screens, list rows and row actions
  grow to 44px tap targets, and text never renders below 11px.
- **Desktop workbench layout** `[v3.0.0]` — the desktop coding view is split into
  a header with a command center (**Search or run a command**, `Ctrl/⌘+K`), the
  sidebar, the chat, the review dock and a status bar. The status bar shows
  the connected backend and its health, the branch with
  commits to push/pull and uncommitted changes (a click opens the review dock),
  the session model, and the last 24 hours of spend (a click opens Telemetry on
  that range); scheduled tasks and the theme moved to the sidebar, the palette
  and Settings. In light mode the header, sidebar, status bar and chat share
  one page tone; dark mode sets the chrome on a darker rail. The sidebar opens expanded on windows at least 1280px
  wide and resizes between 220 and 440px. The dock takes a share of the chat
  area and always leaves the chat at least 400px; on narrower windows it opens
  over the chat instead. Both dividers resize by drag or keyboard (arrow keys,
  Home/End, Enter to reset), and the layout is remembered.
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
  the Load more button. Since `[v3.0.0]` the sidebar has a **Workspaces** header with
  collapse-all and **Open folder** actions, workspace rows with chevrons and indent guides,
  a **…** actions menu on worktrees, 28px session rows showing a compact age that swaps to
  edit/delete on hover, and a **Show more** button instead of scroll-triggered loading.
  Since `[v3.1.0]` the sidebar is one level deep: worktrees are no longer rows.
  A repository lists the sessions of its own checkout and every worktree as one
  list, newest first, and a worktree's sessions carry its name as a tag. A
  chip on the repository row (the branch icon and the worktree count) opens
  its checkout menu: **All checkouts**, **Main worktree**, or one worktree
  narrows the list, **+** then starts sessions in that checkout, and a row
  above the sessions names the filter with a **Show all** button. Opening a
  session the filter hides shows every checkout again.
- **Nested subagent sessions in the coding sidebar** `[v2.16.0, updated v2.17.0]` — lead sessions with
  delegated subagents render an expandable accordion of child sessions that defaults to
  expanded while a child is running, waiting on the lead, or selected, and collapses to a
  count pill with an activity dot so background work stays visible. Individual child rows
  can be deleted from the sidebar with instant cache pruning `[v2.17.0]`, falling back cleanly to the
  parent lead session, and opening one shows a read-only banner with a
  **Return to Lead** action.
  Since `[v3.1.0]` the count pill beside the title is the toggle, so sessions
  without subagents keep no chevron gutter, and child rows sit flat under the
  lead's title without another indent guide.
- **Rename sessions in place** `[v3.0.0]` — the pencil, a double-click on a
  sidebar row, **Edit title** in its menu, or a click on the session title in
  the desktop header turns the title into a text field. Enter or clicking away
  saves, Escape cancels, and the header and sidebar show the new title at once.
- **Session search** `[v3.0.0]` — the search button in the Workspaces header,
  or `⌘F` / `Ctrl+F` while focus is in the sidebar, swaps the tree for a search
  field that matches session titles across every workspace, however old. Enter
  opens the first match and Escape returns to the tree. `⌘F` anywhere else
  still finds text in the transcript.
- **Session status and unread marks in the sidebar** `[v3.0.0]` — each session
  row has one status slot: `!` while it waits for your answer, a spinner while
  it runs, and an accent dot when a turn ended while you were in another
  session or the window was hidden. Opening the session clears the dot in every
  window. Unread state stays on this device, and sessions that finish while the
  app is closed are not marked.
- **Needs you** `[v3.0.0]` — sessions stopped on a question are listed above
  the workspaces, from every workspace and however old, each with its
  workspace name and a count. The list updates as questions are asked and
  answered, and a click opens the session. The same count badges the app icon
  in the dock (macOS and Linux) and on iOS once notifications are allowed,
  and prefixes the browser tab title, e.g.
  `(2) Fix updater restart`.
- **Scheduled in the sidebar** `[v3.0.0]` — the bottom of the coding sidebar
  lists the next five enabled scheduled tasks, soonest first, each with its next
  run time (`18:05`, `Wed 09:00`, or `20/03`). Clicking a task opens the
  scheduler on that task, and clicking the **Scheduled** header opens the full
  list. The section is hidden when nothing is scheduled.
- **Anchored & regex-optimized filesystem search** `[v2.0.0]` — `glob` pattern matching
  anchors walks at the literal prefix (up to 50x faster), `grep` pre-filters files using
  literal scanning and streams matches asynchronously off the main loop, and non-ignored
  paths are filtered using a compiled union regex.
- **Non-blocking asynchronous file I/O & atomic patch operations** `[v2.0.0]` — file
  reads, directory scans, and patch applications run off the asyncio event loop with
  per-path lock protection, preventing UI latency during large multi-file operations;
  multi-file envelopes stage their changes and guard against intervening edits.
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
- **Persisted coding sessions per workspace** `[v1.18.0]` — `/{session_id}`
  (`/coding/{session_id}` before v3.0.0) restores workspace context from the
  saved session. Bare `/` is the launcher or last-workspace restore. New empty sessions exist before the
  first message.
- **Workspace sidebar pagination** `[v1.18.0]` — each main/worktree list shows
  roughly 5 sessions and loads more on request (**Show more** since `[v3.0.0]`,
  previously on scroll), so one busy workspace doesn't crowd the others. Since
  `[v3.1.0]` a repository and its worktrees page as one list.
- **Remove a workspace from the sidebar** `[v1.42.0, updated v3.0.0]` — a
  repository's **Remove from sidebar** action hides it and its worktrees
  without deleting anything; its sessions stay, and reopening the folder lists
  it again. Since `[v3.0.0]` the row leaves the sidebar at once, a reopened
  folder reappears at once, and removing the open workspace returns to the
  launcher instead of reopening it.
- **`@file` / `@folder` auto-attach** `[v1.17.0]` — see [§1](#1-the-desktop-coding-workspace).
- **Slash commands scoped to coding workspaces** `[v1.17.0]` — project-local
  commands in `.openagentd/commands/**/*.md`, universal `.agents/commands/**/*.md` `[v2.12.0]`, and `.opencode/commands/**/*.md`
  load only when a workspace is attached. Local commands win on name conflict.
  Coding chat stays global-only.
- **Snippet picker** `[v1.31.0]` — in coding workspaces, type `#` anywhere
  in the composer to pick prompt snippets from `.openagentd/snippets/**/*.md`
  or `{OPENAGENTD_CONFIG_DIR}/snippets/**/*.md` (plus universal `.agents/snippets/**/*.md` and `~/.agents/snippets/**/*.md` `[v2.12.0]`) and insert the rendered body.
- **Git-backed `/undo` and `/redo`** `[v1.11.0]` — restore workspace files
  (created, modified, deleted) to the exact prior state from any prior turn in
  chat history. Different from editor undo: this is tied to chat turns.
  `/redo` restores one undone turn; `/redo-all` `[v2.0.0]` restores all undone turns back
  to the live tip. Undoing turns now declaratively preserves and restores input composer
  draft text and synchronizes cache invalidation across open windows `[v2.8.0]`.
  Direct and queued turns capture their starting workspace state; sending a new
  message after undo replaces the undone branch without losing the new message,
  and repeated undo can traverse context restored by undoing compaction `[v2.13.0]`.
  Snapshots support relative `OPENAGENTD_STATE_DIR` paths. Delayed undo, redo,
  compaction, and stop responses cannot overwrite another session after navigation;
  failed or stale redo commands preserve composer drafts `[v2.13.0]`.
  Commands without an available boundary or with failed workspace restores return 409
  and preserve database state `[v2.13.0]`.
  Snapshot repos borrow the workspace repository's object store, so committed
  content is stored once, and every snapshot is anchored by a ref so background
  repacking never drops a live undo point. A per-session size cap
  (`SNAPSHOT_MAX_BYTES`, default 256 MiB) drops the oldest snapshots once a repo
  outgrows it; `SNAPSHOT_SEED_OBJECTS=false` disables object reuse `[v2.18.0]`.
- **`/init` AGENTS.md analysis & generation** `[v1.9.0, v2.0.0]` — analyzes codebase
  structure and generates standard `AGENTS.md` context files at repository root and
  subdirectories with a guided analysis protocol.
- **Consolidated filesystem toolset** `[v2.0.0]` — the agent now sees two
  filesystem tools instead of six. `read` handles files *and* directory
  listings, and `patch` is the single way to create, edit, delete, or move a
  file. `write`, `edit`, `ls`, and `rm` are removed, as is `date` (the current
  date is already injected into the system prompt every turn). Fewer
  overlapping schemas means fewer tokens per request and no ambiguity about
  which tool to reach for when changing a file. Two consequences worth
  knowing: recursive directory deletion is now a `shell` command, and patches
  are matched conservatively — exact context is preferred, with narrow repairs
  for trailing whitespace, copied line numbers, and uniform indentation; unchanged
  context bytes are preserved.
  Agent `.md` files that still list a removed tool are cleaned up
  automatically the first time they load.
- **Inline patch tool for multi-file edits** `[v1.5.0, v2.0.0]` — structured patches
  with multiple hunks, real line numbers, collapsible previews. The `patch`
  tool accepts a `*** Begin Patch` / `*** End Patch` envelope with
  `*** Add File:`, `*** Update File:`, `*** Delete File:`, and `*** Move to:`
  operations; the full format spec is embedded in the tool's schema so the
  LLM always has it in context. Hardened against LLM formatting variance:
  accepts alternate parameter names, extracts envelopes embedded in markdown
  code blocks or surrounding commentary, and falls back to line-aligned fuzzy
  context matching when whitespace doesn't match exactly, without
  mis-patching an earlier occurrence of the same text or rewriting file line
  endings `[v1.120.0]`. An update section that would change nothing — no
  hunk line marked `-` or `+`, so every line reads as unchanged context — is
  rejected with guidance instead of reporting success without writing,
  which previously sent the agent into a silent retry loop `[v2.0.0]`.
  A hunk can narrow its search after a unique literal line with
  `@@ in: <anchor>`; ambiguous or missing anchors, and ambiguous targets
  within that scope, are rejected rather than selecting a match `[v2.5.0]`.
  Contextual `@@ class ...` / `@@ def ...` headers and context-only sequential
  locators are supported. Add and move collisions are rejected,
  while delete-then-add replacement is supported within one envelope.
  The activity header lists the comma-separated,
  deduplicated basenames of every touched file instead of collapsing
  multi-file patches into a bare count `[v1.120.0]`, with operation-aware header labels (`Create`, `Update`, `Move`, `Delete`), color-coded action badges, per-file line delta counters, and multi-file expand/collapse controls `[v2.0.0]`.
- **Interactive terminal tab** `[v1.98.1]` — a real PTY shell (backend
  `subprocess.Popen` + `pty.openpty()`, streamed over WebSocket to an
  xterm.js instance) attached to the coding workspace panel, alongside
  Changes/Commits/file tabs. Coding-mode only — there is no separate general-chat mode
  terminal. The session survives tab switches (detached PTYs idle-close
  after 15 minutes of no input; the backend reaper is the 30-minute
  backstop). A terminal with a command still running (a dev server, a
  build) is never idle-closed, by either reaper, on macOS and Linux `[v3.5.0]`.
  Includes PTY output backpressure, GPU-accelerated WebGL rendering `[v1.118.0]`,
  debounced SIGWINCH resizing, and mobile key bar ergonomics (touch-and-hold arrow repeat,
  soft-keyboard focus preservation, quick symbol row).
  Terminal font defaults to a best-guess Nerd Font stack
  (MesloLGS NF and similar) for correct Powerlevel10k/Starship glyph rendering.
  App shortcuts work from a focused terminal: on macOS every `⌘` shortcut,
  including `⌘K` for the palette and `⌘F` for transcript find, and on
  Windows/Linux `Ctrl+K` and `Ctrl+P` skip the shell to open the palette and
  quick open. **Clear** in the terminal tab's menu clears the scrollback
  `[v3.5.0]`.
  **Rename** edits the tab's title in place instead of opening a dialog;
  `F2` or a double-click on the tab starts it, Enter or clicking away saves
  and Escape cancels `[v3.6.0]`.
  `⌘W` on a terminal whose shell is still running asks before closing it; the
  tab's close button still closes right away `[v3.3.0]`, unless a command is
  running in it, which asks first too `[v3.5.0]`.
- **Workspace status card** `[v1.18.0]` — empty coding sessions show the
  workspace path, branch, dirty state, last commit instead of the old
  agent-selection fallback. Since `[v3.0.0]` the card shows the workspace
  name and path, then its recent sessions by last activity (status, title,
  age) to reopen with a click; the branch and changes moved to the header.
- **Sessions ≥ 100 messages load completely with scroll preserved** `[v1.9.0]`.

---

## 4. Memory and context

OpenAgentd carries context across sessions via rolling-window summarization.

- **Persistent Markdown memory subsystem** `[v2.22.0]` — file-backed persistent knowledge
  in global (`{OPENAGENTD_CONFIG_DIR}/memory/`) storing authoritative human-editable `.md` pages.
  Dynamically compiles a bounded
  XML catalog (`<openagentd_memory>`) capped at 3,000 rendered characters (up from 1,500 `[v3.3.0]`) into
  `state.system_prompt` during `before_agent` (0 filesystem I/O across model turns),
  pins `preferences.md` directives (<= 1,500 chars, up from 400 `[v3.3.0]`), synchronizes concurrent edits with reference-counted
  path locks and quoted strong SHA-256 ETags (HTTP 412/428), provides `/memory` slash
  commands, and exposes a Settings viewer/editor with conflict resolution and deterministic
  wikilink linting.
- **Proactive memory about the user** `[v3.3.0]` — the lead agent saves stated
  preferences, corrections, and durable facts about the user (to `preferences.md`,
  `user.md`, or topic pages) in the same turn without asking, and says what it saved.
  Delegated agents read memory but do not write it.
- **Runtime protocol for every agent** `[v3.3.0]` — rules for instruction sources,
  secrets, workspace and git safety, and memory are added by the runtime, so agents
  with a custom prompt in their agent file get them too.
- **`/compact` rolling-window summarization** `[v1.5.0, v2.7.0]` — compresses old turns
  into a single summary message kept in context; UI shows the unabridged
  conversation. Preserves reasoning and loaded skill/tool context; skill
  Auto-compaction default threshold is raised to 90% of model context `[v2.7.0]`.
  instruction tool-call pairs remain active after repeated compaction while the
  summarizer keeps the same cacheable prompt prefix as normal chat turns.
  Changing the trigger in Settings → Automation applies from the next model
  call, including inside a turn that is already running `[v3.3.0]`.
- **`AGENTS.md` at repo root and subfolders** `[v1.9.0]` — written by `/init`;
  standard repo- and folder-scoped agent context files.
- **Global `AGENTS.md`** `[v2.10.0]` — a developer-wide instructions file at
  `{config dir}/AGENTS.md` (`~/.config/openagentd/AGENTS.md` in production) is
  injected into every coding turn ahead of the workspace file, so cross-project
  preferences live in one place. Matches how pi, OpenCode, and Codex order
  global → project guidance.
- **Host environment in the shell tool** `[v2.10.0]` — the shell tool schema
  states the OS, CPU architecture, and shell binary the command runs under
  (e.g. `Darwin arm64, shell=zsh`), so the model stops guessing platform
  commands. Static facts only, keeping the tool schema prompt-cache stable.
- **Truncation markers name the omitted amount** `[v2.10.0]` — shell output
  keeps half head / half tail and the marker now reads
  `...output truncated (N lines omitted)...`, so the model can judge whether
  the spilled full output is worth reading.
- **One backend-connection rulebook for desktop and mobile** `[v2.10.0]` —
  server URL normalization, the saved-servers file, keyring access keys, and
  download limits now come from one shared native crate. Mobile gains the
  desktop behaviours it lacked: a pasted `http://host:4082/api` connects
  instead of probing `/api/api/health/live`, and removing a server matches
  entries saved with a trailing slash or `/api`. Desktop gains mobile's
  fallback to the default "Local CLI server" entry when the list empties.
- **Workspace root injected into coding-mode system prompt** `[v1.133.0]` —
  coding agents are told their workspace's absolute
  path unconditionally, not only when an `AGENTS.md` happens to
  exist.
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
| OpenCode Zen | `opencode:claude-sonnet-4-6` | `OPENCODE_ZEN_API_KEY` `[v1.124.0]` |
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

- **Keyless first-run model** `[v1.124.0]` *(deprecated — removed)* — previously
  defaulted new installations to OpenCode Zen free models; removed because
  OpenCode free models only open within OpenCode's own harness. OpenCode Zen
  now requires `OPENCODE_ZEN_API_KEY`.
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
- **Pure-Python SigV4 AWS Bedrock token generator** `[v2.0.0]` — replaces `botocore`
  with a pure-Python SigV4 token generator, dropping AWS bundle strip overhead and
  runtime memory footprint.
- **Anthropic-compatible custom endpoints** `[v1.16.0]` — providers needing
  custom headers or alternate message endpoints are supported.
- **Anthropic prompt caching + full input accounting** `[v1.66.0]` — Claude
  requests now place explicit `cache_control: {type: "ephemeral"}` markers on
  the system block and latest cacheable turn block, matching Anthropic's
  breakpoint model instead of marking every block. Stored/model usage now counts
  total prompt input as cold + cache-read + cache-write tokens while preserving
  cached reads as a separate metric. Cache-write tokens are billed at the
  registry's `cache_write` rate — 1.25x input on Claude models — instead of the
   plain input rate `[v1.132.0]`.
- **Budget-based thinking metadata synthesis** `[v1.83.0]` — models whose
  registry metadata exposes raw `budget_tokens` reasoning support but no named
  effort levels now surface standard `none/low/medium/high` thinking choices in
  Settings, with Anthropic runtime mapping those levels to proportional token
  budgets.
- **`openagentd://` deep links and OAuth callback handoff** `[v1.116.0]` — system protocol registration for desktop and mobile apps, with cold- and warm-start routing. Navigation links (`openagentd://cockpit/...`, `openagentd://coding/...`) open the requested session. OAuth providers that implement a callback exchange can use `openagentd://auth/callback?provider=...&code=...`; OpenAgentd validates the link shape and forwards the opaque callback payload to the active backend, while the provider remains responsible for state and PKCE verification. Isolated desktop development bundles and physical-device iOS development builds use `openagentd-dev://` so they do not claim the production protocol.
- **OAuth subscription support** `[v1.8.0]` — Copilot, Codex, others via the
  built-in OAuth helper. Codex models automatically prioritize extended context
  window limits (up to 872k/1M tokens) where supported by the catalog
  `[v2.8.0]`.
- **Grok Build subscription provider** `[v1.112.0]` — `grok:` uses xAI's
  device OAuth flow and refreshable session credentials independently of the
  direct API-key-backed `xai:` provider, with live model discovery and the
  Grok Build proxy's required model-routing headers. Grok billing usage is
  available in Settings, the native usage tray, and the manual provider smoke
  script; billing periods with no measurable allowance stay period-only and
  zero values are not treated as unlimited.
- **Codex usage monitor** `[v1.32.0, v1.131.0, v1.131.1]` — Settings → Providers shows live Codex
  OAuth usage windows, resets, credits, unlimited plans, and spend-cap/limit states.
  Workspace spend caps report used/limit/remaining amounts and a reset time — the only
  usage signal once a cap is reached and Codex stops returning rate-limit windows — and
  a reached cap drives the panel copy instead of the credits flag `[v1.131.0]`. The
  desktop tray's "Usage Limits" submenu renders the same cap `[v1.131.1]`.
- **Priority / Fast mode** `[v1.90.0, v1.92.0]` *(deprecated)* — opt new messages into Fast/Priority mode. Supported on models and providers that implement service/latency tiers (Anthropic maps to `auto`, Google Gemini maps to `priority`, OpenAI maps to `auto`, and ChatGPT Codex maps to `priority`). Availability is driven by a `supports_fast_mode` registry flag instead of a hard-coded provider-prefix list, so plugin providers can opt in without frontend changes `[v1.92.0]`. The web Session Settings control was removed in `v1.125.0`; the session field, API parameter, and provider mapping still work, so sessions that set it elsewhere (TUI, API) are unaffected.
- **Hide / show a provider** `[v1.92.0]` — Settings → Providers lets you
  temporarily hide a configured provider's models (**Hide** / **Show** in header); its models disappear from
  every picker and the warm-cache loop skips it, while saved credentials stay
  on disk and **Show** restores them. Connected OAuth providers also offer **Disconnect** in the card body (`DELETE /api/auth/{provider}`) to delete saved OAuth account tokens from disk and log out.
  A provider that loses its connection (API key deleted, OAuth session revoked or
  refresh rejected) drops its cached model list and saved visible-model selection,
  so pickers stop offering models the provider can no longer serve; connected
  providers keep both — an expired access token is refreshed, not a disconnection.
- **Copilot usage monitor** `[v1.33.0]` — Settings → Providers shows live Copilot
  premium request quota from the saved OAuth token. Token-based / pooled-credit
  seats skip a fake 0% quota window and show used credits as `N/∞` in Settings
  and the usage tray instead of "unlimited" `[v2.23.0]`.
- **API key provider usage and credit monitor** `[v2.3.0]` — Settings → Providers shows live credit balances, key spend caps, and quota limits for configured API key providers (such as OpenRouter and DeepSeek) alongside OAuth providers.
- **Provider plugin usage hooks** `[v1.33.0]` — OAuth provider plugins can
  surface live usage in the same Settings → Providers panel as built-ins.
- **Provider-scoped visible models and pricing** `[v1.57.0, v1.63.0, v2.9.0]` — Settings → Providers lets
  users choose which provider models appear in normal model pickers. Session
  settings and other pickers read a cached provider model list for instant
  open; when the cache is empty, `/api/agents/registry` warms configured
  providers' caches on demand, and **List models** remains the per-provider
  manual refresh / verification action — available whenever credentials are
   already saved, without retyping a secret the UI never echoes back
   `[v1.132.0]`. A model the provider no longer serves is pruned from both the
   cached list and the saved visible selection on the next refresh, and is dropped
   immediately when a chat attempt comes back with a model-not-available error, so
   retired model ids (for example a withdrawn DeepSeek preview) stop being
   selectable. The providers page now includes a
  search plus status/kind filter bar for quickly narrowing long provider lists
  `[v1.74.0]`. Each model row in the listing displays its per-token pricing (USD per 1M tokens
  input/output or `Free` badge) with tooltip breakdowns including cache read/write rates `[v2.9.0]`.
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
| Filesystem | `read` (files + directory listings), `patch` (create/edit/delete/move), `glob`, `grep` |
| Shell | `shell` (supports `background=true` returning spawned PID `[v2.0.0]`; read-only in Plan mode `[v2.17.0]`) |
| Web | `web_search`, `web_fetch` (fast HTML extraction via `trafilatura` `[v2.0.0]`) |
| Generation | `generate_image`, `generate_video` |
| Scheduling | `schedule_task` (reminders + self-scheduling agentic loops) `[v1.70.0]` |
| Tasks | `todo_manage` |
| Team orchestration | `delegate` (lead agent) `[v2.16.0]` |
| Subagent communication | `ask_lead` (subagents) `[v2.16.0]` |
| Ask the user | `ask_user` (coding agent) `[v1.131.0, v2.1.0]` |
| Web preview | `preview` (coding agent with a workspace) `[v3.3.0]` |
| Utility | `skill` |

- **`preview` — show a page, read its console, and use it** `[v3.3.0]` — the agent
  opens a running local dev server or a workspace HTML file in your Preview
  tab (it comes forward on desktop, and the tool card has **Open preview**).
  It then reads that page's recent console errors, warnings and logs, newest
  first, and can clear them to see only new output after a fix. It can also
  use the open page: a **snapshot** lists headings, text and controls with
  refs (`e1`, `e2`, …), and it can **click**, **fill** fields, **press**
  keys, **scroll**, **navigate**, **wait** for text, and **inspect** an
  element's source, styles and HTML. Acted-on elements flash in the page.
  A cursor in the page glides to each element it acts on, labeled with what
  it is doing (*Clicking*, *Typing*), so you can follow along `[v3.5.0]`.
  It can **chain** up to 20 of these actions in one call, such as filling a
  form, submitting it and taking a snapshot, stopping at the first step that
  fails `[v3.5.0]`. Session settings list `preview` among the agent's tools
  in coding workspaces `[v3.5.0]`.
  Only loopback URLs are accepted, never the OpenAgentd API port. Everything
  works only while the page is open in the Preview tab; there is no headless
  browser and no screenshots.
- **`ask_user` — durable suspend and resume** `[v1.131.0, v2.1.0]` — in
  **coding mode** `[v2.1.0]`, the agent can stop mid-turn and ask you 1–4 questions rather
  than guessing on a decision that would cost real work to undo. Each question
  carries up to 5 options with optional descriptions, single- or multi-select,
  a "Recommended" badge on the agent's preferred choice, and a free-text
  answer. **Type your own answer** is on every question `[v3.4.0]`; the agent
  can no longer turn it off. Multi-question cards are stepped through one at a time —
  **Back** replaces **Dismiss** past the first question — and the whole set is
  submitted together at the end. The card renders **inline in the transcript**, in place of
  the tool call that raised it, with exactly two states: waiting (the questions
  and their suggested answers) and resolved (your answer, or the dismissal).
  The suspension is **durable, not in-memory**: the pending question and the
  interrupted tool call live in the database, so the turn survives an app
  reload, a daemon restart, and a switch to another device, then resumes from
  exactly where it stopped. Answering, dismissing, or simply typing something
  else are the only ways to move it — there is no timeout. Members keep working
  throughout and are never interrupted by an answer. Turns support multiple
  questions across suspensions `[v2.10.0]`;
  scheduled sessions never get the tool, because a cron job has nobody to ask.
  Failed scheduled tasks remain eligible to retry until their run limit is met `[v2.13.0]`.
- **Resilient web search Exa fallback** `[v2.21.0]` — `web_search` uses `web_search_exa`
  with Server-Sent Events (SSE) stream parsing and normalized result structures
  when DDGS search backends are unreachable or return no results.
- **Search usage guidance** `[v2.21.0]` — `web_search` instructions guide agents to
  write focused queries, fetch known URLs directly, evaluate primary sources,
  and report uncertainty when search results cannot be verified.
- **Fast HTML & document extraction** `[v2.0.0]` — `web_fetch` uses `trafilatura` for
  clean HTML-to-markdown extraction, and `read` uses `anydoc` for robust document
  conversion, dropping `markitdown`.
- **Safe, bounded web fetching** `[v2.9.0]` — `web_fetch` streams responses under
  a 50 MB limit, validates every redirect against public-network policy, reports
  concise typed HTTP/network/conversion failures, and supports distinct Markdown,
  text, HTML-source, and raw-text output modes. Destinations that resolve to
  loopback, private, or link-local addresses are refused unless
  `WEB_FETCH_ALLOW_PRIVATE_NETWORK=true` is set, which lets the agent reach local
  dev servers and trusted internal hosts. The check is enforced at connect time
  and the socket is pinned to the validated address, so a DNS answer cannot
  change between validation and connection. Repeated fetches reuse one pooled
  HTTP client that is closed on server shutdown.
- **Anti-bot block detection** `[v3.2.0]` — when a page is blocked by
  anti-bot protection (Cloudflare, DataDome, PerimeterX, Reddit, Vercel, AWS
  WAF), `web_fetch` returns a clear "Browser verification required" error
  that names the vendor, instead of the interstitial's text.
- **50k character read limit** `[v2.0.0]` — expanded `read` tool context limit to
  50,000 characters for reviewing larger source files in a single pass.
- **Symbol outline mode for `read` tool** `[v2.4.0]` — `read` supports `outline=True`
  to return high-level symbol outlines (classes, methods, functions, interfaces, types,
  and markdown headers) with exact 1-based line numbers across Python, TypeScript/JavaScript,
  Rust, Go, and Markdown files, enabling rapid codebase exploration before targeted pagination.

- **Real-time LSP diagnostics injection** `[v1.89.0, v1.105.0, v2.0.0]` — in **coding mode**, after the
  `patch` tool modifies one or more files, OpenAgentd runs the
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
  only one type checker runs, `ty` when it starts, else `pyright`, else `pylsp`
  `[v3.5.0]`;
  `ruff`/`ty` are **not bundled** with the runtime: when a project pins them (or
  declares them bare), the backend silently downloads the checksum-verified
  wheel for the project's exact `==` pin (PyPI latest for ranges) into the user
  cache (`{cache}/lsp/python/{tool}-{version}/`), so the desktop sidecar stays
  ~22 MB lighter; a failed or disabled install degrades to `pyright`/`pylsp`.
  every other language uses its single canonical server (`gopls`,
  `typescript-language-server`, `clangd`). Multi-file `patch` checks run
  concurrently, the report is capped per file (errors first, then a `…and N more`
  summary) to protect the context window, and the whole hook is fail-safe — an LSP
  error never crashes the tool. The coding workspace renders the block as a compact,
  color-coded `ERR`/`WARN` strip beneath the diff. Diagnostics depend on the server
  being available and on normal LSP scope rules (e.g. TypeScript honours `tsconfig.json`).
  Pinned `ty` + `ruff` now ship with the Python runtime, while TypeScript is a
  consented, on-demand backend component with a verified Bun download, locked
  npm packages, a cross-surface install prompt (styled as a floating, non-blocking, draggable and minimizable notification card `[v2.12.0]`), and `openagentd lsp` status/install
  commands. Managed tools live under the regeneratable cache and do not modify
  the user's project.
- **Semantic LSP navigation** `[v1.133.0]` — coding agents can find definitions,
  references, document symbols, and workspace symbols through the language server,
  using compact workspace-relative results instead of text search for code navigation.
  Results include a readable symbol kind (`Widget (class)`, `run (function)`) when the
  language server reports one; a file's own symbols list in source order (top-to-bottom),
  while cross-file results (references, workspace-wide symbol search) stay alphabetically
  sorted for determinism across multiple language-server clients. A `hover` operation
  returns type/signature/docstring info for a position (flattening `MarkupContent` and
  `MarkedString` shapes across servers); an optional `kind` filter narrows
  `document_symbol`/`workspace_symbol` results to one symbol kind (e.g. `function`,
  `class`, and accepting several at once, e.g. `function, method`); files with no
  mapped language server (anything outside
  `.py .ts .tsx .js .jsx .go .c .cpp .h .hpp`) get an explicit "no language server
  support" message instead of a misleading empty result. A `find_implementations`
  operation resolves interfaces, protocols, abstract classes, and overridable
  members, and `find_references` tags each hit `[definition]`/`[read]`/`[write]`
  when the server reports it. Empty results explain themselves instead of a bare
  "No results.": a cursor on whitespace, a comment, a keyword, or past the end of
  the file says so, and a position that is already the declaration reports
  "already at its definition site". Symbol resolution follows the project's own
  setup — `tsconfig.json` `paths`/`baseUrl` are forwarded to the TypeScript
  server and a project virtualenv (`.venv`/`venv`/`env`) is detected for Python,
  so aliased and site-packages imports resolve; `go_to_definition` falls back to
  `textDocument/declaration` and `textDocument/typeDefinition` when the primary
  request comes back empty. The chat UI's tool-call
  header/args display covers `hover` (position header, e.g. "Hover at path:line:col"),
  `find_implementations` ("Implementations at path:line:col"), and the `kind` filter
  (surfaced in both the `document_symbol`/`workspace_symbol` header and the expanded
  args), matching the existing per-operation formatting for
  `go_to_definition`/`find_references`/`document_symbol`/`workspace_symbol`.
  Position results (`go_to_definition`, `find_references`, `find_implementations`)
  carry the matching source line (trimmed, capped at 120 chars) next to each
  location, so an import, call, or annotation can be told apart without a
  follow-up read — the chat UI renders it as a muted second line under the path.
  `workspace_symbol` hits are tagged `[exact]`/`[prefix]` against the query and
  ranked by match quality ahead of fuzzy matches; results beyond the 50-item cap
  end with an explicit `… truncated: showing 50 of N results` note instead of
  silently disappearing. Empty results stay honest: `find_implementations` reports
  a cursor position problem (whitespace, comment, keyword, out-of-bounds) as such
  rather than claiming the symbol is not overridable, and a missing path says paths
  are workspace-relative and points at glob.
  Fixed a position-accuracy bug: the LSP client didn't advertise
  `hierarchicalDocumentSymbolSupport`, so servers (pyright, ty) fell back to
  flat `SymbolInformation` and `document_symbol`/`workspace_symbol` reported
  the start of the whole declaration (e.g. the `async`/`def` keyword) instead
  of the identifier — a position that then failed when fed into
  `go_to_definition`/`find_references`/`hover`. The client now requests
  hierarchical results and the manager prefers each symbol's
  `selectionRange` (the identifier) over its full `range`, so a
  `document_symbol` location now round-trips correctly into the other
  operations.
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
- **`.gitignore`-aware file tools** `[v1.20.1, v1.131.3, v2.0.0]` — `glob`, `grep`, and
  workspace file browsing respect `.gitignore` and skip dependency and cache
  directories. Workspace file listings (file tagging, the command palette, the
  files sidebar) come from git itself in a git work tree, so tracked files no
  longer disappear because their directory name looked generated, and the
  palette says when a listing hit its cap. Dot-directories other than `.git`
  and caches are searchable, `.env`-style secrets stay excluded, and `glob`
  understands `{ts,tsx}` brace patterns, finds bare patterns at any depth, and
  names the directory when a pattern matched one instead of dead-ending
  `[v1.131.3]`. Naming a generated directory in the pattern itself
  (`web/node_modules/@scope/pkg/**`) is treated as an explicit request and
  searched rather than silently pruned, and an anchored pattern walks only its
  own subtree — 2.6x–50x faster, and 35x on a pattern pointing into a
  dependency `[v2.0.0]`.

---

## 7. Extension surface

Four orthogonal ways to add capability.

- **MCP servers** `[since v1.0; v2.11.0]` — any Model Context Protocol server,
  hot-reloaded via `POST /api/mcp/apply`. A configured server is automatically
  available to the coding agent; agent Markdown no longer needs a per-agent MCP
  selection. OAuth-backed setup. Session Settings shows every configured server
  and can enable/disable it globally or connect OAuth-backed servers in place
  `[v1.52.2]`. Each server gets its own row showing connection state and tool count, with a
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
    and open by default so available tools are immediately visible; the name/description filter appears past eight tools `[v1.125.0]`.
  - **Multimodal image tool returns** `[v2.20.0]` — MCP tools can return image
    MIME types (`ImageContent` and image embedded resources), which are
    translated to structured `ImageDataBlock` parts for vision models while
    preserving concise textual summaries in transcripts and history.
    Images are capped at 2000 px on the long edge for every provider `[v3.5.0]`: tool
    results (including `read`) are shrunk when they arrive, and requests also
    shrink oversized images replayed from older history, so Anthropic's
    many-image limit and other providers' pixel limits always hold.
- **Sandboxed UI artifacts** `[v1.36.0]` *(beta)* — tool-produced HTML UI
- **Sandboxed UI artifacts** `[v1.36.0, updated v2.17.0]` *(beta)* — tool-produced HTML UI
  resources render as sandboxed sibling chat artifacts. The first producer is
  MCP Apps: MCP tools that declare `_meta.ui.resourceUri` can render `ui://`
  resources with MIME `text/html;profile=mcp-app`. First slice targets
  interactive Excalidraw diagrams; fullscreen now uses the full viewport with
  mobile safe-area padding, and the host exposes its own fullscreen button
  `[v1.45.2]`. If later tool results reference the same UI resource, chat shows only the
  newest artifact for that resource. The same-server bridge can invoke tools
  currently advertised by the artifact's originating MCP server only `[v1.37.0]`.
  Production desktop and mobile Tauri shells allow `about:` frames so `srcdoc`
  MCP Apps render interactively under the packaged CSP `[v1.44.11]`. The MCP app
  host runs on `@modelcontextprotocol/ext-apps` v2.0 with modular client/core architecture `[v2.17.0]`.
- **MCP `PATH` resolution on desktop** `[v1.17.x]` — desktop auto-resolves the
  shell `PATH` so `npx` / `uvx` stdio servers can find their commands. Restart
  any MCP server in Settings to re-detect.
- **Skills** `[since v1.0]` — markdown `SKILL.md` files, lazy-loaded, hot-reload
  on mtime change, token substitution. Compatible with the opencode skill spec.
  One nested namespace level (`parent/sub`) is supported `[v1.27.x]`; Settings
  lists the full runtime-visible catalog and can edit/delete non-bundled skills
  in place `[v1.27.x]`.
  - **Reference files and scripts support** `[v1.87.0, v1.92.0]` — fully compatible with the
    `agentskills.io` specification. Resolves `{SKILL_DIR}` and `${SKILL_DIR}` placeholders
    inside loaded skill instructions. Project-level skill directories resolve to clean relative
    paths (e.g. `.openagentd/skills/my-skill`), while global/bundled skill directories resolve
    to absolute paths, allowing the agent to use standard `read` and `shell` tools to access them.
    `load_skill` now always prepends a `Skill directory: <path>` line to its response so the
    agent finds bundled reference files without relying on the author adding `{SKILL_DIR}`
    tokens `[v1.92.0]`. Skill cache invalidation now also watches project-local skill roots
    (`.openagentd/skills/`, `.agents/skills/` `[v2.12.0]`, `.opencode/skills/`), not just the global config directory, so
    edits are picked up on the next `discover_skills()` call `[v1.92.0]`.
  - **Bundled `self-healing` skill with references** `[v3.3.0]` — one bundled skill covers the
    agent's own setup: its `SKILL.md` is an index linking reference files for agents, MCP servers,
    skills, plugins (with the `openagentd` plugin API typings), and image/video generation. It
    replaces the separate `skill-installer` skill. `read`, `grep`, and `glob` may open bundled
    skill files, while write tools and `shell` still cannot touch them.
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

## 8. Path denylist and permissions

Single-user trust model. The host is trusted. The operator is the user.

- **Path denylist** `[since v1.0]` — absolute paths anywhere on disk are accepted
  *unless* they resolve under a denied root (`OPENAGENTD_DATA_DIR`,
  `OPENAGENTD_STATE_DIR`, `OPENAGENTD_CACHE_DIR`) or match a user-defined glob
  in `denied_paths.yaml`. User-defined deny globs are enforced inside the active
  workspace too, not only outside it `[v1.74.0]`. Symlinks are rejected only
  when targeting a denied root. Tilde paths are always rejected.
- **Self-diagnostic carve-outs** `[v1.120.4]` — agents can read their own
  runtime diagnostics inside the denied state root: `{STATE_DIR}/logs`,
  `{STATE_DIR}/otel` (span/metric rollups), and `{STATE_DIR}/telemetry`
  (per-turn context-window dumps), plus the current session's own artifact dir.
  Credentials (`OPENAGENTD_CACHE_DIR`), the SQLite DB, undo/redo snapshots, and
  other sessions' artifacts stay denied. This is what makes the
  `oad/debug-prod` log/telemetry workflow usable without disabling the path denylist.
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
- **Telemetry overlay** `[v3.0.0]` — telemetry opens over the current screen from
  the status-bar spend, the mobile drawer, or **Open Telemetry** in the palette; `/telemetry`
  links (`?days=`, `?traceId=`, `?session=`) open it too. It shows spend, turns
  (and how many failed), median turn time, tokens, and cache hit rate, per-day
  spend or turns, and spend by workspace, session, model, and tool. Filter by
  range (24h to 90d), workspace, model, or session; clicking a workspace,
  session, or model row applies that filter, so a session becomes a per-session
  view with an **Open session** action. Recent turns can be limited to failed ones,
  and a turn opens to its facts (workspace, model, duration, tokens, cost),
  **Copy trace ID**, **Open session**, and the span waterfall. Turns record their
  workspace from v3.0.0; older turns show as **Not recorded**.
- **Model speed in telemetry** `[v3.0.0]` — every streamed model call records
  its time to first token and its output speed in tokens per second. The
  overview shows the median first token (with p95) and the median output speed
  (with the slowest 5%), each model row shows its median of both, and a
  model-call span lists them. Calls recorded earlier count toward everything
  else but not toward speed.
- **Sub-agents in session telemetry** `[v3.0.0]` — a session's telemetry view
  counts the sub-agent sessions it started in its spend, turns, and tokens, and
  says how many. The Sessions card lists each sub-agent under its session (in
  the overview too), and recent turns name the agent that ran them.
- **OpenTelemetry spans** `[since v1.0]` — `OpenTelemetryHook` emits spans for
  agent runs, model calls, tool calls. Optional OTLP exporter.
- **Estimated model-call cost telemetry** `[v1.34.0]` — chat, title-generation,
  and summarization spans include estimated USD cost when model-registry pricing
  and provider usage tokens are available. Cost lookups now always use the
  fully-qualified `provider:model` id, so Anthropic's cache-write bucket is
  priced at the cache-write rate instead of being silently dropped by a bare-id
  registry miss, and the estimate applies DeepSeek's published off-peak rates
  (50% of peak outside Mon–Fri 01:00–04:00 and 06:00–10:00 UTC) `[v2.4.2]`.
  The telemetry dashboard also reports cache-write tokens separately from cache
  reads in the totals, provider:model, and cache-by-step views `[v2.4.2]`.
- **Prompt budget report** `[v1.102.0]` *(deprecated — removed with the v2
  Python tooling)* — the `prompt-budget` Make target reported exact
  `o200k_base` counts for the v2 assembled static system prompt, compact
  tool-schema JSON, every first-party base prompt, each tool, and bundled skill
  bodies; `prompt-budget-json` emitted a stable machine-readable baseline for CI.
- **Fast JSONL-backed query API** `[v2.0.0]` — `/api/observability/*` queries
  local OpenTelemetry span logs directly using `orjson` parsing, delivering faster
  query execution and lower latency without DuckDB binary dependency weight.
- **Two-tier logging** `[since v1.0]` — app log at `{STATE_DIR}/logs/app/`,
  per-session JSONL transcript at `{STATE_DIR}/logs/sessions/{id}/`. Rotated,
  loguru-based. `FILE_LOG_LEVEL` `[v1.130.0]` sets the app-log threshold
  independently of the console's `LOG_LEVEL` (default `DEBUG`, unchanged); the
  error log stays ERROR-only, so raising it never hides crashes.
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

---

## 10. Voice

Client-side speech recognition. OpenAgentd does not run backend microphone transcription.

- **Mic button in composer** `[since v1.0]` *(deprecated — removed in v2.0.0)* — click to start listening, click to
  stop. Transcript text is inserted into the chat input for review before sending.
- **Browser / OS speech recognition** `[v1.34.0]` *(deprecated — removed in v2.0.0)* — uses the current browser or
  app WebView speech recognizer when available. No `/api/speech/*` backend,
  `speech.yaml`, or bundled `faster-whisper`.

---

## 11. Distribution and updates

Desktop is primary. CLI / server is the developer path.

- **macOS desktop** `[since v1.0]` — Homebrew cask
  (`brew install --cask lthoangg/tap/openagentd`) or `.dmg` with bundled
  `install.sh` (signs locally). Installs, cask upgrades and in-app updates
  sign with your Apple Development identity if you have one, else an
  "OpenAgentd Local Signer" identity kept in its own keychain
  (`openagentd-signing.keychain-db`), so signing never asks for a password
  `[v3.4.0]`. Earlier builds kept that identity in the login keychain, where
  codesign asked to use its key on every install or update.
  If codesign cannot use the identity ("no identity found"), the install or
  update signs ad hoc instead of failing `[v3.6.0]`; v3.4.0–v3.5.0 in-app
  updates stopped there, so those installs update with `install.sh` or
  `brew upgrade --cask`.
- **Linux desktop** `[since v1.0]` — AppImage (`chmod +x`) or `.deb` for
  Debian/Ubuntu.
- **Windows desktop** `[v1.106.0]` — native x64 `.msi` installer with the
  bundled Python sidecar, WebView2 shell, Job Object process cleanup, native
  PowerShell/cmd shell execution, and signed in-app updates. Interactive PTY
  terminal tabs were unavailable until v3.0.0, which bundles the native backend
  and opens terminals through ConPTY.
- **Windows one-command install** `[v1.107.0]` — the `install.ps1` PowerShell
  installer resolves the latest GitHub release, downloads its x64 MSI, rejects
  a non-MSI download before elevation, and invokes Windows Installer.
- **Signed update manifests** `[v1.2.2+]` — minisign-signed `latest.json` at the
  rolling `latest-desktop` release; verified before install.
- **In-app updater** `[v1.22.0]` — see [§1](#1-the-desktop-coding-workspace).
- **CLI install** `[since v1.0, native since v3.0.0]` — `install.sh --cli` (macOS / Linux),
  `install.ps1 -Cli` (Windows), or `brew install lthoangg/tap/openagentd` installs the
  native standalone executable into `~/.local/bin` (or `%LOCALAPPDATA%\OpenAgentd\bin`)
  and cleans up any existing Python v2 uv/pipx install. The Python package managers
  (`uv tool`, `pipx`, `pip`) were used through v2 and are sunset in v2.27.0.
  Prebuilt CLI archives cover Apple Silicon macOS, x86_64 Linux and x86_64 Windows;
  releases after v3.6.0 no longer ship Intel macOS or ARM Linux archives, and
  `install.sh` says so on those machines.
- **v2 end-of-life notice** `[v2.27.0]` — the last Python release. Interactive
  CLI commands and `openagentd upgrade` say that v2 gets no further updates and
  print the v3 install command plus the step that removes the uv/pipx/pip copy.
  `OPENAGENTD_HIDE_V2_NOTICE=1` hides it; the desktop sidecar never shows it.
- **Concise native CLI** `[v3.1.0]` — `openagentd --help` lists eight command
  groups with short examples, errors print as one `error: …` line, and usage
  errors exit 2. Bare `openagentd` prints help instead of starting the server
  (use `openagentd server start`); the name is kept for a future terminal UI.
- **CLI server control** `[v1.41.0, v2.4.0, v3.1.0]` — `openagentd server start|stop|restart`,
  `openagentd server status`, `openagentd server logs`, and `openagentd server
  start --host 0.0.0.0 --key` make the CLI the control plane for desktop/mobile backends.
  Since v3.1.0 `server status` also runs the port, live, ready, and LAN checks
  (the former `server health`, still accepted) and exits 1 when the server is
  stopped or unhealthy, and `server logs` shows readable log lines instead of
  raw JSON records.
- **Foreground CLI agent execution** `[v2.4.0]` — `openagentd run --prompt "..."`
  validates the current directory as a coding workspace, starts one persisted
  agent session, and streams only the agent's response text to standard
  output. `--model provider:model` and `--thinking` apply per-turn overrides;
  auto-approved tool permissions continue normally, while interactive agent
  questions stop the non-interactive command instead of leaving a suspended run.
  Since `[v3.1.0]`, `-C/--cd DIR` picks another workspace, `-c/--continue`
  continues the workspace's latest session, `--session ID` continues a given
  session, and `--json` prints every stream event as one JSON line.
- **CLI start --wait** `[v1.73.0, v2.4.0]` — `openagentd server start --wait`
  starts the background server and polls `/api/health/ready` until the database
  connection and the agent session are fully ready; since v3.1.0 it exits 1 when
  the server dies or is not ready within 30 seconds.
- **CLI upgrade** `[v1.41.0, self-update v3.0.0]` — `openagentd upgrade` in v3 stops the
  background server, downloads the latest prebuilt release archive from GitHub, verifies
  its SHA-256 checksum, swaps the binaries in place, and restarts the server if it was
  running. Homebrew installations delegate to `brew upgrade`. In v2.27.0, `openagentd upgrade`
  migrates existing uv/pipx/pip installations to the v3 native binary. `openagentd update`
  is an alias `[v3.1.0]`.
- **CLI OAuth login status** `[v3.1.0]` — `openagentd auth list` shows which
  OAuth providers (Codex, GitHub Copilot, Grok) are logged in, and
  `openagentd auth logout <provider>` deletes the saved login.
  `openagentd auth <provider>` still logs in.
- **CLI doctor** `[since v0.1.0, v3.1.0]` — `openagentd doctor` checks provider credentials
  (including keys saved in Settings → Providers and the lead agent's OAuth
  login), the database, the configured server port, and the agents directory,
  and exits 1 when a check fails.
- **CLI artifact cleanup** `[v2.18.0]` — `openagentd cleanup` previews a dry run
  and, with `--apply`, deletes sessions older than `--older-than-days`
  (default 14) together with their messages, session artifacts, undo/redo
  snapshot repos, and app-managed telemetry, logging, and worktree state that
  no live session owns. `--vacuum` then rebuilds the SQLite file so pages freed
  by the deleted rows return to disk; a lock held by a running server is
  reported rather than failing the pass. Since v3.1.0 the preview lists the
  largest candidates with their size and reason (`--limit N`, `0` for all).
- **Docker** *(deprecated, removed in v1.23.0)* — the `Dockerfile`,
  `docker-compose.yaml`, and the `ghcr.io/lthoangg/openagentd` image are
  no longer maintained. Use the CLI install paths above; revisit if there
  is concrete self-hoster demand.
- **Migration imports** `[since v1.0, v2.4.0]` — `openagentd transfer migrate openclaw`,
  `openagentd transfer migrate hermes`. Imports identity + context Markdown into one agent.
- **Server migration export/import** `[v1.97.0, v2.4.0]` — `openagentd transfer export` packs
  agents, skills, commands, plugins, and config files into a timestamped
  `.tar.gz` archive. `openagentd transfer import <archive>` unpacks it on the target
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
- **Reload preserves the current open page** `[v2.9.0]` — reloading in browser
  or desktop shells (Cmd+R / Ctrl+R) restores the active session, scheduler, or
  telemetry view instead of returning to the home workspace.
- **Closest restorable route fallback after backend switches** `[v1.68.0]` —
  when reconnecting to a backend that does not have the previous
  coding session, desktop restore now lands on the nearest valid hub page
  instead of reopening a stale session-specific route.


---

## 12. Embed and API

The same HTTP + SSE API drives the desktop, browser, and mobile clients. Embed it elsewhere with no extra work.

- **REST + SSE chat API** `[since v1.0]` — `POST /api/agent/chat` is
  fire-and-forget (returns 202 in <50ms); the agent streams events on
  `GET /api/agent/{session_id}/stream`. Reconnect-safe replay.
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
