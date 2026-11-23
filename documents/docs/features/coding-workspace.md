---
title: "Features: The coding workspace"
description: "Working in a project folder: worktrees, snapshots and undo, Git, LSP, and workspace rules."
---

# The coding workspace

Part of the [feature catalogue](../features.md), under *3. The coding workspace*. The index explains the version tags.

The coding workspace (`/`) opens a local project folder and runs a workspace-aware
agent against it.

- **Open any local project folder** `[since v1.0]` — server-local paths only.
  Coding mode shows file tree + live git diff (staged, unstaged, and untracked
  files) in
  the side drawer. Desktop uses the native folder picker only for the bundled
  sidecar or loopback backends; LAN/external backends use the web folder browser
  so the selected path exists on the backend host.
  Since `[v3.32.0]` the Git Changes list is complete even when the combined
  diff is too large: it lists every changed file (up to 5,000), shows 200 rows
  at a time with **Show more**, and loads each file's diff only when you
  expand it, so opening Git → Changes on a large change set stays fast.
- **Git worktree sessions** `[v1.41.0, v1.61.0]` — create an isolated git worktree
  from an existing coding workspace, start a new coding session in that worktree,
  list existing worktrees, edit sidebar titles without renaming git directories,
  and remove OpenAgentd-managed worktrees. Removing a worktree asks for confirmation
  first, warning that uncommitted changes will be lost `[v1.101.0]`.
  Since `[v3.54.0]` removing a worktree keeps its branch when the branch has
  commits that are on no other branch, and the confirmation says so before
  you confirm ("Branch X has 2 commits that are on no other branch, so the
  branch is kept."). A merged branch is still deleted with its worktree.
  Since `[v3.50.0]` new worktrees go to `~/.openagentd/worktrees/<repo>-<key>/<name>`
  (`OPENAGENTD_WORKTREES_DIR` moves them) instead of the data folder, which
  agents may not read, so a lead can read the worktree it sent work to.
  Worktrees made before stay where they are and are still managed and cleaned
  up.
  Since `[v3.1.0]` these actions live in the repository's checkout menu (see
  **Compact coding sidebar**), where **New worktree…**, **Rename** and
  **Remove** act on the worktree the list is narrowed to.
  Since `[v3.36.0]` workspaces are grouped by their git repository rather than
  their path: a worktree created outside the app, or a subfolder of a
  repository opened on its own, is listed under that repository instead of as a
  separate one (existing workspaces are re-filed once at startup). A checkout
  whose folder no longer exists shows a **Missing** badge. Removing a worktree
  also deletes its `openagentd/` or `oad/` branch.
  Since `[v3.58.0]` the list follows git and the disk instead of keeping old
  records. A worktree or subfolder removed outside the app (`git worktree
  remove`, deleting the folder, an agent cleaning up) drops off on the next
  sidebar load, and its sessions stay listed under the repository with its
  name as their tag. **Missing** is now only for a repository whose own folder
  can't be reached (moved, or on an unplugged drive), and its checkouts are
  then left as they are. Worktrees git lists that no session has opened yet
  are listed too; one made outside OpenAgentd is marked **external** and can
  be hidden but not deleted from the app. Subfolders follow the worktrees
  under a **Folders** heading in the checkout menu, and the new-session folder
  chip shows them with a folder icon. Deleting the last session of an
  OpenAgentd worktree removes the worktree too, unless it has uncommitted
  changes or commits that are on no other branch; a toast says which.
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
    stays loaded underneath. While maximized, the Plan and Side questions tabs
    keep prose at about 88 characters a line and give tables, code and
    diagrams a wider band, up to 960px, rather than the full width
    `[v3.28.0]`. Tabs close
    with ×, middle-click or `Ctrl/⌘+W`, and focus moves to the neighbouring tab.
    Since `[v3.33.0]` switching to another tab and back returns the Plan, a
    file, a diff, a commit, Tasks, Goal, an attachment or a Git view to where
    you were reading (kept while the app runs).
  - **Movable dock tabs and Git on demand** `[v3.5.0]` — the dock works like
    an editor's tab bar.
    - A new dock opens empty, on a launcher with Git, Terminal, Preview and
      Open File; since `[v3.40.0]` it lists everything the tab strip's **+**
      menu does (Git, Goal, Plan, Tasks, Side questions, Scheduled tasks, then
      Terminal, Preview and Find file), so nothing needs the menu while the
      panel is empty. Git is an ordinary tab you can close and move; it opens from
      the status-bar branch, `⌘⇧G` / `Ctrl+Shift+G`, **Open Git** in the
      palette, or the launcher. `⌘D` is **Toggle Review Dock**, and `⌘W` on
      the empty launcher closes the dock.
      Since `[v3.40.0]` opening the panel with nothing in it puts focus on
      the launcher's first row, so ↓/↑ (Home, End) and Return pick what to
      open; a panel that comes back with its tabs, or opens on a tab, keeps
      focus where it was.
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
    - **+** in the dock's actions opens any tab while others are open: Git,
      Plan, Schedule, Terminal, Preview and Open File, plus Tasks and Side
      Questions on desktop. Open tabs are checked, and picking one shows it.
      On phones the strip keeps just **+** and Refresh `[v3.23.0]`.
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
    **⌘W** / **Ctrl+W** closes the Browser tab, also while the page has focus.
    **Design** (or **⌥C** / **Alt+C**, also while the page has focus) turns on
    an element picker: click an element, write a comment, and a numbered pin
    stays on the page; picking stays on for the next element. Comments can be
    edited in the list. **Send to agent** attaches the comments to the
    composer as one **Design feedback** chip; add your own instruction and
    send. The chip's **×** puts the comments back in the Browser tab's list.
    The agent gets each element's selector, text, opening tag and key styles
    and, for React (18 and 19), Vue or Svelte dev builds, 30 lines of its
    source, attached like an `@path#Lx-Ly` mention. React 19 sources come
    from where the JSX ran, mapped through the dev server's source maps.
    In the chat the feedback shows as a card of numbered comments, and
    restoring the message (undo, edit, history) brings the chip back. The card
    also shows after a reload, with or without text before it `[v3.6.0]`.
    While the agent uses the page, the toolbar shows **Agent**.
    Tabs keep their page and comments while another tab is open.
    The iOS and Android apps, and a desktop window connected to a remote
    server, show previews too `[v3.23.0]`: the app relays the page from its
    own `127.0.0.1` port to the server, so the page still never sees the
    access key. That needs a server with an access key, and a reverse proxy
    in front of it must pass WebSocket upgrades. **Open in browser** is off
    there, and a plain browser on another device shows a notice instead.
    A computer opened through your OpenAgentd account shows previews the
    same way `[v3.55.0]`, on the phone apps and in a desktop window, over
    the account link and with no access key; before, the tab stayed blank
    there. When the app cannot reach the preview (the server restarted, the
    preview was closed, the link dropped, too many connections), the tab
    says why and offers **Retry** in place of a blank page `[v3.55.0]`.
    After the app was in the background or the computer slept, the tab
    reconnects by itself `[v3.55.0]`: a page that still answers keeps its
    scroll position and form input, and only a page that no longer answers
    loads again. Hot reload also works for a dev server on
    `https://localhost` with a self-signed certificate `[v3.55.0]`.
    Since `[v3.29.0]` the address bar also opens workspace files from any
    Browser tab: type a path from the workspace root (`docs/mockup.html`,
    `./docs/mockup.html`) or paste a full path or `file://` link inside the
    workspace. From a dev-server tab the file opens in its own Browser tab; a
    path that is not a workspace file shows an error in place (start with `/`
    for a page on the dev server). The "Nothing is running" page says so.
    Local HTTP(S) links in workspace chat responses open in Preview instead
    of a browser tab, including `localhost`, `127.x.x.x`, and `::1` targets
    `[v3.29.0]`. The link menu's **Open link** does the same; public web links
    and clients without Preview keep their existing browser behavior.
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
  the session model (moved to the run deck in v3.40.0), and the last 24 hours of spend (a click opens Telemetry on
  that range); scheduled tasks and the theme moved to the sidebar, the palette
  and Settings. In light mode the header, sidebar, status bar and chat share
  one page tone; dark mode sets the chrome on a darker rail. The sidebar opens expanded on windows at least 1280px
  wide and resizes between 220 and 440px. The dock takes a share of the chat
  area and always leaves the chat at least 400px; on narrower windows it opens
  over the chat instead. Both dividers resize by drag or keyboard (arrow keys,
  Home/End, Enter to reset), and the layout is remembered.
  - **Git Commits in workspace dock** `[v1.70.2]` — additional sub-tabs inside the "Changes" panel to see the current branch's recent git commits. The commits list supports high-performance cursor-based infinite scrolling (fetching more commits on scroll using a native `IntersectionObserver`) and inline expansion to view the files modified in any commit and their interactive diff previews. **Workspace Git UI state (including the selected sub-tab, expanded commits, and expanded file diffs) is persisted in the local browser state, maintaining your context across dock toggles and workspace switches** `[v1.73.0]`.
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
  Since `[v3.18.0]` the header's **View options** menu groups sessions by
  **Project** (the folder tree, the default), **Status** (Needs you · Working ·
  Recent), **Date** (Today · Yesterday · Previous 7 days · Previous 30 days ·
  Older) or **None**, and can hide row details (age, worktree tag, workspace
  name). Since `[v3.22.0]` every list is in **recent activity** order (the
  **Sort by → Created** choice is gone) and Date groups by last activity.
  The choice is kept per device. Outside Project mode the list is one flat list
  across workspaces, each row naming its workspace, and the header gains a
  **New session** button; on phones that button is there in every mode.
  Since `[v3.36.0]` the sidebar has no New session button in any mode: start
  one from a folder's **+**, `⌘N`/`Ctrl+N` or the command palette.
  Since `[v3.21.0]` repository rows show a coloured dot per workspace group,
  and in Project mode **View options → Workspace group** shows one group's
  repositories (Chat stays), named in a row above the list with **Show all**.
  Since `[v3.21.0]` **Recent activity** means the last message, not creation,
  a rename or a model switch: a session moves to the top when a turn starts or
  finishes, sliding into place rather than jumping, and the row's age keeps
  counting while the app is open.
  Since `[v3.39.0]` it also moves up when a message is queued on it, and an
  older session past a repository's first rows moves to the top of that
  repository too.
  Since `[v3.22.0]` Project mode orders repositories too: Chat, then those in
  a workspace group (clustered by group, in the groups' order), then the rest,
  each part most recently active first.
- **Pinned sessions** `[v3.18.0]` — **Pin** (a row action left of Edit on
  desktop `[v3.19.0]`, first in a session's context menu, or in the long-press
  sheet on mobile) moves a top-level session into a **Pinned** section at
  the top of the sidebar, from any workspace, with its workspace name. Pins are
  stored on the server, so they follow you to other windows, the browser and
  the mobile app, and pinning does not change a session's place in Recent
  activity. **Unpin** puts it back in its list. The section folds and hides
  when nothing is pinned.
- **New-session screen** `[v3.18.0, updated v3.20.0, v3.22.0]` — **New session** (the folder's **+**,
  `⌘N` / `Ctrl+N`, the palette, `/new`) opens a draft at `/?workspace=<path>`
  instead of creating an empty session: nothing is saved until the first
  message, which creates the session and swaps the URL for its id, so an
  abandoned New session leaves no "Untitled" row behind. The screen asks
  *What should we build in {folder}?* (*Ask anything* in Chat), shows the
  branch, and has a folder chip that switches folder (filterable, with
  worktrees and **Open folder…**), a row of recent folders, and the folder's
  recent sessions. Text typed in a draft is kept per folder across reloads and
  carried along when the folder changes. On desktop the composer sits in the
  middle of the screen; on phones it sits at the bottom. Sending the first message
  carries the screen into the chat: the centered composer glides to the bottom
  while the transcript fades in (instant with reduced motion), then collapses
  once it lands, as after any other send `[v3.22.0]`. Opening a folder registers it in the sidebar
  right away, and a session that the first message creates in a new folder
  adds that folder to the tree. The Code / Plan toggle works before the
  session exists: the first message starts the session in the picked mode, and
  switching the draft's folder keeps it `[v3.20.0]`.
- **Nested subagent sessions in the coding sidebar** `[v2.16.0, updated v2.17.0]` — lead sessions with
  delegated subagents render an expandable accordion of child sessions behind a
  count pill with an activity dot, so background work stays visible. Since
  `[v3.32.0]` the accordion starts collapsed and opens on its own only while a
  child is selected; it used to open whenever the lead was selected or a child
  was running or waiting on the lead. Individual child rows
  can be deleted from the sidebar with instant cache pruning `[v2.17.0]`, falling back cleanly to the
  parent lead session, and opening one shows a read-only banner with a
  **Return to Lead** action.
  Since `[v3.1.0]` the count pill beside the title is the toggle, so sessions
  without subagents keep no chevron gutter, and child rows sit flat under the
  lead's title without another indent guide.
  Since `[v3.29.0]` a running subagent opens with its transcript and live
  output; it used to open blank, under the lead agent's name.
- **Rename sessions in place** `[v3.0.0]` — the pencil, a double-click on a
  sidebar row, or **Edit title** in its menu turns the title into a text
  field. Enter or clicking away saves, Escape cancels, and the header and
  sidebar show the new title at once. Since `[v3.25.0]` the session title in
  the desktop chat header is read-only; rename from the sidebar.
  Renaming from the header came back in v3.40.0 and is gone again since
  `[v3.44.0]`: in the desktop app a press on the title drags the window and a
  double-click maximizes it, as on the rest of the header.
- **Session search** `[v3.0.0]` — the search button in the Workspaces header
  swaps the tree for a search field that matches session titles across every
  workspace, however old. Enter opens the first match and Escape returns to
- **Session status and unread marks in the sidebar** `[v3.0.0]` — each session
  row has one status slot: `!` while it waits for your answer, a spinner while
  it runs, and an accent dot when a turn ended while you were in another
  session or the window was hidden. Opening the session clears the dot in every
  window. Unread state stays on this device, and sessions that finish while the
  app is closed are not marked. Since `[v3.26.0]` an idle compaction no longer
  marks a session unread.
  Since `[v3.27.0]` a session whose subagents are still working keeps its
  spinner after its own turn ends (in Status view it stays under Working, and
  a collapsed workspace still lists it), and a subagent that asked its lead a
  question reads "waiting for lead" in every window rather than "working".
  Since `[v3.29.0]` this also holds for subagents listed the moment they
  start: they could read Completed while still running, which ended the
  lead's spinner (and the notch's "Working") long before their reports came in.
