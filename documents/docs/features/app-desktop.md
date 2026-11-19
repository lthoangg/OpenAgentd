---
title: "Features: The app: desktop shell"
description: "The desktop app: windows, notifications, the tray, the notch and the pet."
---

# The app: desktop shell

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Native desktop app for macOS, Windows, Linux** `[since v1.0; Windows restored v1.106.0]` — Tauri 2 shell,
  bundled backend sidecar (Python until v2, native since v3.0.0), embedded Web UI,
  one process, no terminal required.
- **Open at login** `[v3.62.0]` — Settings → Desktop → Startup has one
  switch, off by default. On, OpenAgentd starts in the background when you
  sign in to the computer, with no window: scheduled tasks run and your
  other devices can reach the computer without you opening the app. Open
  it from the Dock or the menu bar (the taskbar or the tray on Windows, the
  launcher or the tray on Linux). The switch shows what the system has: an
  entry removed in the system's own login items reads as off. Linux gets
  the Desktop page for the first time, with Startup alone.
- **Windows come back when the app opens** `[v3.62.0]` — quitting,
  restarting or updating with several windows open used to bring back the
  main window alone. Every window now reopens at its size and place, on
  the computer it was on (this one, a saved server, a computer of your
  account) and the session it showed, with the window used last in front.
  A window you closed does not come back, except the last one closed. A
  saved server that is off shows **Can't reach** with **Retry**; a server
  you removed, or an account computer that is offline, opens its window on
  this computer instead. With **Open at login** on, the windows come back
  the first time you open the app.
