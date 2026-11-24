---
title: "Features: The app: look, motion and accessibility"
description: "How the app looks and moves: type and contrast, borders, motion, feedback, Simple and Full detail, and wording."
---

# The app: look, motion and accessibility

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Easier-to-read UI on desktop and phones** `[v3.36.0]` — every screen keeps
  its technical detail (tool names, commands, exit codes, model IDs, token
  counts, span names) but labels it, gives it a unit, and lines numbers up in
  a right-hand column. Terms such as p50/p95, TTFT, tok/s, cache hit, stdio
  and exit code are underlined with a dotted line and define themselves on
  hover. Codebase words are gone from the UI (`builtin` reads **built-in**,
  lead/member reads **main**/subagent, compaction reads **summarized**).
  - **One set of parts.** Rows, chips (four tones) and cards are shared, so
    the transcript, Settings, Usage and the scheduler look alike. Tool rows
    show the real tool name, its target and a short result (`shell bun test
    … · 1 failed, 11 passed` with `exit 1  2.4 s` aligned right). Each answer
    ends with one muted line (`20:13 · claude-sonnet-4-6 · 12.0 s · $0.02`)
    whose tooltip lists tokens, cache, TTFT and tok/s and links to the trace.
    Goals use one card; retries say which attempt and when. Since
    `[v3.62.0]` a prompt names its model the same way while the turn runs
    and after (`provider:model`); while it ran it showed the bare name the
    provider reported.
  - **Asks before destroying.** Stop, Regenerate, Disconnect, clearing a
    plan, deleting a task and shortening retention all confirm first. Memory
    refuses to save over a page that failed to load, and every list has a
    loading, empty and error state with **Retry**. Since `[v3.62.0]` a
    confirmation keeps its words while it closes: "Delete Alpha?" used to
    turn into "Delete group?" for a moment on Cancel.
  - **Right state.** A session whose folder is gone still opens its
    transcript under a notice; a wrong session URL says **Session not
    found**; Help opens the keyboard shortcuts; MCP never shows "Connect
    required" for a running server; the browser build hides **Updates**.
  - **Status bar** shows the server (`built-in`), the model ID with its
    provider and thinking level as chips (moved to the run deck in
    v3.40.0), and spend with its period (`$0.55 · 24h`), each with a tooltip.
  - **Review panel** (was the review dock) has one **+** (Open) button for
    views, terminals, previews and files; Refresh appears only where it
    reloads something and names what it reloads. Tab menus use sentence case
    ("Close other tabs", "Move right"). Clearing a plan asks first.
  - **Scheduled tasks** take an interval as `Every [1] [hours] = 3,600 s`
    and preview the next runs of a cron expression (an invalid one cannot be
    saved). Rows and the detail show the last run, its result and the next
    run; a recurring task never reads "Completed".
  - **Usage and traces.** Seven labeled tiles (spend, turns, turn duration
    p50/p95, TTFT p50/p95, output speed p50/p5 in tok/s, tokens, cache hit),
    tables with column headings and units. A trace lists each span with a
    type chip (agent, llm, tool, goal, summary, title) beside its raw name,
    a time ruler and legend, and a span panel that groups attributes by
    namespace (`tool.*`, `session.*`) with copy per row. Esc steps back one
    level: span, then trace, then the overlay.
  - **Settings** groups pages as App, Agents and tools, Sessions, Models and
    media, Data and safety, and About, with a search box; Providers is a
    list; Settings → Telemetry is now **Data retention**.
  - **Phones.** The header shows the session title with its workspace under
    it, and keeps five controls: sidebar, title, **Session settings**,
    Review panel and **More**, so the model and thinking level are one tap
    away (since v3.40.0 four: the model moved to the run deck under the
    composer). The sidebar drawer's
    footer has Settings, Usage, the server and the theme.
    More holds Tasks (with the open count and goal ring), Session settings,
    context use, prompt stepping, Find file, Terminal, Scheduled tasks and the
    command palette, grouped as Session, Workspace and App. Touch controls
    and list rows share one compact 36 px size (40 px in the Android app),
    and panels use tighter spacing, so an iPhone mini shows more at once;
    Usage fits a 375 px screen.
- **Fullscreen view mode and traffic-light space reclamation** `[v2.0.0]` — automatically
  detects macOS fullscreen mode and reclaims the window traffic-light header padding to
  maximise message and diff reading area.
- **Design token & UI corner-roundness ramp** `[v2.0.0]` — modernized design tokens with
  a softer corner-roundness ramp across bubbles, composer pills, dialogs, badges, and
  action states.