- **Sidebar row actions** `[v3.27.0]` — every sidebar row's buttons share one
  borderless 24px style (36px on touch) and appear on hover or keyboard focus
  in place of the row's age and tags, so titles and folder names keep the row
  at rest. Session rows offer **Pin** and **More**, subagent rows **More**,
  and folders **+** and **More**; More opens the same menu as right-click
  (Pin, Edit title, Delete), so delete is no longer one click from a row.
  Double-click still renames (F2 and the Delete key were dropped in
  `[v3.57.0]`). A long
  subagent title now truncates in Pinned and the Status and Date views instead
  of widening the list past the sidebar.
- **Needs you** `[v3.0.0]` — sessions stopped on a question are listed above
  the workspaces, from every workspace and however old, each with its
  workspace name and a count. The list updates as questions are asked and
  answered, and a click opens the session. The same count badges the app icon
  in the dock (macOS and Linux) and on iOS once notifications are allowed,
  and prefixes the browser tab title, e.g.
  `(2) app - Fix updater restart`.
- **Scheduled in the sidebar** `[v3.0.0]` — the bottom of the coding sidebar
  lists the next five enabled scheduled tasks, soonest first, each with its next
  run time (`18:05`, `Wed 09:00`, or `20/03`). Clicking a task opens the
  scheduler on that task, and clicking the **Scheduled** header opens the full
  list. The section is hidden when nothing is scheduled.
  Since `[v3.43.0]` it stays pinned at the bottom of the sidebar while the
  session list scrolls above it, and scrolls on its own past 224 px.
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
  inline audio playback with seek controls `[v3.13.0]`,
  extensionless text files, and binary download fallback. Copy and download
  buttons sit in the file tab header for one-click copy of the full content or
  download of the file `[v1.92.0]`.
  The viewer, attachment previews and the composer's file picker share one
  text-file list, so `.jsonl`, `.astro`, `.svelte`, `.vue`, `.mdx` and other
  common source/config files open as text everywhere; component files
  highlight as markup `[v3.14.0]`.
  Files over 64 KB open as plain text at once and gain colours when
  highlighting, which now runs off the main thread, finishes `[v3.14.0]`.
  Select lines and click **Add comment** to insert an `@path#Lx-Ly` composer
  reference; the backend auto-attaches only the selected file lines.
  Markdown files (`.md`, `.markdown`) open rendered like a chat answer, with
  tables, highlighted code, diagrams, maths and images relative to the file;
  front matter shows as a key/value table above the body (lists as chips,
  nested YAML as source, collapsed past 8 fields) `[v3.36.0]`. A **Rendered / Source** switch in the
  file tab header returns to the line-numbered source, and a `path:line`
  reference opens the source at that line `[v3.31.0]`.
  Since `[v3.40.0]` HTML in a rendered Markdown file shows as it does on
  GitHub instead of as tags: a README's centred logo and badges,
  `<picture>` (with relative images from the file's folder), `<kbd>`,
  `<sub>` and collapsible `<details>` sections. It is rebuilt from an
  allowlist, so scripts, styles, frames, forms and event handlers never run;
  agent replies still show HTML as text.
  Links and file-named code spans in a rendered Markdown file open the
  workspace file in a new tab, at the line when one is given; paths read from
  the file's folder, then the workspace root. HTML files open in Preview, and
  a missing file shows a "File not found" notice `[v3.32.0]`.
- **Open file from git changes on mobile and desktop** `[v1.92.0]` — right-click
  (desktop) or long-press (mobile) a changed file inside the Changes tab or a
  commit's detail view to open, copy, or otherwise act on that file, including
  deleted files, which render a dedicated deleted-file view in the editor panel.
  - **Copy path** copies the file's absolute path and **Copy relative path**
    its path in the workspace; right-click (or long-press, or Shift+F10) the
    name of an open file in its tab's toolbar for the same two `[v3.50.2]`.
- **Persisted coding sessions per workspace** `[v1.18.0]` — `/{session_id}`
  restores workspace context from the
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
  commands in `.agents/commands/**/*.md` `[v2.12.0]` (the `.openagentd/` and `.opencode/` folders stopped being read in `[v3.14.0]`)
  load only when a workspace is attached. Local commands win on name conflict.
  Coding chat stays global-only.
- **Snippet picker** `[v1.31.0]` — in coding workspaces, type `#` anywhere
  in the composer to pick prompt snippets from `.agents/snippets/**/*.md` `[v2.12.0]`,
  `{OPENAGENTD_CONFIG_DIR}/snippets/**/*.md`, or `~/.agents/snippets/**/*.md` and insert the rendered body.
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
  (`OPENAGENTD_SNAPSHOT_MAX_BYTES`, default 256 MiB) drops the oldest snapshots once a repo
  outgrows it; `OPENAGENTD_SNAPSHOT_SEED_OBJECTS=false` disables object reuse `[v2.18.0]`.
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
  A patch that leaves out the closing `*** End Patch` line is applied
  `[v3.56.0]`: models sometimes omit it, and every other check still runs. A
  reply cut off at the output limit never reaches a tool, so the line guarded
  nothing. Only a line that starts with the marker closes a patch, so text
  that mentions it inside a line stays content; a last line of
  `+*** End Patch` is refused, with a message saying where the marker goes.
  A hunk can narrow its search after a unique literal line with
  `@@ in: <anchor>`; ambiguous or missing anchors, and ambiguous targets
  within that scope, are rejected rather than selecting a match `[v2.5.0]`.
  Contextual `@@ class ...` / `@@ def ...` headers and context-only sequential
  locators are supported. Add and move collisions are rejected,
  while delete-then-add replacement is supported within one envelope.
  The activity header lists the comma-separated,
  deduplicated basenames of every touched file instead of collapsing
  multi-file patches into a bare count `[v1.120.0]`, with operation-aware header labels (`Create`, `Update`, `Move`, `Delete`), color-coded action badges, per-file line delta counters, and multi-file expand/collapse controls `[v2.0.0]`.
- **Interactive terminal tab** `[v1.98.1]` — a real PTY shell (the Rust
  backend's `portable-pty`, streamed over WebSocket to an xterm.js
  instance) attached to the coding workspace panel, alongside
  Changes/Commits/file tabs. Coding-mode only — there is no separate general-chat mode
  terminal. The session survives tab switches (a hidden terminal idle-closes
  after 15 minutes of no input; the backend reaper is the 30-minute
  backstop). A terminal with a command still running (a dev server, a
  build) is never idle-closed, by either reaper, on macOS and Linux `[v3.5.0]`.
  Includes PTY output backpressure, GPU-accelerated WebGL rendering `[v1.118.0]`,
  debounced SIGWINCH resizing, and mobile key bar ergonomics (touch-and-hold arrow repeat,
  soft-keyboard focus preservation).
  Terminal font is a best-guess Nerd Font stack (MesloLGS NF and similar)
  for correct Powerlevel10k/Starship glyph rendering, at 13 px (at the
  Text size since `[v3.57.0]`).
  App shortcuts work from a focused terminal: on macOS every `⌘` shortcut,
  including `⌘K` for the palette, and on
  Windows/Linux `Ctrl+K` and `Ctrl+P` skip the shell to open the palette and
  quick open. **Clear** in the terminal tab's menu clears the scrollback
  `[v3.5.0]`.
  **Rename** edits the tab's title in place instead of opening a dialog;
  `F2` or a double-click on the tab starts it, Enter or clicking away saves
  and Escape cancels `[v3.6.0]`.
  `⌘W` on a terminal whose shell is still running asks before closing it; the
  tab's close button still closes right away `[v3.3.0]`, unless a command is
  running in it, which asks first too `[v3.5.0]`.
  - Shells survive a reload, a closed window and a dropped connection
    `[v3.42.0]`: reopening the workspace brings its terminals back with their
    recent output (the last 2 MB) and their names, a dropped connection
    reconnects by itself, and a shell nobody reattaches to closes after 10
    minutes. Closing the tab still ends the shell. Opening the same terminal
    in a second window moves it there, and the first says "Opened in another
    window". A flood of output (`yes`, a huge build log) no longer freezes the
    app: the backend waits for the page to catch up. On Windows, where the
    app cannot tell whether a command is running, terminals are no longer
    idle-closed.
  - **Find in terminal** `[v3.42.0]`: `⌘F` (macOS) or `Ctrl+Shift+F`
    (Windows/Linux; plain `Ctrl+F` still reaches the shell) opens a find bar
    with a match count and **Match case**; on phones it is in the long-press
    sheet.
  - **File paths open in the editor** `[v3.42.0]`: `⌘`/`Ctrl`+click on
    `src/foo.ts:42`, `src/foo.ts:42:7` or `a/b.rs(10,3)` opens the file at that
    line, resolved against the shell's directory when the shell reports it,
    else the workspace; paths outside the workspace do not open.
  - **Add to chat** `[v3.42.0]`: with text selected, the **Add to chat**
    button or `⌘L` / `Ctrl+L` appends it to the composer as a `Terminal
    output:` code block; on phones it is in the long-press sheet.
  - On Windows and Linux `Ctrl+Shift+C` / `Ctrl+Shift+V` copy and paste
    `[v3.42.0]`, and a terminal no longer takes focus from the composer when
    it reconnects or its state changes.
    Since `[v3.62.0]` a terminal you open takes the keyboard at once, even
    from the composer, so typing right after opening it reaches the shell;
    a click elsewhere while it starts keeps the focus there.
  - **Select Text on touch** `[v3.57.0]`: on a phone or tablet a drag in the
    terminal scrolls, so before only Select All could select. A long press
    now opens **Select Text** first, which shows the output as plain text
    (opened at the lines on screen, wrapped lines joined) with the system's
    own selection, handles and magnifier; **Copy** and **Add to chat** take
    the selection, **Done** goes back to the live terminal.
  - **One terminal menu** `[v3.57.0]`: the long press opens the phone's
    action sheet, and a right-click with a mouse opens the terminal's menu
    with its keys instead of the webview's text-field menu. Since
    `[v3.62.0]` the touch sheet is four rows, Select Text, Paste, Find and
    Clear: Copy and Add to chat were greyed out nearly always (a finger
    cannot select in the terminal) and live in Select Text, and Select All
    is gone from touch. The mouse menu keeps all six.
  - **Touch gestures** `[v3.62.0]`: a drag scrolls the output, with a fling
    (it had stopped scrolling at all on touch screens); in vim, less or tmux
    it scrolls the program as a mouse wheel does. Hold, then drag sends
    arrow keys toward the finger, faster the farther it goes (up brings back
    the last command, sideways moves the cursor). A double tap sends Tab. A
    pinch sets the terminal's text size, 10 to 20 px, kept on the device
    until **Reset** in More. A long press no longer starts the webview's own
    text selection.
  - **Key bar by use** `[v3.57.0]`, **in one row** `[v3.62.0]`: the bar no
    longer scrolls. With the soft keyboard up it holds Line, Esc, Tab, Ctrl,
    ^C, the four arrows and More; with it down, Show keyboard, Esc, Tab, ^C,
    ↑, ↓, Enter and More, enough to answer a program's prompt without the
    keyboard. A swipe down on the bar puts the keyboard away. **More** holds
    Alt, ⇧Tab and the `|`, `~`, `\` and backtick keys. Ctrl and Alt are
    sticky modifiers and apply to the bar's keys too (Ctrl+← jumps a word).
    Keys removed in
    `[v3.62.0]`, and what does the same: `/` and `-` (the keyboard), ^D, ^L,
    ^R (Ctrl, then the letter), Home and End (Ctrl+A, Ctrl+E, or hold and
    drag), PgUp and PgDn (a drag), Paste (long press, Paste). On an iPad
    the bar shows while the soft keyboard is up for the terminal.
  - **Find on a phone** `[v3.62.0]` spans the terminal's width, and its
    field no longer zooms the page on iOS. The terminal on a phone has 4 px
    around its text instead of two paddings, a few more columns.
  - **Command line field** `[v3.57.0]`: **Line**, the key bar's first key
    (it stays in place while the bar scrolls), adds an ordinary text field
    above the bar where Vietnamese Telex and other input methods, dictation
    and the cursor work as in any app. Return sends the line with Enter (an
    empty Return sends Enter); the bar's keys still reach the shell while
    the field keeps the keyboard. The choice is kept on the device.
  - **Text size** `[v3.57.0]`: terminals follow Settings → Text size
    (Compact 12 px, Default 13 px, Large 14 px), live, refitting the
    terminals on screen.
  - **Command finished** `[v3.57.0]`: a command that ran 10 seconds or more
    in a terminal that is not on screen (another tab, or the Review panel
    closed) shows "Terminal 1 · Command finished" with **Show**, which brings
    that terminal up. Only the open workspace's terminals, and not on
    Windows, which does not say when a command runs.
- **Workspace status card** `[v1.18.0]` — empty coding sessions show the
  workspace path, branch, dirty state, last commit instead of the old
  agent-selection fallback. Since `[v3.0.0]` the card shows the workspace
  name and path, then its recent sessions by last activity (status, title,
  age) to reopen with a click; the branch and changes moved to the header.
- **Sessions ≥ 100 messages load completely with scroll preserved** `[v1.9.0]`.