- **Native app notifications** `[v1.19.0]` — finished assistant turns in
  the desktop app, plus local native
  notifications in the remote-backend mobile shell `[v1.34.0]`. Clicking a
  desktop completion notification restores OpenAgentd and opens
  its linked coding session `[v1.113.4]`. Per-session context
  (coding workspace name when available). Notification sounds are handled by
  the operating system;
  OpenAgentd does not play an extra in-app sound. Background-process completion
  Mobile notifications send again after `[v1.113.4]` stopped them; tapping
  one opens its session, and the one for the session already on screen is
  skipped while the app is open `[v3.0.0]`. iOS pauses the app in the
  background, so mobile notifications arrive only while it is running.
  Notifications are shorter `[v3.3.0]`: the title is a status and the workspace
  name (`Done · openagentd`, `Failed · …`, `Needs you · …` (`Needs input` before v3.40.0), `Plan ready · …`),
  and the session title, question, or plan summary shows as one line of up to
  100 characters. A failed turn now notifies too. Stopping a turn or dismissing
  a question does not, and a lead that is waiting on subagents notifies once,
  after their reports are handled. With several desktop windows open, each
  notification shows once and is skipped while another OpenAgentd window is
  focused, and clicking it opens the session in one window instead of all of
  them. Since `[v3.29.0]` only a focused window on the same server skips it,
  so a question from a server you are not looking at still shows, and
  clicking it opens the window that sent it.
  On an iPhone signed in to an OpenAgentd Cloud account, Done and Needs you
  show once `[v3.51.2]`: the app shows them itself only while it is open, and
  the account's push covers the background, the lock screen, and events
  caught up on in the first seconds after reopening the app.
  Taps open the right session on the right computer `[v3.52.0]`: tapping a
  Done, Needs you or Failed notification (the account's push or the app's
  own, from a running or a closed app) opens that session, first switching
  to the computer it came from when that is not the one the app is on
  (directly on the home network when it can, else through the account), or the
  Servers screen when that computer is offline. A notification the app
  showed still opens its session after the app was reloaded or switched
  servers. The iPhone shows its own notification instead of the push's
  whenever push is off or not registered yet, and registers again once
  notifications are allowed.
  Fixed in `[v3.62.0]` for an account with several computers: a tap that
  launched the app opened the session on the computer last used instead of
  the one the notification came from, and a tap that switched computers
  landed on that computer's start screen without opening the session.
  Nothing is missed after a reconnect `[v3.52.0]`: a phone, laptop or window
  that was in the background, asleep or offline catches up on what happened
  meanwhile when it reconnects (unread dots, session states, question cards),
  quietly: only a Needs you that is still waiting shows a notification, and
  on an iPhone only when the account's push did not. No notification shows
  twice on a device, across reloads too. On desktop, a click that opens a
  window that is still loading is no longer lost, and a notification that
  failed to show can still show from another window.
  The phone rings only for what you have not seen `[v3.58.0]`: a computer
  sends its Done, Needs you or Failed push a minute after the notification,
  and only when nobody looked at that session meanwhile (open in a focused
  window or tab, or its question answered, on any desktop, browser or
  phone). Opening or dismissing a notification in the pet or the notch
  (Later on a question too) counts as looking at it. Working at your
  computers keeps the phone quiet; walking away
  with it still gets you every unseen result. While the iPhone app is open
  on one computer, a push from another computer of the account now shows as
  a banner instead of only after switching to that computer.
  One notification per session, gone once you have looked `[v3.62.0]`: on
  macOS and Linux a session's newer notification replaces its earlier one
  (Needs you followed by Done leaves one entry, not two), and a session you
  read in the app (in a focused window, or opened or dismissed from the
  notch or the pet) loses its notification, so Notification Center lists
  only what you have not looked at. Windows toasts stay as they were.
  A notification says which computer it came from `[v3.55.0]`: the title
  ends with the computer's name (`Done · web · studio-mini`), always for a
  computer of your OpenAgentd Cloud account (the app's own notification and
  the push alike), and for the built-in and saved servers once the app knows
  more than one server. It is the name the server lists show: the one you
  saved a server under, else the name its computer gives for itself.
  Notifications no longer stay off for good `[v3.55.0]`: the app has had no
  Notifications page since v2.9.0, yet a switch turned off there was still
  obeyed, with no way to turn it back on. The switch is no longer read; the
  operating system's notification settings are the one place to turn them
  off. On an iPhone with **Show Previews** set to **Never**, tapping a push
  now opens its session (the text stays hidden, as before).
  A goal that ends blocked no longer reads as a finished turn `[v3.55.0]`:
  the phone push used to file it under Done and the pet hopped. The push now
  files it as a failure and the pet droops; the notch keeps the row under
  Done and marks it with the blocked goal, as it did. The notification
  carries how the turn ended (`outcome`: done, failed, goal achieved, goal
  blocked, goal paused), and the notch, the pet and the phone push read
  that instead of the first word of the title. A server older than v3.55.0
  sends no outcome and is read by its title, as before.
  Reminder notifications are gone `[v3.55.0]` *(removed)*: no part of the
  server has sent one since the v3 rewrite, so the pet's **Reminders**
  switch controlled nothing and is removed with them. A pet settings file
  saved with that switch still loads.