- **Native look, fewer borders, readable everywhere** `[v3.40.0]`:
  - Interface text uses the operating system's own font (SF Pro on macOS and
    iOS, Segoe UI Variable on Windows, Roboto on Android, the desktop font on
    Linux, the one set in the desktop's settings). Code, paths and model
    names stay in JetBrains Mono.
  - With a keyboard on an iPad or iPhone, shortcuts use ⌘ as on a Mac
    (⌘N, ⌘K, ⌘.) and their hints say so.
  - Buttons, chips, tabs and segmented controls have no borders. The primary
    button is filled with the theme's Bark colour. The chosen segment (Code /
    Plan, for example), a chosen tab or question option are filled edge to edge with a
    quiet tone a step off their track, with the normal text colour: a light
    sand in light mode (no dark brown blocks), a raised warm tone in dark mode
    (no near-white block that glows brighter than the words around it). The
    menu row under the pointer or the keyboard, the model picker's included,
    and the command palette's active row take a lighter wash than that, as a
    native list's hover, so moving the pointer down a menu does not darken
    each row it crosses. Buttons, chips and a question's options that rest on
    the light keycap fill hover half way to the chosen tone, so a hovered
    option no longer looks picked. In the
    palette only the row the keys or a real mouse move chose lights, never a
    second one under a resting pointer. Tooltips are light cards in light
    mode; a switch that is off is a light track there. With the system's
    Increase contrast on, the fills step back up. Menus, cards and dialogs
    keep one thin frame, and nothing inside them adds another.
  - **Blue is the logo and keyboard focus only** `[v3.40.0]`. Everything else
    that used Signal Blue takes the warm palette: switches, checkboxes and
    radios fill with the accent (Bark in light mode, cream in dark); file names
    in prompts and the composer, links and web results are ink with a quiet
    underline; "running", "starting" and other info chips and notices are ink
    on the keycap wash; selected text takes the sand selection fill; an open
    dropdown, pane and panel resize handles, and tab drop zones use the warm
    ramp; an achieved goal and a met Done when are green; a working goal, the
    streaming caret and live dots are ink; groups that have not picked a
    colour are never blue; autofilled fields keep the field colour.
  - Review panel tabs are borderless pills; the open tab is filled with the
    page colour and set in medium weight, with no coloured edge.
  - Dialog buttons follow the operating system: Cancel then the action on
    macOS, iOS and Linux, the action first on Windows. The footer has no
    border or fill of its own.
  - Settings → General is now **Appearance**, with a new **Text size** choice
    (Compact, Default, Large) remembered per device. Default is 1px larger than
    before (13px interface text, 12px captions); Compact keeps the old density.
    On iOS the system text size multiplies on top. **Previews** chooses whether
    a page the agent previews opens in the Review panel by itself or waits
    until you open it from its card (**Manually**).
  - Every text colour pair reaches WCAG AA with the existing palette: subtle
    text moves to the muted tone on washes and cards, coloured words and light
    mode status dots use their darker text tone, and checkbox and radio
    outlines are heavier.
  - Nothing appears on hover only: copy buttons, close buttons, turn actions
    and expand chevrons are always visible (dimmed until used). A sidebar or
    commit row's Pin and **⋯** appear in place of its time on hover or
    keyboard focus; the same items are always on right-click and long-press.
  - Native tooltips (`title`) render as the app's own tooltip, with the same
    delay and look everywhere. A click, right-click or key press while one
    is still waiting to appear cancels it, so none opens over a menu.
  - The status bar is 28px with 24px items, and header controls are 36px on
    touch screens. On a phone every primary button is 44px tall.
  - Text fields' placeholders use the muted tone, which reads at AA on every
    surface.
  - In the desktop app the blue focus ring shows only while Tab or F6 moves
    focus. Closing a menu with Escape, a shortcut such as ⌘B, or typing no
    longer rings the button focus lands on. Text fields everywhere (search,
    Settings, renaming) mark focus with a darker edge, as the composer does,
    instead of a blue glow.
  - Error toasts stay until you close them, and a toast can carry an action.
    Deleting a session shows **Session deleted · Undo** for 5 seconds; Undo
    brings the session back (and reopens it if it was open).
  - Screen readers hear "Agent is working", "Turn finished" and "Needs you: …"
    for the open session.
- **Quieter and simpler** `[v3.41.0]`:
  - In dark mode a chosen segment or tab (Code / Plan, the thinking level)
    fills more softly.
  - Thinking traces always show in full; **Show full reasoning** is gone.
  - A session's menu is Open in new window, Rename, Pin and Delete
    session…; **Copy link** and **Share…** are gone.
  - Settings → Server has no separate current-server card: the connected
    server is marked **In use** in the list, the built-in server shows its
    address there, and a connected server that is not saved gets a row of
    its own.
