---
title: "Features: The app: Review panel"
description: "The Review panel: panes and views, Git, files, the file viewer, previews and tasks."
---

# The app: Review panel

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Reliable Git history paging** `[v2.11.0]` — commit and graph pages advance
  together in single-branch and all-branch views. Commit lists provide an
  explicit Load more action and a retry action for failed history requests.
- **Review panel panes, as in an editor** `[v3.40.0]`:
  - There is no bottom dock: the sidebar sits left (`⌘B`/`Ctrl+B`) and the
    Review panel right (`⌘D`/`Ctrl+D`), full window height. The header keeps
    one button for each.
  - On desktop the sidebar and the Review panel run up to the top of the
    window, as in a native app: the header splits where they do, with the
    sidebar toggle (and, on macOS, the window buttons, with a native gap
    before the toggle) over the sidebar, the title right after the toggle
    (it stays put when the sidebar opens or closes `[v3.43.0]`), and the
    Task list and Review panel buttons over the panel. The header reads as
    one bar: no lines between those parts, and one line under all of it,
    over the sidebar too. The split follows a drag or a slide. The
    Review panel's tab strip shares the sidebar's tone, and its open tab is
    marked the way the sidebar marks the open session.
  - **Split Review Panel Right** (`⌘\`/`Ctrl+\`) and **Split Review Panel
    Down** (`⌘⇧\`/`Ctrl+Shift+\`) split the pane you are in, as often as
    there is room; each pane has its own tabs. The new pane is empty and lists
    what it can open. A pane too small for two says so instead of splitting.
    Drag the line between two panes to resize them, or double-click it to
    share the room evenly; closing a pane's last tab closes the pane.
  - With several panes, the one you are in is plain to see: the tabs and
    buttons of every other pane fade to half, as an inactive window's title
    bar does, so it is clear where `⌘W`, `⌘1`–`⌘9` and a newly opened file
    go. A click into a web preview page focuses its pane too.
  - Drag a tab to another pane's tab strip to move it there, onto the middle
    of a pane to add it to that pane, or onto a pane's edge to split that pane
    with the tab in the new half; the place it will land lights up as you
    drag. Escape puts it back. The tab menu does the same with Split Right,
    Split Left, Split Up, Split Down and Move to Next Pane, and a web preview
    keeps its page and comments when its tab moves.
  - **⌃⌥ + arrow** (`Ctrl+Alt` + arrow on Windows and Linux)
    sends the focused tab left, right, up or down: the pane splits on that
    side with the tab in the new half, or, when it is its pane's only tab,
    the tab joins the pane on that side (with no pane there, an empty one
    opens, as with `⌘\`). The keys work from the composer and from a
    terminal too, and the tab menu shows them beside its four splits.
  - A terminal is a tab like any other: it opens in the pane you are in,
    beside its files, and a split puts a diff and a shell side by side.
    There is no terminal pane under the others any more, and nothing hides
    one. Terminals have no key: **Open Terminal** in the command palette
    (and the View menu) shows the last terminal, or starts a shell when
    there is none, and the panel's **+** menu and launcher start a new one.
    `⌘⇧` (`Ctrl+Shift`) with the backquote key no longer opens one, and a
    focused terminal keeps Control and the backquote key for its shell.
    Shells keep running with the panel closed, and the status bar says
    **N terminals running** (a click shows them).
  - Tabs work like an editor's: views (Git, Plan, Tasks…) come first, then
    files. A file or diff opened from a list or a link opens as an *italic*
    preview tab that the next one replaces; double-click it or choose **Keep
    Open** to keep it. When the strip is full, a tab count lists every tab.
    The tab menu has, in groups, Close, Close Others, Close to the
    Left, Close to the Right, Close All (the pane goes with its tabs); Keep
    Open, Split Right, Split Left, Split Up, Split Down, Move to Next Pane,
    Move Left, Move Right; Copy Path and Reveal in Git.
  - Closing the open tab goes back to the tab you used before it
    in that pane (it used to show its right neighbour); a double-click or
    right-click on the free end of a tab strip opens its **+** menu where the
    pointer is; and besides `⌃Tab`/`⌃⇧Tab`, `⌘⇧]`/`⌘⇧[` on macOS and
    `Ctrl+PageDown`/`Ctrl+PageUp` on Windows and Linux step through the
    focused pane's tabs (in the desktop app; browsers keep these keys).
  - Each session remembers its own panes and tabs, so switching back shows
    the same diff and plan; terminals belong to the workspace; whether the
    panel is open, and its sizes, belong to the window. **Reset Layout** in
    the palette puts the sizes back.
  - In a narrow desktop window the sidebar and the Review panel still sit
    beside the chat while they fit (the panel down to 740px of chat and
    panel together); with the panel open and no room left, the sidebar opens
    as a drawer over the chat `[v3.40.0]`. On a touch tablet the sidebar is a
    drawer below 1180px, and when the chat and the panel share less than
    860px (an 820px tablet in portrait) the Review panel covers the
    transcript but not the composer, so you can write while reading a diff;
    maximized
    (`⌘⇧D`/`Ctrl+Shift+D`) it covers both until you restore it or press
    Escape. Maximizing grows the whole panel with every pane in it; before,
    with several panes only the focused one showed.
  - Showing or hiding the sidebar or the Review panel slides it in or out
    (a quarter second); its rows ride the moving edge instead of rewrapping,
    and the composer keeps its focus and draft. With the Review panel open,
    the panel slides to its new width alongside the sidebar, so the chat
    between them moves in one motion. Dragging an edge or resizing
    the window still moves it at once. Workspace session lists, a session's
    subagents and the Reader view's folded steps open and close with the same
    smooth fold; the chosen segment of a segmented control (Code / Plan,
    Changes / History…) slides to the new choice, and switches ease their
    thumb to a soft stop.
  - **Find in Session** (`⌘F`/`Ctrl+F` while in the chat) searches the
    loaded conversation, with the match count and ↑/↓ to step through.
  - `F6` / `Shift+F6` move between the sidebar, the transcript, the composer,
    each Review panel group and the status bar.
- **Review panel views** `[v3.40.0]`:
  - **Changes**: a click on a row shows its diff in place, and **Open diff
    in tab** is in its menu.
    Every row has **⋯** with the same items as right-click and the
    long-press sheet.
    Each row leads with the file name, its folder after it in muted text,
    so files in one deep folder no longer look alike; an empty list says
    **No changes** once. The status letter takes its lines' color: **A**
    green, **D** red, **M** orange (all three were orange).
  - A tab's close button is always visible, dimmed on tabs that are not
    open; terminal tabs show it on touch too.
  - **Git**: History is the current branch's commit list, with no graph
    view or All branches toggle (a stored graph view opens as the list).
    History rows are 28px (36px on touch), and a failed load has **Retry**.
  - **Scheduled**: **New task** is a regular button, and **Run now**,
    **Pause** and **Resume** sit in each task's ⋯ menu, in words, on every
    platform.
  - **Preview**: the address field is taller, and a dimmed Back or Forward
    says why. Annotating a page is called commenting everywhere: **Comment
    on an element**, **Stop commenting**, and the composer chip reads
    "Preview comments · 2 comments".
    While a page loads, a thin bar runs along the address field. A dev
    server that is not up yet shows "Nothing is running on localhost:5173
    yet" in the app's own colours (dark mode too), with Back, Forward and
    Comment off until it starts. The console starts afresh on each new page,
    so a stale error count does not outlive a reload. Esc anywhere in the
    tab stops commenting. The address bar turns away other sites
    (`example.com`, `https://…`) in place instead of opening a broken tab,
    takes `0.0.0.0:8000` as this computer, and types like a browser's (no
    capitals or corrections, a URL keyboard with Go); an address error has
    no pointless Retry and clears as you edit. `⌃⌥` + arrow and `⌃Tab`
    work from inside the page too.
  - **Models** in Settings → Models: the Shown / Hidden toggle and Copy
    are always visible and touch-sized.