- **Native on every platform** `[v3.40.0]`:
  - Native means the feel, not the operating system's widgets: right-click
    and ⋯ menus, dropdowns and pickers are the app's own on every platform,
    desktop and phone apps included. A right-click menu opens at the
    pointer with the same items as ⋯, and the arrow keys and Escape work
    in it.
  - One menu at a time, as in a native app: opening a menu, a dialog,
    Settings or the palette closes any menu or popover already open (the
    model and thinking picker, a right-click menu, **+**, the Tasks
    popover, the sidebar drawer of a narrow window), unless it was opened
    from inside it. A keyboard shortcut closes open menus too, and so does
    a click into a web preview page. Before, a picker could stay open over
    Settings.
  - On Windows and Linux the menu bar is hidden: **☰** at the left of the
    header, or tapping Alt, opens the application menu. Its View menu has
    Toggle Sidebar, Review Panel, Split Review Panel Right and Down, Open Terminal,
    Maximize Review Panel,
    Model and Thinking…, Text Size and Reset Layout
    (macOS has them in its menu bar), and Quick Open is now **Find File…**.
    Its shortcuts (`Ctrl+Q`, `Ctrl+=`, `Ctrl+Shift+N`…) work in every
    window, and on Linux the bar no longer comes back when the window is
    shown again.
  - On Windows the header is the title bar, as on macOS: Minimize,
    Maximize and Close sit at its right end, drawn as Windows 11 draws
    them, and resting the pointer on Maximize opens Snap Layouts. Drag the
    header to move the window; double-click it to maximize.
  - Dialog buttons follow the system's order (the action first on Windows,
    after Cancel elsewhere; text buttons on Android). Enter confirms a safe
    action; a destructive one never takes Enter, Cancel does.
  - The number of sessions that need you shows on the Dock (macOS), the
    taskbar (Windows) and the launcher (Linux), and in a browser tab's
    title.
  - Zoom is remembered, and a new window opens at the zoom and in the theme
    of the window it came from; Text size is shared by every window. On
    macOS it opens one step down and right of that window, as Mac windows
    cascade.
  - On macOS, a two-finger swipe goes back and forward between the sessions
    opened in the window, and scroll bars follow System Settings.
  - Optional global shortcuts, off by default: **Global Shortcuts** in the
    OpenAgentd menu turns on `⌥⌘O`/`Ctrl+Alt+O` (Show OpenAgentd) and
    `⌥⌘J`/`Ctrl+Alt+J` (Next session that needs you). Since `[v3.46.0]` the
    command palette has Next Session That Needs You too.
  - On Android the system font size now enlarges text, up to 125%, as
    Dynamic Type does on iOS.
  - In the phone apps, long-press menus (sessions, tabs, tool rows,
    messages) open as the app's bottom sheet. Bottom sheets close with a
    downward drag, and a swipe from the left edge brings back the session
    list.
- **Pet, notch, header and transcript fixes** `[v3.43.0]`:
  - In the sidebar grouped by workspace, the session you just used moves to
    the top of its group as soon as its turn starts, the open session too
    (it used to be added last when it was past the first page).
  - The pet no longer floats on balloons or climbs ladders: it changes
    height only by jumping (to any window edge it can reach, tall ones
    included) or falling. The **Ladders** setting is gone; **Climb on
    windows** still turns the jumps onto windows off.
  - A jump onto a window, or back down, starts with a look at where it is
    going and a crouch, then the pet leaps in an arc and lands with a squash
    and a puff of dust, instead of gliding straight up.
  - The notch, the tray's "Needs you" list and Settings → Server follow
    the builtin server whenever it runs, so its sessions stay listed with
    only windows on an external server open, or none.
  - In reader mode the jump chip says "Jump to latest" without a count of
    new blocks: the turns are folded, so the count said nothing.
  - The header's workspace and title stay right after the sidebar toggle
    whether the sidebar is open or not.
  - In a narrow window with the Review panel open, the sidebar opens as a
    drawer over the chat and the panel without moving them, and its scrim
    dims the panel too (a click there closes the drawer, even with the panel
    maximized). The panel used to cover the chat while the drawer was open
    and, once it closed, to leave the chat under its 400px minimum. Closing
    the panel near that width slides it shut beside the chat instead of
    over it.
  - A question with several answers allowed shows checkboxes without the
    1–9 digit beside each; the digit keys still pick options.
- **Desktop app polish** `[v3.5.0]` — in the desktop app, dragging across UI
  chrome no longer highlights it (chat, code, diffs and the terminal still
  select), buttons use the arrow cursor, links and images cannot be dragged
  out, and a window in the background dims its highlights. The webview's
  Reload / Back / Inspect menu is gone: right-click on a link in the chat
  offers **Open link** / **Copy link**; text fields and
  selected text keep the native menu.
  - Tooltips wait half a second before appearing, then show at once while you
    move along a toolbar, and only open on keyboard focus, not after a click.
  - Search, palette, find, title and worktree fields, and the desktop
    composer, no longer autocorrect or curl quotes.