- **Fewer buttons, fewer menus, smoother panels** `[v3.42.0]`:
  - The tray popup lists no sessions, only provider limits and actions; the
    count mark on the tray icon is unchanged. The Windows and Linux tray
    menu has no **Needs you** rows, and its **Status: …** row shows only
    while the backend is not running normally (Starting, Error, Restarting,
    Downloading or Installing an update…).
  - The notch pill no longer says **Running**: while sessions run it shows
    the spinner, the count and the title (or "N sessions"), and a goal still
    shows "Goal N/M". In the expanded list a running row shows the spinner
    in place of a **Running** chip. **Needs you**, **Done**, **Failed** and
    **Can't reach** are unchanged.
  - The turn footer has no **Undo**; **Edit prompt** already undoes the turn
    and puts the prompt back (`/undo` remains).
  - Messages (yours and the agent's) and code blocks have no app
    right-click or long-press menu (**Copy response**, **Copy as Markdown**,
    **Copy code**, and **Copy** / **Edit** on your messages are gone), on
    desktop and on phones and tablets; they keep the system menu and native
    text selection. In the desktop app, right-clicking message text or code
    outside a link shows the system menu (Copy, Look Up). The footer's
    **Copy**, a code block's **Copy code** button and your message's **Copy**
    and **Edit** buttons remain, as do the link menu (Open / Copy link) and
    the tool row menu.
  - The Plan tab's per-block **Comment** action is gone; select text and use
    the **Comment** button (on a phone, the footer), and the tab and the
    card still share one draft.
  - Code blocks, tables, diagrams and an expanded tool row's details stay at
    the text column's width instead of widening to 960px; long lines scroll
    inside their box.
  - A question card has only **Back** and **Next**, and **Send** in Next's
    place on the last (or only) question; there is no **Dismiss**, **Skip
    this question** or **Skip and send**. Next leaves an unanswered question
    to be sent as skipped, and Send is always available. The caption reads
    "N of M answered · K will be skipped" or, for one question with nothing
    picked, "Nothing picked: Send skips this question." Enter and
    `⌘`/`Ctrl`+Enter take Next or Send once the current question has an
    answer; keys 1–9 and double-click are unchanged.
  - Sliding the sidebar or the Review panel open or closed no longer
    restyles the whole page on every frame, so the slide is smoother with a
    long transcript.
  - Messages queued or steered while a turn runs sit at the bottom of the
    transcript, under the running turn, faded, as before v3.40.0; they are
    no longer in the composer's tray, which keeps the side question, the
    undo notice and the **Jump to latest** chip.
  - Typing a message that grows to several lines no longer scrolls the
    transcript up under the composer, hiding the last answer's footer.
  - The run picker's account rows (shown with two or more accounts) say what
    is left of an Enterprise or team plan's quota, not only "N% left": a
    spend cap ("$12.00 of $50.00 left", or "Limit reached"), a credit
    balance ("$84.50 left"), **Unlimited** or **No credits left**. When a
    percent window leads, the balance or cap is in the row's tooltip.
    Since v3.43.0 a reached spend cap says "Limit reached" only once the
    percent windows are spent too.
- **Readable contrast everywhere** `[v3.46.0]`:
  - Dark mode's secondary text (timestamps, hints, metadata) is a step
    brighter, as readable as in comparable dark apps.
  - The chosen option of a segmented control or tab (Theme: Light / Dark /
    System, Code / Plan, a question's options) reads at a glance; a switch
    that is off and the edge of a text field are clearly visible; keyboard
    focus in light mode is a deeper blue that shows on every surface.
  - Placeholders, the tabs of a pane without focus, close and copy buttons
    and Telemetry bars are no longer faded below a readable level.
  - Terminal output in any colour stays readable (ANSI black on the dark
    background, white on the light one), and light-mode code colours are a
    touch deeper.
  - The macOS tray's warning and status colours, the desktop pet's marks in
    dark mode and the Windows taskbar badge digits read clearly.
- **Smoother motion everywhere** `[v3.47.0]`:
  - Nothing jumps any more. If you reopen a menu or popover while it is
    closing, it carries on from where it was. Sending a message glides the
    chat to the end. When an answer finishes streaming, the rest of the text
    keeps flowing in instead of appearing all at once. "N new" scrolls
    smoothly, and tool details, attachments and queued messages fold and
    fade instead of popping in.
  - In the Review panel, closing a tab slides the tabs next to it across,
    and a new tab fades in. Maximize slides, a dragged tab lifts and lands
    on a spring, and sidebar sessions fold one row at a time.
  - Dragging the sidebar edge, the Review panel edge or a pane divider
    snaps to the default size when you get close to it. On a Mac with a
    Force Touch trackpad you also feel a tick, like Finder.
  - On phones, a drawer keeps the speed of your swipe when you let go and
    stops cleanly at the edge. Full-screen views rise as a sheet that you
    drag down to close. A pressed row lifts. The header line appears only
    once you scroll the chat under it. Stop, Approve, Deny, an answer and a
    failed send give haptic feedback.
  - Controls react like the system ones: a switch stretches when pressed
    and can be dragged, a checkbox draws its check, the selection in a
    segmented control can be slid, a menu item blinks once when chosen, a
    rejected key or URL shakes, and the keyboard focus ring settles in.
  - Details: icons such as Copy → ✓ and Send ↔ Stop swap smoothly, and
    usage, spend, token and Git `+/−` numbers roll only the digits that
    change. Badges bump when their count goes up. "Thinking…" and
    "running…" have a light sweep across them, and a finished task gets
    struck through from left to right. The lightbox grows out of the
    thumbnail you opened and shrinks back into it. Images fade in once they
    have loaded. The command palette's highlight glides when you use the
    arrow keys. Switching between light and dark crossfades the whole
    window.
  - A running session in the sidebar shows only its spinner, without the
    word "Running" or the goal icon beside it, so the title keeps its room
    and nothing moves when you hover the row.
  - Tool rows open only when you click them. A shell or any other tool that
    streams output stays closed while it runs, so the chat no longer
    unfolds and folds by itself. A row you opened stays open after the tool
    finishes.
  - With Reduce Motion turned on, all of these changes happen instantly.
- **Increased contrast and Windows contrast themes** `[v3.31.0]` — with the
  system's "Increase contrast" setting on, muted text and borders get
  stronger tones in both themes, with borders at least 3:1 against the page.
  In Windows contrast themes, keyboard focus is drawn as an outline in the
  system highlight colour, and an on switch and the chosen segment of a
  segmented control stay visible.
- **Clearer feedback and recovery** `[v3.31.0]`:
  - When the backend stops answering for about 3 seconds, a slim banner under
    the header says it cannot reach the server and is retrying, with a
    **Change server** button. It goes away once the server answers again.
    A brief stream drop does not show it.
  - Closing the scheduler's new or edit task form with changes asks
    "Discard this task?" first. A field's error clears as soon as you fix
    it, and submitting focuses the first field with an error.
  - A task list, commit or diff that fails to load shows **Retry**. Error
    messages no longer start with "Error:".
  - Skeletons and spinners appear only when loading takes longer than a
    moment, so a fast load does not flash one.
  - A session search with no results repeats the query and offers
    **Clear search**.
  - The close-terminal dialog focuses **Cancel**, so Enter no longer stops a
    running shell.
  - Screen readers announce an MCP server's state in plain words, overlays
    turn opaque when the system's "Reduce transparency" setting is on, and
    rendered markdown files keep a readable line length.
- **Smooth close animations on UI components** `[v1.77.0]` — dropdown, tooltip,
  and popover now play a 100–150 ms exit animation (fade-out + zoom-out) before
  unmounting, matching the open transitions. Dialog and sheet retain their
  existing close animations. Tooltip gains a CSS arrow and correctly appears
  over disabled buttons via a transparent span wrapper.
- **In-app toasts pause on hover/focus** `[v1.101.0]` — the auto-dismiss timer
  for toast notifications now pauses while the pointer or keyboard focus is on
  the toast, resuming with the remaining time once it clears, so a toast can no
  longer disappear mid-read.
- **Floating surfaces keep content visible** `[v3.0.0]` — toasts, the update
  card, and the language-tools prompt stack in one column instead of
  overlapping each other. The column hangs from the top right, under the app
  header (full width on phones, safe areas respected, newest toast nearest the
  top edge), so the composer and its run deck keep the bottom.
- **One way of moving** `[v3.25.0]` — everything that opens also closes, at
  the same pace:
  - Sidebar sections and date groups, changed files, Git groups and commits,
    compaction and undo notices, file reads, and provider model lists fold
    open and shut instead of snapping.
  - Right-click menus, the model picker, `/` and `@` suggestions, Jump to
    latest, the TypeScript tools prompt, the update card and side questions
    animate in; a right-click menu dismissed with the pointer fades out, while
    Escape and Tab close it at once.
  - A session title the agent writes lifts the old one out and writes the new
    one in, left to right, in the chat header and the sidebar, where its row
    holds a blue tint for a moment. Titles you rename yourself, list loads and
    session switches change without motion.
  - With Reduce Motion on, everything stills; spinners keep turning, slowly,
    and progress bars keep filling.
- **Actions answer at once** `[v3.25.0]` — no more waiting on the server to
  see what you did:
  - Renaming or deleting a session shows everywhere immediately; if the server
    refuses, the old title or the row comes back with a message.
  - The sidebar's session lists and the agent, skill and MCP server pages hold
    placeholder rows while they load, so nothing jumps when they fill.
  - MCP server switches and workspace group memberships flip on click, and
    several group changes in a row each build on the last.
  - Opening a saved session shows a loading transcript instead of the empty
    new-session screen, and New session works while it loads.
- **Controls you can hit** `[v3.54.0]` — the controls that measured smaller
  than the app's own sizes now meet them:
  - Phone: rows of the **+** menu, the model picker and the folder picker,
    the Sessions search field and **View options**, the worktree chip,
    segmented controls, Settings' search and filter fields, row actions (⋯)
    and the Git view's **Changes** and **History** tabs are 40px (44px in
    the Android app), up from 28 to 36px.
  - Phone: **Back** and **Done** in a sheet's bar, the chat title (which
    opens Session info), **Edit prompt** and **Copy prompt**, and the
    Sessions toolbar's icons each have a 44px touch area. The sheet's
    grabber no longer covers the top of Back and Done, and Edit and Copy no
    longer share part of theirs.
  - iPad: the status bar is 37px, so the server, the branch, spend and
    Settings are 36px targets (they were 20 to 24px); the model picker's
    thinking levels and search field are 36px.
  - iPad held upright: Settings lists its sections by name. The icon-only
    rail is for a narrow mouse window, where a tooltip names each icon.
  - Desktop: the server in the status bar is 24px and its target runs to the
    window's bottom edge; the worktree chip has a 24px target.
  - Phone: a tap on the Sessions toolbar (Settings, Scheduled, Usage) no
    longer sometimes closes the sheet it has just opened.
