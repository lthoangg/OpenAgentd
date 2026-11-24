---
title: "Features: The app: engine, speed and connection"
description: "The Rust backend, startup and streaming speed, the connection to the server, crash recovery, versions and in-app updates."
---

# The app: engine, speed and connection

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

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
  desktop, mobile and local dev UIs are unaffected; `OPENAGENTD_CORS_ORIGINS` adds
  origins and `["*"]` restores the open default. The desktop token and access
  key are removed from the environment of every process the agent starts
  (shell, terminal, git, MCP, plugins). The desktop app restarts a crashed
  bundled backend (up to 3 times in 10 minutes) and reconnects open windows.
  Stopping the server with open streams exits at once instead of after 5 s.
  An internal crash in one turn ends that turn with an error instead of leaving
  the session busy, and concurrent messages keep distinct history positions.
- **Running turns survive a server restart** `[v3.34.0]` — when the server
  stops while an agent is mid-turn (`agentd server restart` or `upgrade`,
  stopping and starting the builtin backend, an app restart, or a crash or
  kill), the next start continues that turn on its own. A **Continued after a
  server restart** divider marks the spot, the agent is told its last step was
  cut off, and a tool call that was running gets a result saying a restart
  stopped it and may have partly run it, so the agent checks before repeating
  it. A turn you stopped stays stopped, a turn waiting on your answer keeps
  waiting, and each turn is continued at most once: cut off again, it stays
  stopped with a **Stopped by a server restart** divider. A subagent cut off
  mid-task is not restarted on its own; its lead gets a report that it was
  stopped, so the lead never waits for it. `[v3.36.0]` The lead can resume
  that same member by its handle (`team(target='worker#1', task='continue')`):
  it is rebuilt from its saved session and goes on with its full transcript
  instead of a new member starting from nothing. `team(action='list')` shows
  it as stopped by a server restart until then.
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
- **Plugins cannot hang the server** `[v3.14.0]` — a JS plugin that runs
  JavaScript for more than 5 s without yielding (for example `while (true) {}`)
  is interrupted with a `TimeoutError` and keeps working for later calls. A
  plugin that takes over 30 s to load fails to load, synchronous plugin checks
  give up after 10 s, and a `before`/`after` tool hook that does not finish in
  60 s is treated like a hook that threw.
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
    up to 18 s (since `[v3.29.0]` launch never checks saved servers at all),
    and in dark mode a new window opens dark instead of flashing light.
  - An idle server uses almost no CPU (under 10 ms a minute, was 60 ms).
  - `grep` keeps the matches it found when it times out. `read` caps
    directory listings and reports binary files instead of dumping them.
- **Faster startup and agent edits** `[v3.35.0]`:
  - The app loads 641 kB of JavaScript (gzip) before its first screen, down
    from 810 kB: Settings, Telemetry, the scheduler and MCP app results load
    while the app is idle right after it starts, so they still open at once.
    The app starts sooner, most noticeably on slower phones.
  - A clean TypeScript `patch` no longer waits a fixed second for late
    diagnostics (see *Real-time LSP diagnostics injection*), and opening a
    session with many short prompts skips measuring prompts too short to fold.
  - On macOS the notch island stops checking the pointer while it is hidden,
    and checks it half as often while the pointer is far away.
- **Faster session open on a slow connection** `[v3.63.0]`:
  - Opening a session starts loading its history together with the session
    itself instead of after it. Over a link that adds 150 ms to each
    request, the newest turn appears in ~310 ms on a desktop (was ~790 ms)
    and ~540 ms on a phone (was ~920 ms).
  - Reopening the app no longer asks again for the lists it has just loaded
    when the server says nothing was missed: 6 fewer requests on a desktop,
    5 on a phone.
  - On a phone, a long session first draws its 16 newest turns and brings
    earlier ones in as you scroll. It appears ~25% sooner, and streaming
    a reply no longer blocks the page (was ~0.5 s of long tasks).
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
  `/` is a new session and `/{session_id}` a session, and the app's labels no longer call it
  "coding" (the composer reads "Ask anything in <workspace>…", the palette
  "Toggle Sidebar", the tray just the workspace name),
  workspaces are required across chat, scheduler, and terminals, and database
  migration permanently removes legacy workspace-less records. The workspace-less
  chat surface itself returned in v2.19.0 as a pinned Chat workspace rather than a
  separate mode (see below). Telemetry is accessible via the
  desktop status footer and mobile navigation.