- **A quieter desktop** `[v3.48.0]`. The layout of sidebar, chat, Review
  panel and status bar is unchanged.
  - Each turn shows the model, the time and Edit once, under your message,
    and only while you hover or focus it. The answer's footer keeps the
    duration, the cost and Copy response.
  - The New session screen names the workspace once and drops the hint
    line and the branch chip.
  - Sidebar rows show their status mark and age at rest. A missing folder is a
    small ⚠ with a tooltip, and worktrees show as a count.
    Its menu offers **Locate folder…** `[v3.51.0]`: pick where the folder is
    now (a renamed or moved repository) and its sessions, worktrees,
    scheduled tasks and groups move with it, after a confirmation that counts
    them; the row takes the new folder's name, a workspace already at the new
    folder merges in, git links in the worktrees are repaired, and the move
    waits while a session there is running.
  - Model pickers name the provider once, as a group header.
  - The Review panel's tab strip keeps +, Maximize and a ⋯ menu.
    Menus show their keys (F2, ⌫, ⌘W).
  - Scheduled tasks open as a Review panel tab, with an overlay only when no
    workspace is open.
  - Settings and Usage use the same overlay frame as every other panel.
- **A desktop app that keeps what needs you in sight** `[v3.49.0]`. The
  phone's run and status pieces now work on desktop too, at desktop size.
  - A question from the agent is pinned above the composer until you answer
    it, with the orange frame of *Needs you*; the transcript says **Answer
    below** where it was asked. Its number keys and ⌘↵ answer it once focus
    is in it.
  - A plan waiting for review keeps a **Plan awaiting approval** bar above
    the composer, with its revision and **View**, which brings the Plan tab
    forward.
  - When the server stops answering, the status bar says **Can't reach**
    beside its name, the banner adds **Retry** and, in the desktop app,
    **Start built-in server** (or **Use built-in server** when a remote one
    is down), and Send is disabled with the reason while your draft stays in
    the box.
  - A session whose folder was moved or deleted shows one line under the
    header, **{folder} was moved or deleted**, with **Open workspace…** and
    **Hide from sidebar**, instead of a card over the transcript.
  - **Session not found** also offers **Find a session ⌘L** beside **New
    session**.
  - A diff tab's **Wrap lines** toggle is on desktop too: diffs still wrap
    by default, and the toggle keeps long lines whole so they scroll
    sideways.
  - The composer's model chip names the model in the interface font
    (`claude-sonnet-4-6 · High`) rather than `provider:model` in code type;
    hovering it shows the full `provider:model` and its shortcut, and the
    picker still lists models by provider.
  - A long draft grows the message box to six lines, then scrolls inside
    it, and a thin thumb beside the text shows how much more there is.
  - The **/** and **@** menus end with the keys that drive them (**↑↓**
    navigate, **↵** run or insert, **Esc** close). **/new** and **/model**
    show their shortcuts (⌘N, ⌘.), and a file reads name first, then its
    folder, so a deep folder no longer cuts the file name off.
  - A table wider than the chat fades out at its right edge while there is
    more to scroll to, as on the phone.
  - **Search sessions** in the sidebar opens with **⌘⇧F** (Ctrl+Shift+F),
    showing the sidebar first if it was hidden. Matches sit under their
    workspace with a count (**openagentd · 3**) below a summary (**6
    results · 3 workspaces**), the matched text is marked in each title,
    rows show their age, and **↓** moves from the field into the results.
  - **Switch Workspace/Session** (⌘L, ⌘⇧L) leads each row with the
    sidebar's status mark. A session that needs you lists first, then the
    running ones, then the rest by recency; a workspace with a session
    waiting or running says **Needs you** or **Running** and lists right
    after the current one.
  - **Keyboard shortcuts** (⌘/) opens with a search field in focus that
    filters by name, key (`F6`) or area (`terminal`), and lays the areas out
    in two columns on a wide window. Its intro spells the overlay keys for
    the platform (Ctrl+K, Ctrl+P and Ctrl+, on Windows and Linux).
  - The command palette (⌘K) opens on a **Recent** group, the last five
    commands and sessions you ran from it, and a search marks the words you
    typed in each row's name.
  - The palette always lists **Open Plan** and, in a workspace, **Goal**,
    even before the session has a plan or a goal; their descriptions then
    say how one starts (Plan mode; approving a plan with **Keep going until
    done**).
  - The keyboard focus ring shows whole on segmented controls, tabs, menu
    and palette rows, settings lists, the status bar and the header's
    sidebar button, instead of being cut to a bar on one side, and **Tab**
    no longer walks out of Settings into the window behind it.
  - An MCP call the agent could not make because its server needs sign-in
    offers **Sign in to {server}** right under the call (or **Open in
    Settings** for a server the app cannot sign in to), and reads **Signed
    in to {server}** once it is connected, so you no longer have to find
    Settings → Connectors from the agent's reply.
  - A view that fails to render (a session's transcript, the Review panel)
    shows **Couldn't show this view** with **Try again** and **Copy error
    details** in its place, while the header, sidebar and status bar keep
    working; opening another session clears it. Any other screen's error
    shows the app's own page (**Try again**, **Reload**) instead of the
    router's plain one.
  - A sidebar list with more sessions to load says how many the next click
    adds (**Show 5 more**, or **Show 2 more** when that is all that is
    left) instead of a plain **Show more**.
  - A terminal tab whose shell is running a command (a build, a dev server,
    `sleep`) shows the running spinner in place of its icon, and its
    tooltip reads **Terminal 1 · Running**, so you can see which tab is busy
    before you close it.
  - Each scheduled task's row has an on/off switch beside its **⋯**, as on
    the phone, so pausing or resuming a task is one click that does not
    open it. **Pause** and **Resume** stay in the menu too.
  - Opening a folder the sidebar did not list yet (**Open workspace…**)
    says **Added {folder}** as it opens the new session there; a folder
    that was already listed just opens.
  - The task form says when a new schedule runs, not only for cron: a
    repeating task adds **If you save now: Nov 7, 14:50** to "The first run
    is one interval after you save", and a one-time task reads **Runs in
    3h (Asia/Ho_Chi_Minh)** under its date, or warns in orange that a time
    already gone **runs as soon as you save**.
  - A diff tab's **Side by side** toggle lays the old file beside the new
    one: each removed line sits next to the line that replaced it, context
    on both sides, each column wrapping on its own. The choice is kept for
    every diff tab. While the Review panel is too narrow for two columns
    the diff stays unified and the toggle says so; maximizing or widening
    the panel brings the columns back.
- **macOS overlay + Tauri drag region** `[since v1.0]` — the header doubles as the
  window drag region; macOS gets the proper traffic-light overlay.
- **Restored desktop window size** `[v1.52.0, updated v3.31.0]` — desktop windows reopen at the
  last normal size saved on quit, while minimized/maximized dimensions are ignored.
  Since `[v3.31.0]` the main window also reopens where it was. If that screen
  is no longer connected, it is moved onto one that is. New windows opened
  from an existing one only take its size. Since `[v3.62.0]` every window
  that was open reopens where it was (see *Windows come back when the app
  opens*).
- **Desktop shell polish** `[v3.31.0]`:
  - Before the UI loads, the window background uses the theme you picked in
    the app, even when it differs from the system theme, so it no longer
    flashes light paper.
  - Sessions, files and settings keep loading with Wi-Fi off, because the
    builtin backend runs on your machine.
  - A crash of the desktop shell is written to `desktop.log`.
  - On Linux machines with an NVIDIA driver, the app turns off WebKit's
    DMABUF renderer unless you have set `WEBKIT_DISABLE_DMABUF_RENDERER`
    yourself. This avoids a blank window.
  - In the sidebar, ↑/↓ move between rows, and Home/End jump to the first
    and last row.
  - On Windows and Linux, Alt+←/→ go back and forward, like ⌘[ / ⌘] on
    macOS. Text fields and the terminal keep Alt+arrow for moving by word.
  - When a session starts needing you while the window is in the
    background, the Windows taskbar button flashes and the macOS Dock icon
    bounces once.
  - Files dropped anywhere in the window, including the sidebar and the
    dock, attach to the message being written.