- **The agent can use a preview without the Preview tab open** `[v3.42.0]`:
  while the app is open on desktop, a page the agent opened stays loaded out
  of sight when no Preview tab shows it (the tab was closed, or **Previews**
  is set to Manually), so snapshot, click, fill and the console keep working. It is
  dropped after 15 minutes without agent use, and opening the Preview tab
  takes over from it. Focus the page takes (a fill) goes back to where you
  were typing. A page action right after `open` waits up to 8 seconds for the
  page to load instead of failing at once. Phones still need the workspace's
  Preview sheet.
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
  On desktop with a workspace, clicking a file or image attached to a sent
  message opens it as a review-dock tab beside the chat instead (one tab per
  upload, with Open in new tab and Download); phones, sessions without a
  workspace, and still-sending uploads keep the lightbox `[v3.24.0]`.
- **Unified download architecture** `[v1.92.0]` — FileLightbox, workspace
  downloads, and coding-workspace downloads share one download path instead of
  three duplicated blob-to-base64 implementations; iOS downloads now present a
  native `UIActivityViewController` share sheet instead of silently failing.
- **Workspace files panel** `[since v1.0, v1.92.0, v1.93.1]` — every file the agent reads,
  writes, or generates appears in the left drawer as a recursive, VSCode-style
  collapsible file tree with folder chevrons, depth indentation, and
  material-icon-theme file/folder icons `[v1.92.0]`, covering ~150 popular
  extensions (jsonl, astro, svelte, vue, mdx, csv, most languages, media and
  archives) and well-known
  files such as `package.json`, lockfiles, `Cargo.toml`, `README` and
  `AGENTS.md` `[v3.14.0]`. Click to preview or
  download; desktop downloads use a native save dialog instead of navigating
  away from the app `[v1.52.0]`. Image previews in the coding
  workspace panel open in the shared full-screen lightbox on click
  `[v1.93.1]`; videos play inline in the panel with native controls
  (including fullscreen) instead of opening the lightbox `[v3.14.0]`.
- **Todos panel** `[since v1.0]` — task board with a topbar progress badge
  `<finished>/<total>` `[v1.17.0]`. Live invalidation.
