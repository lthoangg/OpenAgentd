---
title: "Features: The app: sidebar, palette and shortcuts"
description: "Finding and switching: the sidebar, the command palette, keyboard shortcuts, native menus, windows and session titles."
---

# The app: sidebar, palette and shortcuts

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Command palette and Find file** `[v2.3.0, updated v3.40.0]` — `⌘K`/`Ctrl+K`
  opens one search over app actions, sessions and workspace files; `⌘P`/`Ctrl+P`
  (Find file) opens the same palette scoped to files. It uses the compact
  warm-paper search surface, keyboard navigation, and a visible warning when a
  capped workspace listing omits files. With an empty query `⌘K` lists the
  commands; typing shows up to eight **Commands**, eight **Sessions** (titles
  from every workspace, best match then newest, labelled with workspace and
  age; choosing one opens it) and twenty **Files** under their headings, and
  the arrow keys run across them as one list. Find file shows a Files label
  before the field; Backspace on an empty query (or a click on the label)
  widens it to all three, and a leading `>` searches commands only. A list
  that is still loading shows Loading… instead of "Nothing here yet", and the
  field is 16px on touch phones so iOS does not zoom `[v3.40.0]`.
  A file query ending in `:line` or `:start-end` (`Button.tsx:42-58`)
  opens the pick with those lines selected `[v3.0.0]`.
  `⌘D`/`Ctrl+D` toggles the files and git dock. `⌘N`/`Ctrl+N` starts a new
  session and is a no-op on an already empty idle session. The desktop status
  footer and mobile sidebar name the connected backend (`builtin` or the saved
  server name/host) instead of a hardcoded local label. Mobile chat actions
  expose terminal access without a hardware keyboard.
  Press and hold the
  pinned Chat row in the mobile sidebar to start a new chat session, since the
  inline `+` is hidden on touch.
- **Palette pages and switching** `[v3.0.0, updated v3.21.0, v3.27.0]` — the Command Palette gains
  Switch Session… (recent sessions in every workspace, with running and
  waiting-for-you status) and Switch Workspace… (repositories, worktrees,
  and Chat, most recently active first). Each opens a nested list in place;
  Backspace on an empty query or Escape steps back out. Typing `>` in Quick
  Open searches
  commands instead of files. The desktop app adds Reload Window, since `⌘R`
  no longer reloads.
  Switch Session… and Switch Workspace… are now one **Switch
  Workspace/Session…**: it lists every workspace (the current one first),
  and a workspace opens its sessions, with **New Session** on top while
  nothing is typed `[v3.21.0]`. → opens the highlighted list and ← on an
  empty query, Backspace, or Escape steps back one level, landing on the
  row that opened it `[v3.21.0]`.
  `⌘L`/`Ctrl+L` opens Switch Workspace/Session… directly, and
  `⌘⇧L`/`Ctrl+Shift+L` opens the current workspace's sessions (**Sessions
  in This Workspace…**, also a palette command and a desktop View menu item)
  with New Session highlighted; Escape steps back to the workspace list
  `[v3.27.0]`. Palette, Quick Open, and picker lists now highlight a row on
  hover only when the mouse actually moves, so a list opening, loading, or
  scrolling under a parked cursor no longer steals the keyboard's choice
  `[v3.27.0]`.
- **Platform-aware keyboard shortcuts** `[v1.93.1]` — `⌘` on macOS, `Ctrl`
  elsewhere, applied consistently across in-app shortcuts, the Command
  Palette, and native Tauri menu accelerators. Session Settings moved to
  `⌘⇧A`/`Ctrl+Shift+A` to avoid clobbering Select All; view-mode cycling and
  session-list refresh lost their dedicated shortcuts (palette-only, low
  frequency). `⌘S`/`Ctrl+S` no longer opens Scheduled Tasks, so it only saves
  in Settings `[v3.0.0]`.