- **One app that starts simple and grows with you** `[v3.56.0]`. Fewer
  controls and plainer words for someone new, with nothing taken from a
  developer: Steer, Queue, btw, tool names and the line under a reply stay.
  - One name each. A waiting question reads **Needs you · a question** and a
    waiting plan **Needs you · a plan to review**, on the card, the bar above
    the message box, the goal's status and for screen readers (there were
    seven wordings). The Review panel's Git view is **Changes** everywhere
    (tab, launcher, **Open Changes** in the palette and status bar, **Show in
    Changes** on a tab's menu), with **Uncommitted (N)** and **History**
    inside; the plan's tab reads **Plan**; the phone's page is **Review
    panel** and its rows keep the desktop's names.
    From `[v3.57.0]` the view is **Git** again (tab, launcher, **Open Git**,
    **Reveal in Git**), with **Changes (N)** and **History** inside; a tab a
    session remembered under the old name shows the new one.
  - Sending while the agent works has the same three labels on a phone as
    on desktop, each with its one-line explanation: **Steer**, **Queue until
    done**, **Stop and send** (the phone said "Steer now" and "Send after
    this turn finishes"; the desktop said "Stop & send").
  - The model picker's thinking row always shows what is in effect: with no
    level set, a **Default** segment is lit (the model's own level) and
    picking it goes back to that. It replaces the line "Not set: the model's
    own default applies."
  - Words that only exist in the code are gone from the screen: a command's
    result reads `exit 0` or `exit 1` (not `[Succeeded]`), a subagent's
    message is **From the main agent** (not "From lead"), a task's status
    reads **To do**, **In progress**, **Done** (not `pending`,
    `in_progress`, `completed`), an empty board says **No tasks**, and an
    unreadable goal reply is headed **Goal check** (not `update_goal`).
  - One spelling: a failure starts **Couldn't …** (118 messages said "Could
    not", "Unable to" or "Failed to"), the button that tries again is
    **Retry**, what cannot come back **can't be undone**, and a computer
    that does not answer is **Can't reach** (lists said "Offline"). The
    banner for the app's own stopped engine reads **OpenAgentd stopped on
    this computer**. A test holds each of these. Since `[v3.62.0]` the
    Settings toasts follow it too ("Save failed", "Delete failed" and the
    like now say **Couldn't save …**, with the server's own text behind
    **Copy details**), and a test refuses a title of a verb and "failed".
    Since `[v3.63.0]` so do the toasts of what you do in a session: a
    refused or failed undo, redo, prompt edit, send or cancel of a queued
    message is headed **Couldn't undo**, **Couldn't redo**, **Couldn't edit
    the prompt**, **Couldn't send the message** or **Couldn't cancel the
    queued message** ("Undo failed", "Redo failed", "Message failed" and
    "Agent error" before), with the reason on the second line, and a failed
    provider sign-in from a link says **Couldn't sign in**. The test now
    refuses any title of one word and "failed".
  - **Copying from a menu says Copied** `[v3.62.0]`. Copy path, Copy link
    and the other copy items in the sidebar's and the Review panel's menus
    wrote to the clipboard and showed nothing. They now show a brief
    **Copied**, or **Couldn't copy** when the clipboard refuses, and a phone
    taps softly.
  - **Delete side questions…** names what its dialog does (the button said
    "Clear"). An empty session is headed **Ask anything**, and a workspace's
    new session **What should we do in {name}?** ("build" assumed code).
  - **One Detail setting: Simple or Full** (Settings → Appearance → Detail,
    or **Toggle Simple View** in the command palette). It replaces
    Transcript: Detailed / Reader, and search still finds it as "reader",
    "detailed" or "transcript". A new install starts in **Simple**; an
    install that already has sessions keeps **Full** until the setting is
    changed, and a style picked earlier is kept. Full is the app as before.
    Simple folds each turn's work into one row (the Reader transcript) and:
    - the model chip named the model only; from `[v3.57.0]` it names the
      thinking level and the account too, as in Full;
    - the context ring appeared once the context was 70% full; from
      `[v3.57.0]` it shows from the first message with a bare
      percentage, as in Full;
    - the status bar showed no estimated spend, and did not fetch it; from
      `[v3.61.0]` it shows the last 24 hours' spend, as in Full;
    - a retry reads as a sentence: "The model is busy. Trying again in 8
      seconds (2 of 5)." or, for a dropped connection, "The connection
      dropped. Trying again in 8 seconds.";
    - the Goal tab reads "7 of 50" and "18 minutes", and leaves tokens out
      (since `[v3.58.0]`, when goals lost their token budget);
    - the phone's run line reads "Working · 3:12", without the step;
    - a scheduled task's slug chip is not shown.
    The line under a reply, Turn details, the working row and the context
    popover are the same in both.
  - Settings → Appearance: **Open previews** is **Automatically** or **When
    I choose** (it was Previews: Review panel / Manually).
  - **Where you are decides what is offered.** Chat already had no Changes
    view; a folder without Git now has none either: no **Changes** row in
    the Review panel (it led to "Not a git repository"), no **Open Changes**
    command or key, no git probes, and no **Create worktree…** in the
    workspace's menu. There the Review panel leads with what it can show
    (**Find file…**, **Preview**, **Terminal**, then Tasks and Scheduled
    tasks), on the phone's Review page too. The workspace list says whether
    each folder is inside a Git working tree; a server from before this
    version is treated as before.
  - **Empty things take no room.** The sidebar's **Scheduled** section
    appears with the first task and stays while any task exists (paused or
    not due: "Nothing due"); with none there is no heading. The palette,
    the Review panel's "+" and the agent still create the first task. A
    workspace's menu has no **Groups** block until a group exists. The
    composer's "+" menu has no connector section until the agent has one,
    and names it **Connectors** (it was "MCP servers"). The Review panel
    lists **Goal** and **Side questions** once the session has one.
    Settings → Desktop shows the notch's and the pet's options once each is
    turned on (with both off, 12 of its 14 rows read "Turn on … to change
    this"). "No
    workspaces yet" adds: "A workspace is a folder the agent works in."
  - **The "/" menu lists what this place can use.** `/model` and `/think`
    are no longer listed (the model button under the box opens the same
    picker); `/compact` is listed as `/summarize` and `/mcp` as
    `/connectors`, which shows once the agent has a connector; `/init` is
    not listed in Chat. All of them, and the earlier names, still run when
    typed, and typing an earlier name finds the row.
  - **First run in plain words.** Start-up reads **Starting OpenAgentd…**
    with a **Use another computer** link; a failed start says "OpenAgentd
    couldn't start on this computer." with **Copy details** (the message,
    the error, the version and the log's path). The model card leads with
    **Sign in with a subscription you have**, then **Or paste an API key**,
    and says a model running on this computer (Ollama) shows up on its own;
    once connected it says which model replies use and where to change it.
    A first Chat says, under the message box, that it works in your home
    folder and that Undo needs a folder, with **open a folder** as a link
    (the note leaves once Chat has a session). The message box always
    reads "Ask anything…" (a phone said "Assign a task to the agent…"), and
    in Plan mode "Plan mode: the agent reads and writes a plan. It changes
    no files." Until a model is connected the model button reads **No
    model** (it showed the placeholder `__PROVIDER_MODEL__`), and a
    message sent before then shows no model on its row (it showed the
    same placeholder until the answer arrived).
  - **Opening a folder asks about the folder**: "Let agents work in
    {folder}?" says they can read, change and delete files there and run
    commands, and that Undo in the chat brings back files they edited, up
    to 2 MB each. The button is **Allow and open** (it was "Trust this
    workspace?" and "Trust and open").
  - **Undo instead of a dialog.** Deleting a session no longer asks first:
    the row leaves and a **Session deleted** toast offers **Undo** for 10
    seconds (it was about 5, after a dialog). A session whose agent is still
    working keeps the dialog, since Undo does not restart it. **Hide from
    sidebar** now says what happened ("Hid {name} from the sidebar. Its
    sessions are kept. Open workspace… brings it back.") with **Undo**.
  - **A failure toast is a sentence.** A reason the server wrote for people
    stays on the toast; a status line, JSON or a stack goes behind **Copy
    details**, with "Try again, or copy the details for a bug report." (Git
    errors keep Git's own words.)
  - **Updates in one line.** The desktop downloads a new version on its own
    and then asks once: "OpenAgentd 3.56.0 is ready", **Later**, **Restart
    to update**. While agents are working the button reads **Restart when
    agents finish** and the restart waits for them (**Restart now** and
    **Cancel** while it waits). The card that could be dragged, minimized
    to a pill and expanded, and its separate Download step, are gone;
    **Check for Updates…** in the app menu answers in a toast, and Settings
    → About downloads a found update the same way and keeps the release
    notes. Android keeps one **Download** step (an APK), in the same line.
    The TypeScript tools prompt is one line too: "Install TypeScript tools
    for {folder}?", **Later**, **Install**.
  - Network access on Linux shows each firewall command as a code line with
    **Copy**. "Clear this goal?" is two sentences.
  - **Settings: 15 sections in 3 groups** (it was 18 in 6). **Basics**:
    Appearance, Models, Account, Desktop, About. **Agent**: Agents, Skills,
    Connectors, Plugins, Memory. **Advanced**: Sessions, Workspaces, Blocked
    files, Image and video, Server. Renamed: Providers is **Models**, MCP
    servers is **Connectors**, Denied paths is **Blocked files**, Provider
    limits is **Usage limits**, and OpenAI Codex is **ChatGPT**. Session
    titles, Context, Goals and Retention are one page, **Sessions**. Search
    in Settings and the palette finds every page by its earlier name, links
    into the four merged pages open Sessions at their heading, and messages
    that point to a page use its new name.
  - **Models**: one filter (All / Connected), with hidden ones behind a
    link under the list. A model's form has one button: **Connect**, which
    checks the key and saves it (**Save** once one is stored); **Test** is
    a small action beside Hide. Signing in reads **Sign in to {name}**,
    **Code to enter**, **Copy code**, **Open the sign-in page**.
  - **Connectors**: a new connector first asks **How does it connect?**, **A
    web address** or **A program on this computer**, and shows only that
    half. An address needs nothing else: the name is filled in from it
    (`https://mcp.notion.com/mcp` gives `notion`) until one is typed, and
    **Needs sign-in** is a switch, on. Status, timeout, headers, app
    credentials and the protocol (**Automatic**, which tries the current
    one and then the older SSE one, or **SSE only**) are under **Options**.
    It was a form pre-filled with an `npx` command and a stdio / HTTP / SSE
    (legacy) switch.
  - **Blocked files**: **Block a folder…** picks the folder (the system's
    dialog, or the folder list of the computer the agents run on) and
    writes its pattern. Each rule reads as a sentence above its pattern
    ("Any file named .env", "Everything in taxes"). Four common patterns
    are one press each under **Add a pattern**, which replaces the
    examples popover, and the empty page says **Nothing is blocked**. The
    help no longer suggests `secrets/**`, which never matched: a pattern is
    matched against a file's full path.
  - **Computers**: the desktop's connection page, the phone's first screen
    and the palette say **Computer** where they said Server ("Built-in
    server" is **This computer**; **Switch Computer…**). One list holds this
    computer, the account's computers and the ones added by address; a row
    has **Use** and **Details**, and stopping, watching in the background,
    editing and removing are in Details. Adding one by address has one
    button, **Connect**, which checks the address and key before it saves.
  - Account: the two sign-in choices are sentences, **My other devices can
    open this computer** and **This computer can open my other computers**
    (they were "Use as server" and "Use as client"); a device's details
    read "Can be opened, and opens other computers".
  - The palette's **Theme…** and **Text Size…** are one command,
    **Appearance…**, found by either name. Image and video has one **Size**
    row, whose options follow the chosen image model. Settings → Plugins
    lists **Single-file plugins** once one exists.
  - **A new scheduled task asks three questions**: **What should it do?**,
    **When?** (Every day, Every weekday, Every week on…, Every … minutes,
    hours or days, Once on…, each with a time picker; Custom (cron) keeps
    the expression) and **Where?**, then **Where does the reply go?** (a
    new session each time, the same session, or this session when the open
    one is in that workspace). The form had eight fields, a cron expression
    and a session ID on its first page. **More options** holds Name, Stop
    after N runs, Time zone and Session ID; a task left unnamed is named
    after what it does. A field in error opens the page it is on. Every
    task made before opens in the same form: a cron expression the form
    can say in words shows as words, any other as Custom.
  - **A task's detail reads as sentences.** **Runs in** (workspace, where
    replies go), **Schedule** ("Every weekday at 09:00 · next: Mon 09:00";
    the cron expression shows in Full, or when it has no wording) and
    **Dates**. The list and the sidebar say "weekdays at 09:00" in place of
    `0 9 * * 1-5`. The sidebar's "+" reads **New task**, the dialog
    **Delete this task?**, and the phone's page **Scheduled tasks**.
  - **Shorter menus in the Review panel.** A tab's menu drops Close to the
    left, Split left, Split up, Move left and Move right (dragging a tab
    and the split keys still do all five). A commit's menu is **Open in
    tab**, **Copy commit ID**, **Copy message**, **Revert commit…** and
    **Undo commit…**, on desktop and phone.
  - **Fewer Refresh buttons.** An open text file re-reads itself when the
    file changes on disk. On desktop the Refresh buttons on Changes, a diff
    and a file are one **Refresh** row in the pane's "⋯" menu; a phone
    keeps the buttons.
  - **Create worktree asks for a name.** The branch follows it
    (`openagentd/{name}`) and is shown as a line with **Change** for when
    it should differ. The dialog no longer repeats the list of existing
    worktrees (the worktree chip has it).
  - The notice on a session whose model is not connected reads **Connect a
    model to start chatting** with **Open Models** (it said "model
    provider" and "Open providers").
  - **Preview says what it is doing.** While commenting, a line under the
    bar reads "Click an element to comment" with **Done** (Esc and ⌥C still
    stop it). On a phone the line reads "Tap an element to comment" above
    the bar, and Comment is a button on the bar (it was a row in "⋯", with
    nothing on screen while it was on).
  - **Preview comments**: **Clear** and the × on one comment answer with
    **Undo** for 10 seconds (Clear could not be taken back). A click on a
    comment scrolls the page to its pin and outlines the element. **Add
    comment** shows its keys (⌘↵). On a phone the list is one row, "3
    comments", that opens with Clear inside, and **Send to agent** returns
    to the chat, where the comments are in the message box.
  - **Preview console**: **Errors**, **Warnings** and **All**, each with
    its count. It opens on Errors when there are any (it listed every line
    from the oldest), keeps the newest line in view until the list is
    scrolled up, and has its own ×. On a phone "⋯" shows the error count
    (it was a dot) and its row reads **Hide console** while it is open.
  - **Preview size**: a fixed size (Mobile, Tablet, Desktop) says the
    page's size and scale under it, "390 × 844 · 62%"; in Responsive the
    size shows for a moment while the panel is resized. The size button
    shows an icon and, when the panel has room, the size's name. On a phone
    the button is filled while a fixed size is chosen.
  - **Preview address**: focusing the field lists **Recent** addresses
    (five per workspace, kept on this device) and **Pages in this
    workspace** (its HTML files). Typing filters both; ↑ ↓ and ↵ choose. On
    a phone the list opens upward from the address pill. At rest the field
    leaves out `http://` (`https://` stays). The size's name gives way by
    the panel's width, so a narrow panel on a wide window keeps the address
    readable.
  - **Renamed in this version** (each earlier word still finds its page in
    Settings search and the command palette, and typed commands still run):

    | Before | Now |
    |---|---|
    | Transcript: Detailed / Reader; Toggle Reader Mode | Detail: Full / Simple; Toggle Simple View |
    | Git (tab, launcher, palette, status bar) | Changes |
    | Workspace (the phone's page) | Review panel |
    | Stop & send; on a phone "Steer now", "Send after this turn finishes" | Steer, Queue until done, Stop and send |
    | Compact, Summarize now; `/compact` | Summarize; `/summarize` |
    | Providers | Models |
    | Provider limits | Usage limits |
    | OpenAI Codex | ChatGPT |
    | MCP servers; `/mcp` | Connectors; `/connectors` |
    | Denied paths | Blocked files |
    | Session titles, Context, Goals, Retention (four pages) | Sessions (one page) |
    | Server, Servers, Built-in server | Computer, Computers, This computer |
    | Use as server / Use as client | My other devices can open this computer / This computer can open my other computers |
    | Trust this workspace? Trust and open | Let agents work in {folder}? Allow and open |
    | Theme…, Text Size… (palette) | Appearance… |
    | Copy short SHA, Copy full SHA, Copy commit message | Copy commit ID, Copy message |
    | New scheduled task (sidebar "+") | New task |
    | "Could not", "Unable to", "Failed to" | Couldn't |
    | Try again (a button) | Retry |
    | Offline (a computer that does not answer) | Can't reach |
- **Each platform is offered what it can do, in one wording** `[v3.54.0]`:
  - iPad: a long press in the terminal opens Select All, Copy, Paste, Find
    and Add to chat, as on a phone. Before, only a phone-sized window had it.
  - Linux: the tray no longer offers **Desktop Pet**, which Linux cannot
    show. The app menu has no **Check for Updates…**, and the automatic
    check, which could never find a Linux release, no longer runs. Settings
    → About OpenAgentd says how to update (install the newer `.deb`) and
    opens the releases page.
  - An app older than its server is told where its update comes from:
    TestFlight or the App Store on iPhone and iPad, the newer `.deb` on
    Linux, the app's own updater elsewhere.
  - The installers say what they install and what to do when they cannot:
    `install.sh` lists the CLI for Apple Silicon Macs and x86_64 Linux only
    (it never installed on Intel Macs or arm64 Linux), sends a machine with
    no release to the build instructions, sends Linux without `apt-get` to
    `--cli`, and writes its PATH hint for the shell in use (`~/.zshrc` on a
    Mac, not `~/.profile`). `install.ps1` says the app runs under emulation
    on Windows on ARM, refuses 32-bit Windows, and says what happened when
    the permission prompt is declined or the install is cancelled.
  - One name each: **Toggle Sidebar** in the View menu, the palette, the
    header and the shortcuts list (the menu said "Sidebar"); **Undo to
    here** on a prompt (it said "Revert to here"); "main agent" in `agentd
    doctor` and in the server's messages (they said "lead agent").
  - No pointer verb where there is no pointer: the theme button reads
    "Theme: Dark. Switch to System." and the update and TypeScript tools
    pills "Show … details", in place of "Click to …".
  - A provider that is not signed in says so and names the screen that
    fixes it ("Sign in under Settings → Models"), with the `agentd auth`
    command after it. A server that does not answer names the setting to
    turn on (**Access from other devices**), not a server flag.
  - A crash screen's **Copy error details** reads **Could not copy** when
    the clipboard refuses. Before, it did nothing.
- **One look across the app** `[v3.48.0, updated v3.63.0]`:
  - The same status looks the same everywhere. Needs you is orange and
    Failed is red. Connected and passing checks are green. Running and Done
    are quiet muted text.
  - Dates follow one rule: `5m · 3h · 3d · Oct 29` in lists, and
    `Today 14:32 · Oct 29, 14:32` in details and tooltips. The year appears
    only when it isn't the current year.
  - Each kind of control has one form: one close ×, one button style, empty
    states with an action, skeletons while loading, and "Couldn't load X."
    with Retry when loading fails.
  - A list that failed to load no longer reads as an empty one. With
    sessions grouped by status or date, or not grouped, the sidebar said
    "No sessions yet", and its Scheduled section was simply absent. Both
    now say "Couldn't load sessions." or "Couldn't load scheduled tasks."
    with Retry `[v3.63.0]`.