- **Connection-ready screen warmup** `[v1.113.3]` — after either the bundled
  sidecar or an external server connects, the app preloads coding data in the
  background so the first session can render from cache.
  Packaged desktop launches also canonicalise the `index.html` entrypoint to Home
  instead of showing the client-side 404 screen.
- **No duplicate messages on resume** `[v3.37.0]` — reopening the phone app
  or reloading mid-turn no longer repeats the reply or a steer message, and
  a step saved during the reconnect shows up right away instead of at the
  end of the turn.
- **In-app crash recovery** `[v1.113.0]` — an unexpected UI render failure opens
  a recovery screen with Reload and copyable error details instead of leaving a
  dead webview that must be force-quit.
- **In-app auto-updater** `[v1.22.0, v1.99.8, v1.115.1]` — top-right update card + Settings → About
  → Updates, cached downloads, install-and-restart, signed minisign payloads, draggable and minimizable floating update card `[v2.3.0]`,
  GitHub release notes rendered inline. Desktop checks at startup and every 6
  hours, including on a foreground return once that interval is due; choosing
  Later suppresses the automatic reminder for the full 6-hour interval in the
  current app run; relaunching performs the normal startup check `[v1.115.1]`.
  macOS update archives ship already signed with the stable
  identifier-only requirement, so v3.19.0 and later install them without the
  "signature verification failed" error `[v3.20.0]`.
  Since `[v3.31.0]`, pressing Install while agents are still working warns
  that restarting may interrupt their turns. You can then choose **Restart
  anyway** or **Later**.
  Since `[v3.49.0]` the Android app checks for updates too, with the same
  card and Settings → About → Updates. It downloads the APK, checks its
  SHA-256 against the `latest-android` feed, and opens the system installer
  (Android asks to allow installs from OpenAgentd once, and only accepts an
  APK signed with the same key). The iOS app has no update check: TestFlight
  and the App Store deliver its updates.
  Earlier iterations: `[v1.18.0]`, `[v1.20.0]`, `[v1.21.0]`.
- **Client and server versions** `[v3.49.0]` — Settings → About has a
  **Version** section with the version of this app (desktop, iOS, Android, or
  the web UI) and of the connected server, plus its address. When they
  differ by a major or minor version it warns which side to update; a
  patch-only difference gets a quiet note. The header shows the app's own
  version (before, it showed the server's).
- **One-click server update** `[v3.51.0]` — when a newer release is out, the
  Server row of Settings → About → Version has **Update to vX**, from the
  phone, the browser, or a desktop app connected to another computer. It
  works for a server `agentd server start` launched: the server downloads and
  verifies the release (or runs `brew upgrade`), restarts, and resumes the
  turns the restart cut off. If agents are working it asks first. While the
  server restarts the connection banner says **Updating the server** instead
  of **Can't reach**, and the row then says how it went (on failure with the
  path of the update log on the server). A server in the foreground, or the
  desktop app's own, says what to do instead. Servers before v3.51.0 need one
  `agentd upgrade` first.
- **Categorized stream & execution error handling** `[v1.133.0]` — provider stream
  errors (rate limits, auth 401, connection drops) are now displayed directly within
  the chat transcript area as persistent error callout cards, while action validation
  failures (e.g. undo/redo/compaction errors) surface targeted, categorized toast
  notifications with contextual titles.
- **On-demand bundle splitting for heavy components** `[v2.0.0, v3.5.0]` — xterm.js,
  KaTeX, and PDF.js load lazily on demand when first needed, accelerating cold-start
  boot time and reducing initial bundle memory.
- **App surfaces open without a loading step** `[v3.0.0]` — Settings pages,
  Telemetry, the review dock with its Tasks and Schedule tabs, the scheduler and
  session settings dialogs, session search, message Markdown, and MCP app
  results ship with the app instead of loading on first open, so none of them
  shows a placeholder first. Only xterm.js, KaTeX, and PDF.js still load on
  demand.