- **Sidebar and header: fewer steps** `[v3.40.0]`:
  - **New session** sits at the top of the sidebar at all times (it does what
    `⌘N`/`Ctrl+N` does).
  - A workspace's name opens its latest session (a new one when it has
    none); the chevron beside it folds the list.
  - Pinned, Needs you, the sessions and Scheduled scroll together in one
    list, under one style of section header with an always-visible chevron.
    A session shows in one place only: a pinned one stays in Pinned even
    when it needs you or is running. `[v3.49.0]`
    Needs you counts in words ("2 waiting"). Scheduled is always there, with
    **+** for a new task. Since `[v3.51.2]` a row's state is its leading
    mark alone: **!** needs you, a spinner running, a dot finished unseen,
    **✗** failed. The row keeps its time beside it, and the state in words
    is in its tooltip (before, the row said **Needs you**, **Done** or
    **Failed** in place of its time).
  - While the workspace list first loads it shows placeholder rows, and if it
    fails, **Retry**; "No workspaces yet" only means there are none.
  - A session's menu (⋯, right-click, long-press) has **Open in new window**
    (desktop app), **Rename**, **Pin** and **Delete session…**. Touch
    keeps the pin mark on pinned rows.
  - The status bar's items are all reachable with Tab, the fast mode pill too.
  - One name for each thing: **Review panel**, **New session**, **Side
    questions**, **Open workspace…**, **Workspace** and **Worktree** (never
    folder or checkout), **Remove**, **Undo** / **Redo**, the **Built-in
    server**.
  - The header has no command palette button (`⌘K`/`Ctrl+K` and the View
    menu open it), and a hidden
    sidebar leaves no hairline at the window's edge.
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
- **Keyboard paths and focus continuity** `[v3.5.0, v3.6.0]`:
  - Row actions that only show on hover also appear on keyboard focus and keep keys:
    F2 renames, Shift+F10 or the Menu key opens the row's menu. In the
    sidebar, Left and Right collapse and expand a workspace. Since
    `[v3.57.0]` sidebar rows take no row keys (no F2, Delete / `⌘⌫` or
    Shift+F10), and their right-click menu shows no key hints.
  - Focus never drops to the page: after sending, Escape or a deleted row it
    returns to the composer, and a collapsed sidebar or closed drawer cannot
    take it. In the composer, Tab still switches Plan and Code; Shift+Tab or
    Escape leaves it. Focus handed back on page load draws no focus ring
    until you press a key `[v3.6.0]`.
  - The desktop app shows **Skip to main content** on the first Tab `[v3.6.0]`.
  - The Keyboard Shortcuts sheet lists the new keys under **Moving around**.
- **Native menu/tray shortcuts** `[v1.39.0, v1.93.1]` — menubar shortcuts for Home,
  Coding, Command Palette, Scheduled Tasks, Session Settings,
  key settings pages, updates, reload, config folder, and backend log; compact
  tray dropdown for status, quick navigation, reload, settings, and quit.
  Command Palette, Scheduled Tasks, and Session Settings accelerators now use
  `CmdOrCtrl` (Session Settings requires Shift) to match the in-app
  platform-aware shortcuts `[v1.93.1]`.
  - **Platform-standard menus** `[v3.0.0]` — File has New Session (`⌘N`), New
    Window (`⌘⇧N`), Open Workspace… (`⌘O`), and Close Window (`⌘W`, which
    closes an open dock tab first; since `[v3.46.0]` `⌘O` / `Ctrl+O` and
    Open Workspace… in the command palette work in the browser too). View
    adds Toggle Sidebar (`⌘B`). A new Help menu
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
    Settings → Models. Each measurable row also carries a compact
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
    Since `[v3.29.0]` **Auto** reads the server of the window you are in
    (the builtin backend when no window is open), and its name, numbers and
    error always come from that one server: it never falls back to a saved
    server, and an unreachable one reads "Can't reach ‹server›" instead of
    showing old numbers. Each server keeps its own last reading and usage
    alerts, so switching servers neither shows one server's numbers under
    another's name nor repeats a notification. When Auto's server is
    offline the selector still lists Auto, so you can pick another server.
    Since `[v3.42.0]` it lists no sessions (no **Needs you**, **Running** or
    **Can't reach** groups, no "N need(s) you" chip in the header): it shows
    provider limits and actions only. The count mark on the tray icon is
    unchanged.
    Since `[v3.55.0]` the numbers always belong to the server named above
    them: picking another server shows placeholders under its name until
    its reading arrives (it used to keep the last server's numbers for up to
    10 s), reads it once, and drops an answer that arrives for a server you
    have already left. A server that went away while picked falls back to
    Auto in the list too, and a server you remove leaves no reading behind.
    Opening the popup while a check is already running
    waits for that check instead of sitting on placeholders; **Refresh**
    that meets a background check waits for it and then reads past the
    server's cache itself. A limit the
    provider reports as reached reads **Limit reached** below 100% as well,
    as it does in Settings.
    The usage period reads "Ends in 3d", as in Settings (it read "Resets in
    3d", the wording for a limit). A saved server has one name in the
    popup: the list and the header use the name Auto shows for it (the one
    you saved it under, else the name its computer gives for itself, else
    its address); the list used to show the address for a server Auto
    called by its computer's name.
    A refresh that fails over the last reading still says how old that
    reading is ("Couldn't refresh · checked 40m ago"). A server you pick
    is answered from its last reading and refreshed behind it, as Auto is,
    so picking it no longer waits on the network every time, and a failed
    read keeps its last numbers instead of "Can't reach". The "Checked"
    clock runs only while the popup is up.
    Since `[v3.25.0]` it looks and moves like the app:
    - **Layout.** It shares the app's colours and type. A provider with
      several limits gets one card, with rows named by window ("5-hour",
      "Weekly"); a provider with one limit is one row. The window fits its
      content up to 600px, and the list scrolls past that.
    - **States.** Loading shows placeholder cards. An unreachable server
      reads "Can't reach ‹server›" with Retry, and the status says Offline
      ("Can't reach" since `[v3.40.0]`).
      With no providers it offers Open Providers, and Reconnect goes to
      Settings → Models.
    - **Keys.** Esc closes it, or the server menu first, which also takes
      ↑ ↓ Enter. ⌘R refreshes, and ⌘, and ⌘Q run Settings and Quit; since
      `[v3.55.0]` only ⌘ does (Ctrl+Q used to quit the app too). Since
      `[v3.26.0]` the popup no longer offers New session; that lives in the
      app window (⌘N).
  - **Agent status in the notch** `[v3.26.0]` — on macOS, while you work in
    another app, a black pill grows out of the MacBook notch (or hangs from
    the middle of the menu bar on a display without one) whenever an agent
    is busy. It read "Working" with the session title or count (the word
    is **Running** since `[v3.40.0]`, and the resting pill has shown a
    spinner and a count with no word since `[v3.45.0]`), and a
    session whose own turn ended while its subagents (or another workspace)
    still work for it stays "Working" until their reports are in, so
    "Done" shows once, for the whole job `[v3.27.0]`. It turns
    orange with "Needs input" (**Needs you** since `[v3.40.0]`) when an agent waits on a question or a plan
    review, and keeps "Done" (or "Failed") up for a finished session until
    you open it, in the app or from the pill, or dismiss it.
    Since `[v3.28.0]` the pill ranks Needs input over Done/Failed over
    Working: a finished session you have not opened shows even while others
    still run, and the list and a click on the pill follow the same order.
    A session that
    finishes on screen in the focused window, a turn you stopped yourself,
    and a background idle compaction show nothing. Click it to list the
    sessions, waiting ones first with their question, then the finished
    ones with a × to dismiss, then running ones; click a row to open that
    session, or the pill again to close the list. Pointing at it opens the
    list only with **Expand on hover** on (off by default); a click on the
    pill then opens the session it names. The pill grows out of the notch,
    springs open and shrinks back in, and clicks beside it still reach the
    menu bar. It never takes focus and steps aside for full-screen apps.
    Settings → Desktop turns it off, and can also keep it up
    while OpenAgentd is in front (off by default), stop keeping finished
    sessions, or turn on **Expand on hover**.
    Since `[v3.29.0]` it follows every server that has a window open,
    instead of one server picked from the focused window (with a saved
    server as fallback): a server that is down no longer leaves it empty,
    and switching windows never turns running work into "Done" or drops
    unread sessions. With two or more servers, each row names its server
    ("Builtin" for the bundled one, "Built-in server" since `[v3.40.0]`), and a click opens the session in a
    window on that server.
    Since `[v3.33.0]` a saved server can also be **enabled** in Settings →
    Connection (a switch on its row): the notch then follows it with no
    window open, so its running, waiting and finished sessions show, and a
    click opens a new window on that server. A disabled server (the
    default for servers saved before this, and the seeded Local CLI entry;
    servers saved from now on start enabled) is still one Connect away but
    is followed only while a window is on it. Each row shows its
    background state (Watching, Reconnecting, Access key rejected, or
    Disabled), a server that is off is retried every 30 s at most (60 s
    after a rejected key) instead of every 15 s, and rows carry a server
    name only when two or more servers are connected.
    Since `[v3.43.0]` the builtin is followed whenever it runs, whatever
    windows are open: before, a window on an external server (and none on
    the builtin) dropped the builtin's sessions.
    Also since `[v3.33.0]` the resting pill no longer covers menu bar items:
    on a notch it grows only a narrow wing left of the notch (the state
    mark, and a count for several sessions), leaving the status icons right
    of the notch alone; without a notch it is a small pill with the same
    mark and count. Hover still opened the full list, with titles and
    questions (since `[v3.40.0]` only with **Expand on hover** on; a click
    opens it).
    Since `[v3.45.0]` the resting pill is balanced again: a small wing
    either side of the notch, the state's symbol on the left (dot, spinner,
    check, alert) and the number of sessions on the right, one included
    ("99+" past 99), with no words (screen readers still hear them). Without
    a notch it is the same two wings side by side. The pill stays centred,
    so it opens evenly on both sides, the open list keeps one inset on both
    edges, and on a notch an odd number of points wide (a 14" MacBook Pro)
    the pill no longer shows a 1 px sliver past the notch.
    Right-click the pill or a session row for a native menu with Open and
    Open in new window; finished sessions also offer Dismiss `[v3.28.0]`.
    A new window opens on that session's server without navigating an
    existing window. Cancelling the menu leaves unread notifications intact.
    Since `[v3.38.0]` reading a session is shared between the notch, the
    desktop pet and the sidebar of every app window: opening or dismissing
    it in any of them clears it from the others (the pet keeps a question
    until it is answered). Turning off "keep finished sessions" only empties
    the notch.
  - **Desktop pet** `[v3.36.0]` — on macOS and Windows, an opt-in pixel pet
    (a cat, a duck that waddles, or a crab that walks sideways)
    walks along the bottom of the screen by default, above the Dock or
    taskbar (leaving room for one that hides itself, so it never walks where
    it pops up), on top of other apps. Drag it anywhere on the screen and it
    walks left and right at that height (with climbing on it first falls to
    the surface below `[v3.42.0]`); near the top, its bubble opens
    below it. Its pose follows your agents: it wanders and sits when
    nothing runs (and sleeps after five quiet minutes), types on a tiny
    laptop while an agent works, and raises an orange "!" while one waits on
    you. While an agent works it keeps moving too `[v3.38.0]`: it types a
    while (twice its idle pause, at least 6 s), dims the screen, folds the
    lid with a clack and swings the laptop onto its back, walks or climbs
    with it, then sets it down and opens it again; it never runs about on
    its own mid-turn, and stays put at the open laptop when told to stay
    put or with reduced motion. Notifications show in its speech bubble instead of the system
    banner: a question stays until it is answered (Answer opens it), and a
    finished turn or a failed one hops or droops and
    fades after 8 s into a count badge. Click the badge to list what it
    missed; a click on the pet itself is only a poke (it hops and meows,
    quacks or snips)
    and never brings OpenAgentd forward. Right-click it for a menu: what
    it missed (open one, or clear them), Open OpenAgentd, New Session,
    Movement, Character, Pet Settings and Hide Pet; it stands still while
    the menu is open. It pounces at a pointer resting beside it, but no
    longer turns to follow the pointer `[v3.38.0]`. Playful and Chaotic pets run about (zoomies)
    when a turn finishes, Chaotic ones now and then too, and pant a moment
    after; they also jump onto the top edge of the windows you have open,
    walk along it, ride along when the window moves, and jump or fall back
    down (no extra permission: only window frames are read). It never takes focus, clicks beside it reach the app behind,
    and you can drag it onto another display too; the spot (height
    included) is remembered. It replaces a banner only while it is on screen: hidden
    over a full-screen app, while OpenAgentd is in front, or on the lock
    screen, the banner shows as before. It follows the same servers as the
    notch, so it works with every window closed. Settings → Desktop →
    Desktop pet turns it on (off by default) and sets its character,
    colour, size, movement (stay put, calm, playful or chaotic), which
    notifications use the bubble, whether it climbs on windows, and
    whether it shows while OpenAgentd is in front (it always
    steps aside for full-screen apps); the tray turns it on and off too.
  - **Desktop pet: falls** `[v3.42.0]` — a **fall**
    has gravity (eases in, capped speed), a
    squash on landing and a tiny dust puff; it is how the pet comes down
    when its window closes, and when you drop it in mid-air: with climbing on
    it falls to the window edge or the ground below, and the saved spot is
    the ground it stands on (with climbing off it stays at the height you
    dropped it).
  - **Desktop pet: throws** `[v3.47.0]` — fling the pet and let go mid-move
    and it flies on with the pointer's speed instead of dropping straight
    down: an arc under gravity, a bounce off the sides and the top of the
    screen (at half its speed), and a landing with the fall's squash and
    dust, on the ground or, with climbing on, on a window edge it comes down
    onto. The spot it lands on is saved like a drop's (the ground below a
    window edge). Its speed is read over the last 80 ms of the drag; slower
    than 400 px/s, or held still for 50 ms before letting go, is a drop as
    before, so a gentle drop with climbing off still stays at that height.
    A throw with climbing off lands on the ground. Grab it in mid-air to catch it.
    No throws when told to stay put or with reduced motion, and none across
    displays (letting go over another display moves it there, as before).
  - **Desktop pet: no sheet over the desktop (screen sharing)** `[v3.42.0]` —
    the pet's window is no longer a transparent sheet over the whole work
    area, which a meeting app's window picker (Zoom, Meet, the macOS share
    picker) took for the window under the pointer, so nothing behind it could
    be picked. It is now a full-width lane just tall enough for the pet and
    what it is doing (its marks, a bubble, a ladder, a balloon, a fall), and
    the whole area only while you drag it; it shrinks back a moment after the
    pet is still. Everywhere else the desktop has no window of ours. The
    window is also marked as not shareable (macOS) and as a tool window kept
    out of captures (Windows), which pickers that honour them respect.
  - **Settings → Models usage panel redesign** `[v1.94.0]` — the
    per-provider "Usage" card in Settings → Models (`UsagePanel.tsx`)
    was restyled after CodexBar's menu-bar popover: a bold label per limit
    window, a flat progress bar with a leading dot marker, `N% used ·
    Resets in Xh Ym` under each bar, a header strip showing "Updated Xm
    ago" plus the plan badge, and a dedicated rate-limit-reached banner.
    The same `ProviderUsageLimit` payload comes from
    `GET /api/settings/providers/{provider}/usage`; period-only billing data
    renders as neutral availability rather than an invented percentage or
    unlimited allowance `[v1.112.0]`.
- **Multiple desktop windows** `[v1.41.0]` — open additional coding windows from
  File → New Window, the tray menu, or `⌘⇧N`/`Ctrl+Shift+N`; windows share the bundled
  sidecar and desktop auth token, while each window can independently switch to
  a saved external server `[v1.47.0]`. New windows now inherit the active
  window's current backend selection instead of failing when the bundled sidecar
  is unavailable `[v1.64.1]`. Since `[v3.29.0]` a new window always takes
  the server of the window you opened it from (or the builtin backend when
  none is open), never the main window's or a saved server; with the builtin
  backend stopped and no window open it opens unconnected, with Choose
  Server. View → Zoom In / Out / Reset now applies per
  desktop window instead of globally across all open windows `[v1.66.1]`. On
  macOS, each desktop window now updates its native title to the active coding
  workspace name or session title so the Dock window list distinguishes
  open windows `[v1.66.1]`. Window titles read `workspace - session title`
  (just the workspace until the session is named, long session titles
  shortened), so the Window menu, Mission Control, and the Windows/Linux
  taskbar tell windows apart `[v3.10.0]`.
  A worktree or subfolder reads as `repo (worktree)` there and in the header,
  whose title now takes the header's free width instead of being cut off at
  a fixed width `[v3.51.0]`. Fixed a bug where switching one window's CLI server
  could still redirect other open windows onto the same server: the backend
  now targets its "backend ready" notification at the switching window only,
  and the frontend listens for it on a per-window channel instead of the
  app-wide broadcast channel it was previously (incorrectly) using `[v1.99.1]`.
  Desktop windows now operate as symmetric peer windows `[v2.8.0]`: closing
  any window destroys its webview and frees memory immediately, while clicking
  the Dock icon or tray reopen action spawns a clean window when none are open.
  New Window opens on an empty new session instead of reopening the last
  workspace's latest session, at the size of the window you are in (the size
  saved on the last close or quit when none is open) `[v3.11.2]`.
  - **Hold Command + click session to open in new window** `[v1.62.1, v1.64.1]` — in the desktop app, holding `Cmd` (macOS) or `Ctrl/Cmd` (Linux) and clicking a session in either sidebar opens that session directly in a new independent desktop window; failures now surface an in-app error toast instead of silently doing nothing.
- **Editable session titles** `[v1.27.0]` — double-click a session card or use its
  edit affordance in the sidebar to rename saved sessions.
  - **Update title after compaction** `[v3.26.0]` — an opt-in switch in
    Settings → Chat titles renames a session from its summary each time the
    conversation is compacted, so the title follows what the session is
    working on now. Titles you renamed yourself and scheduled-task sessions
    keep their names.
    The new title comes from the summary's goal and your own latest message,
    not from runtime notes the summary may have quoted `[v3.31.1]`. A session
    another workspace's agent started is titled from its request, without the
    routing header in front of it `[v3.31.1]`.
- **Mode-scoped recent-session lists** `[v1.66.1]` — session sidebars now fetch
  their own coding session pages instead of
  sharing one mixed cache, preventing intermittent empty recent-session lists
  when prior conversations exist.
