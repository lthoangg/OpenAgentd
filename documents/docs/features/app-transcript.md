---
title: "Features: The app: chat and transcript"
description: "Reading a session: the transcript, replies as they stream, Markdown, tool rows, Plan and Code modes, and questions from the agent."
---

# The app: chat and transcript

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Chat workspace** `[v2.19.0]` — the prebuilt **Chat** row in the coding
  sidebar runs the same agent on the same screen with its root in your home
  directory, so the agent reads, runs, and edits your own files with relative
  paths. Chat is not a project: workspace instruction files, project skills,
  project slash commands, and project snippets load only for real workspaces,
  while global instructions, skills, commands, and snippets still apply.
  Chat is not a repository either, so the pinned row offers no worktree or
  removal actions and the workspace dock has no Git tab; file-level undo is
  off, and `/undo` moves the conversation boundary only. Set
  `OPENAGENTD_CHAT_WORKSPACE_DIR` to run Chat elsewhere and keep your home directory
  usable as a coding workspace.
- **Quieter transcript** `[v3.37.0]` — reasoning stays open in full (no
  "Thought for" fold), tool rows drop the coloured running dot ("running…"
  and the timer remain), and long tool results no longer end in a Collapse
  bar; the pinned tool row closes them.
  Shell rows show only test counts or "no output" — no exit-code or error
  chip.
- **Mono reasoning** `[v3.38.0, v3.39.0]` — the thinking trace reads inline
  in the transcript as small mono text with bold section headers, always
  open, with no quote bar. (v3.38.0 showed it in muted italics.)
- **Plan and Code interaction modes** `[v2.14.0, updated v2.15.0, v3.0.0, v3.2.0, v3.8.0, v3.22.0]` — the expanded composer switches an
  existing session between Code (default) and Plan without starting a new
  chat; `Tab` also toggles mode from the composer. Mode transitions are preserved via
  append-only hidden context notes in session history. In Plan mode, the agent explores
  the repository and writes a plan for you to review, while the runtime
  blocks changes to project files and permits read-only inspection and testing via shell.
  The agent writes its plan with the `plan` tool and submits it with the same
  tool (`submit: true`, in either Plan or Code mode; one call can save and
  submit, and a save that fails submits nothing — it was a separate
  `submit_plan` tool before `[v3.32.0]`), which pauses the turn for review in the **Plan** tab of the
  review dock (full screen on mobile; it opens by itself on desktop). The tab
  shows the rendered plan and its status, and offers **Approve** and
  **Reply in chat**. Select plan text and choose **Comment** to attach a
  comment to that passage: commented passages stay highlighted, and the review
  footer lists your comments (click one to jump to its passage, or remove it);
  unsent comments survive switching tabs. Approving carries on implementing
  the plan (switching the session to Code mode if in Plan mode). Changes go
  through the chat `[v3.59.0]`: **Reply in chat (N)** moves your comments into
  the chat box as one **Plan comments** chip (its × puts them back in the
  plan), you add anything else there, and you send a normal message. The
  message shows in the chat with a **Plan comments** card listing each quoted
  passage and your comment, and it closes the review as superseded; the agent
  revises the plan and submits it again. Approve waits until no comment is
  left unsent. Before v3.59.0 the tab had its own feedback box and
  **Request changes** answered the review out of sight. The transcript shows
  a plan review card with the outcome and a button that opens the plan;
  **Open Plan** in the command palette (⌘K) does the same whenever the
  session has a plan.
  Older `<proposed_plan>` answers still render as read-only cards.
  A saved `plan` call in the transcript has **View plan**, which opens the
  Plan tab `[v3.22.0]`. The tab shows the plan once it is saved; v3.21.0
  streamed it in as it was written, which `[v3.22.0]` removes.
  Switching mode while a turn is running no longer stops it: the switch is
  queued and applied when that turn closes, so it binds from the next turn and
  any message queued behind it. The toggle shows the queued mode in italics
  until it lands. Use stop if you actually want to interrupt the turn.
  - **Saved session plan** `[v3.0.0, updated v3.2.0]` — in a project
    workspace the plan is a Markdown file in `.agents/plans/` (`.openagentd/plans/` before v3.14.0), which
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
    Since `[v3.32.0]` the plan reads **Done** once its goal is achieved or,
    without a goal, once every task is finished, and approving a plan asks
    the agent for one task per milestone, named after it.
    Since `[v3.49.0]` the review footer (comments and its actions) lines up
    with the plan's text column instead of
    stretching across a wide or maximized Review panel.
  - **Keep going until done** `[v3.32.0]` — the plan review footer has a
    **Keep going until done** checkbox and, beside it, the turns for this
    plan (prefilled from Settings). Approving with it ticked starts a goal
    whose objective is the plan's **Done when**, and the agent keeps working
    turn after turn without a "continue" from you. The checkbox is disabled
    while the plan has no Done when. Each goal turn names the plan file and
    the next unfinished task. Since `[v3.49.0]`, approving a new plan this way after an earlier
    goal ended starts the new goal straight away: the earlier goal's end
    note says a newer goal replaced it, not "do not continue". It stops
    when a separate completion check
    confirms the agent's `update_goal` claim from evidence shown in the
    conversation, when the agent reports a blocker, or at a limit: 50 turns by
    default, two turns in a row without tool calls, or three rejected claims in
    a row. Since `[v3.58.0]` a goal has no token budget: spending tokens never
    pauses it, and the Settings field for one is gone. A rejected
    claim's reason goes back to the agent. The check also reads the task board,
    where unfinished tasks need a stated reason, and the runtime's own log of
    the commands the goal ran, with their exit codes, and the files it changed,
    so a claim cannot cite a run that failed, never happened, or came before
    later edits. Claiming again with nothing run since a rejection is turned
    down without another check. A check that fails to give a verdict neither
    accepts nor rejects the claim, so the agent can claim again; three such
    failures in a row pause the goal. If you pause the goal while a check
    runs, the pause stands even when the check finds it met, and the Goal
    tab shows the verdict under why it paused `[v3.59.0]`. Goal turns run unattended by default: the
    agent decides instead of asking and notes each choice, and a plan it
    submits is saved without opening a review. **Settings → Sessions** sets
    whether Keep going starts ticked and the turn limit, and allows questions
    during a goal. The check runs on the session's own
    model, so it reuses the conversation's prompt cache. It is told which
    messages are the runtime's own notes (goal reminders, mode and plan
    notes), so it never takes them for your requirements or for proof the
    work is done `[v3.31.1]`. A **Goal** tab in the
    review dock (the drawer on phones) shows what the session is doing now
    (running a turn and the next task, waiting for your answer, for plan
    approval, for Code mode, for subagents, or for your queued messages), the
    objective, the plan with its status, turns, tokens and
    time, the last check, and Pause, Resume, and Clear. Its title follows the
    goal ("Goal 7/50", "Goal paused"). The dock's **+** menu opens it, and
    **Cmd+K → Goal** does too, listed only while the session has a goal. Since
    `[v3.33.0]` Clear asks for confirmation first, Cmd+K no longer pauses,
    resumes or clears (the Goal tab does), and **Stop & send** leaves the goal
    active, so your message is its next turn. Also since `[v3.33.0]`, plan,
    tasks and goal read as one chain: while a goal runs, the header's **Task
    list** button carries a ring in the goal's colour (blue working, hollow
    paused, orange waiting on you, red blocked) with the state and next task
    in its tooltip; the Tasks tab and task popover lead with one status line
    for the plan and its goal ("Approved · Running", "All tasks done ·
    checking"), and end the checklist with the plan's **Done when** (its
    flag on its own line above the criteria) and whether the completion
    check has confirmed it. Since `[v3.47.0]` tapping the plan or goal row
    opens the Plan or Goal tab, where Clear plan, Pause and Resume are; only
    without a dock do the rows keep Clear plan and Pause or Resume beside
    them. An
    approved plan that has a Done when and no goal can be started as a goal
    later with **Run as goal** in the Plan tab. The Stop button pauses the
    goal, Plan mode and running subagents make it wait, and since
    `[v3.34.0]` a goal keeps running across a server or app restart: its
    cut-off turn continues, and it pauses (reason "restart") only when that
    turn cannot be continued. Approving another plan with
    Keep going replaces the goal. A scheduled task that runs in the goal's
    session skips each run that comes due while the goal works (the scheduler
    skips busy sessions) and fires again at its next scheduled time. Undoing a
    goal turn keeps the goal; undoing back past the approval ends it. The
    transcript marks each goal turn and each claim's verdict; each turn's
    divider says why the goal went on (no claim yet, the check said not yet,
    the check gave no verdict, or you resumed it), with the check's full reason
    on hover or tap. An achieved goal shows in blue (green since v3.40.0). The sidebar marks sessions
    with a live goal, one notification ("Goal achieved", "Goal blocked", or
    "Goal paused") arrives when the goal ends, and on macOS the notch shows a
    running goal's progress ("Goal 7/50") and the same outcome. In the Reader
    transcript the goal's outcome (achieved, blocked, or paused by rejections
    or failed checks) stays visible, and claims the agent worked past fold
    into the turn's row as "goal checks". One goal per top-level session.
  - **A new plan for new work** `[v3.32.0]` — when you move on to work the
    current plan does not cover (for example after it was implemented), the
    agent starts a fresh plan instead of overwriting the old one. The old
    plan keeps its file unchanged (in a chat session it is kept as
    `plan-closed-<n>.md` beside the session); the new one gets its own file,
    starts at revision 1 and is not approved. Finished tasks leave the task
    list, unfinished ones stay. A full rewrite of an approved plan is refused
    once, so the agent chooses between revising it and starting a new one.
    The transcript card reads **Started a new plan**.
  - **Plans written for the reviewer** `[v3.21.0]` — a plan opens with
    what you get (**Outcome**) and the choices to confirm (**Decisions**,
    each with a recommendation), shows the change (**Preview**), and lists
    a few milestones with checkpoints, then **Scope**, **Risks** and
    **Done when**. Implementation detail goes in an **Appendix** at the end,
    which the Plan tab shows collapsed: click it to open (remembered per
    session); you can select and comment on its text like the rest of the
    plan, and clicking such a comment opens it. Sessions already in Plan
    mode get the new instructions on their next turn.
  - **Mockups and diagrams in plans** `[v3.21.0]` — while planning, the
    agent can write attachments next to the plan, in
    `.agents/plans/<plan-name>/` (the only place `patch` writes in Plan
    mode), and check them with a look-only `preview` (open, logs, snapshot,
    inspect, scroll, navigate, wait; no click, fill or press). In the Plan
    tab, a link to an HTML mockup opens it in a Preview tab (a file tab when
    previews are unavailable), other workspace links open as file tabs, SVG
    images render inline, and `mermaid` fences render as diagrams.
- **Transcript: act where you read** `[v3.40.0]`:
  - Under the last finished answer, **Copy · Edit prompt** show at
    rest as icons, each named in its tooltip, then the files
    changed (a file icon, the count and `+added -removed`). While a turn
    runs, Edit prompt shows dimmed and says it is available when the turn
    ends. A prompt's own Edit and Copy icons are the same size.
  - The files changed toggle lists the files the turn edited, with their line
    counts, in both transcript styles (Reader and Detailed); a file opens its
    diff.
  - A turn that waits (every account at its limit, a reconnect) or stops
    shows one card: what happened, since when, what you can do, and **Copy
    details**.
  - When only the session model's provider is missing, the notice above the
    chat names it ("Connect xAI Grok to keep chatting", with the model) and
    offers **Choose model** beside **Open Providers**, instead of asking for
    "a model provider" as if none were set up.
  - Each answer's footer names the account it ran on.
  - A thinking trace always shows in full.
    Runs of blank lines in a trace (Gemini sends three between paragraphs)
    show as one paragraph break.
  - Scrolling up shows a **Loading earlier messages…** row while older
    turns load, and one **Jump to latest** chip counts what arrived since
    (`3 new`). Since `[v3.49.0]` it is a pill at the top of the view that
    never moves the messages. On a phone, earlier messages start loading two
    screens before the top and come in a few turns at a time while you keep
    scrolling, so a fling is never stopped and the chat does not jump. Long
    and running sessions no longer jump while you read them as new turns
    arrive. Closing the sidebar while the Review panel is open no longer
    leaves the chat scrolled up a little with the chip showing.
  - A subagent row is a button that opens the subagent's session, with its
    state in words (Running, Done, Failed, Needs you, Stopped) and a running
    clock. It sits under the team call that started or messaged the
    subagent, so following it is one click. Since `[v3.49.0]` the call's own
    row carries it instead: a small state chip with ↗ after the target opens
    the session, with no extra row. A subagent's question lists its
    options, says the main agent answers it, and offers **Open subagent
    session**.
  - Copy buttons on code blocks, tool arguments, commands and output are
    always visible and say "Copied"; a bare code fence gets the same header.
    Tool section headers are real buttons.
  - **Run in terminal** `[v3.55.0]`: a `bash`, `sh`, `shell`, `zsh` or `fish`
    code block has a second header button, beside Copy, that runs the block
    in the workspace's terminal and shows that tab. It uses the last terminal
    sitting at its prompt, or a new one when there is none or each is busy,
    so a command never reaches a running program. The button is absent
    without a workspace and while the block is still being written.
  - **The agent writes for the app** `[v3.55.0]`: every main agent, custom
    ones included, is told what the app does with a reply, so it uses it
    instead of working around it. A command only you can run (a login, a
    password prompt) comes alone in a shell block with **Run in terminal**
    rather than "copy and paste this"; a document comes as a link that opens
    in the viewer; local pages, images, diagrams and math are written the way
    the app shows them. Subagents, which write for the main agent, are not
    told.
  - On touch, a long press on a message, a code block or a link opens its
    menu as the app's bottom sheet, the iOS app included. A tool row has
    a menu too (right-click or long-press) that opens its files; Copy is on
    each section of the open row.
  - The plan tool's chip reads **Open plan**, like every other way to the
    plan.
  - A question card pages through several questions with Back / Next, with
    **Send** on the last one. Keys 1–9 pick an option (the next number is
    "Type your own answer") and Enter sends. Double-clicking an answer
    picks it and sends (or goes to the next question).
  - A turn that ends while its question is still open keeps reading as
    waiting for your answer (Stop stays, the sidebar row keeps its
    needs-input mark), the same as after a reload; it used to read as
    finished until the page was reloaded. `[v3.59.0]`
  - An open tool row's arguments and output show in full, no longer cut at
    its edges.
  - A plan review is decided in the Plan tab: **Approve** (or **Approve and
    keep going (N turns)** when a goal would start, with the real count) and
    **Reply in chat** (**Request changes** before v3.59.0); select text there
    to comment on it. Its card in the chat shows the outcome and **Open plan**.
  - Each queued message has **Remove**, and the notice that follows has
    **Undo**.
  - The undo notice is one card: "Last 2 messages undone. Redo brings them
    back; sending a new message discards them.", then **Redo**, **Redo all**
    and **Show messages**.
  - Deleting all side questions asks first, in a dialog.
  - A subagent's session offers **Return to main agent**.
  - Every heading level in an answer reads as a heading: `####` and below
    were plain text, and `###` was fainter than the text under it. A task
    list shows its checkboxes in place of bullets, in the theme's colour.
- **Needs you everywhere, answered in place** `[v3.40.0]`:
  - The notch status, the pet, the tray and system notifications share one
    feed and one set of words: **Needs you**, **Running**, **Done**,
    **Failed** and **Can't reach**. "Builtin" is now "Built-in server".
  - A question with a few choices can be answered from a system
    notification's buttons; anything else offers **Open to answer**.
    Answering anywhere clears it everywhere. The notch and the pet show the
    notification, and a click on it opens the session.
  - The notch status opens on click; pointing at it opens it only with
    **Expand on hover** on. Its × means Later. When a server stops
    answering, a **Can't reach** row offers Retry *(since v3.43.0 a click on
    the row retries)*.
  - The pet keeps a question until it is answered: × folds it behind the
    badge, and its menu lists questions first.
    Since `[v3.51.0]` a question answered anywhere leaves the pet even while
    another still waits, a moment's lost connection no longer clears its
    questions, and a question asked while the pet was hidden (or before it
    started) shows when it comes back. The notch reports a turn that failed
    within moments of starting, and one that finished while its server
    could not be reached once it is back; a finish put off with Later comes
    back when the session finishes again.
    Since `[v3.55.0]` the pet's right-click menu opens every question its
    bubble opens: a question asked while the pet was hidden used to be
    greyed out there.
  - Notch and pet flows that went nowhere or worked too hard `[v3.55.0]`:
    a notch row for a server that refused its access key opens **Settings →
    Server**, where the key is fixed (a click used to try the same key
    again, and nothing changed on screen). A notch that is showing moves
    within 2 s when a display is plugged in, unplugged or rearranged; it
    used to stay put until the next status change. The notch reads each
    waiting session's question from the server once, not on every event of
    any session, and when the session asks again it drops the answered
    question's id until the new one is read. The pet asks the Dock one thing instead of three every
    15 s when the Dock stays up, and a walking pet no longer makes the app
    read the pointer ten times a second while the pointer is elsewhere.
  - Dead parts removed `[v3.55.0]`: the notch row no longer receives the
    pinned account it never drew, the tray popup no longer receives three
    usage fields it never read, the phone widgets no longer store a task's
    last run time (none showed it), and the app no longer ships an unused
    notification sound. On macOS the app no longer tells the tray which
    session is open (the Mac tray has no row for it) or writes menu rows
    for a usage submenu that does not exist there.
  - Smaller notch and pet fixes `[v3.55.0]`: **Settings → Desktop** follows
    a notch setting changed in another window, as it already did for the
    pet, and a pet option that is greyed out says what to turn on to change
    it. A server whose account status could not be read on a reconnect
    keeps the computer it was known as, so one computer saved under two
    addresses is not listed twice after a timeout. The notch's window
    leaves as soon as the pill has shrunk away (240 ms; it stayed up,
    empty, for 400), and a notch that could not read its state on start
    asks again (up to five times, a second apart) instead of staying empty
    until the next status change.
  - A question card in the transcript no longer sticks on "Waiting for an
    answer…": once the turn is over and no question is open, it says **No
    answer recorded** with what was asked, and a card closed from another
    window (or by a stop this window missed) reads "Already resolved from
    another window or device" after the next load.
  - The tray popup says **No server connected** when there is none, and its
    usage section is **Provider limits**.
  - Opening a session from anywhere (notch, pet, tray, a notification, Open
    in new window) focuses the window that already shows it. When one
    session is open in two windows anyway, the window in the background
    shows the draft as it is typed in the other.
    Since `[v3.50.0]` a session opened from the notch or the pet comes
    forward without putting focus in its composer; a system notification
    still starts there.
- **Back to the lead agent in one click** `[v3.42.0]`:
  - A subagent's session has an **Open the lead agent** button (↰) in its
    header, before the title, on desktop and phones, next to the existing
    **Return to main agent** banner.
  - The lead's messages in a subagent's transcript (its task and follow-ups)
    carry a **From lead** chip that opens the lead's session, and read
    without the `[Lead]:` / `[Task from Lead]:` prefix. They have no
    **Edit**, and the turn under them offers no **Edit prompt** or retry,
    since those would rewind or resend inside the subagent.
  - A message from another workspace's agent that is still queued shows a
    clickable **From <workspace>** chip that opens the sending session, as
    the delivered prompt's chip does.
- **Shell rows say what they do; phone header padding** `[v3.46.0]`:
  - A shell row shows the agent's description of the command (`shell  Run
    the unit tests`); the expanded row shows the command and its output. A
    call without a description shows its command as before.
  - On a phone the Review panel button sits as far from the right edge as
    the sidebar button does from the left.
- **`shell` tool output handling** — Stop terminates active foreground
  shell process groups; background commands started with `background=true` return
  the spawned PID. Raw ANSI/CSI/OSC escape
  sequences (colors, cursor movement, hyperlinks) from color-forcing CLIs are
  stripped from foreground results and live streamed output before reaching
  the LLM or the UI `[v1.120.0]`. Foreground output memory is bounded, with
  oversized output streamed incrementally to a session spill file `[v1.120.1]`.
  Foreground commands default to a 120-second timeout instead of 60 `[v1.131.3]`.
  Foreground commands are capped at 270 seconds (4m30s) so a waiting turn
  never outlives the ~5-minute provider prompt cache; longer work runs with
  `background=true` `[v3.11.2]`.
- **Clickable URLs in user message bubbles** `[v1.77.0]` — plain-text URLs typed
  or pasted into a user message are rendered as tappable links; style matches
  agent response links.
- **Long prompts fold to six lines** `[v3.21.0]` — a sent prompt longer than
  eight lines on screen folds to its first six, with an expand button. Lines
  are counted as they wrap, so the fold follows the chat width: opening the
  sidebar or the dock re-checks it. Expanding and folding animate, and the
  whole prompt stays selectable and searchable.
- **Mermaid diagrams in agent responses and plans** `[v1.121.0, v1.123.0, v3.5.0, v3.21.0, v3.22.0]` —
  a `mermaid` code fence renders as a diagram as soon as its closing fence
  arrives, with **Diagram** and **Code** views and copy. Since v3.21.0 it is
  drawn by [Pele](https://pele.run), a small, dependency-free Mermaid renderer
  that loads on the first diagram (startup size is unchanged). Diagrams use the
  app's colors in light and dark themes, adapt their layout to narrow screens,
  and can be zoomed when they have to shrink. Diagram links and images are
  off, and the drawn SVG is sanitized before it is shown. Since v3.22.0 labels
  match the reply text size, and a **Full screen** button redraws the diagram
  for the whole window with zoom always on (Esc closes it). A diagram that
  can't be drawn shows its code with a one-line reason. (v3.5.0–v3.20.0
  showed `mermaid` fences as plain code.) For richer drawings, an agent can
  still write an HTML/SVG file and open it in the Preview tab.
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
- **Scroll position per session** `[v3.5.0]` — leave a session scrolled up and
  come back to it, and the transcript opens where you were reading; a session
  you left at the bottom keeps following new output. Kept while the app runs.
  Since `[v3.33.0]` a turn that finishes while you are scrolled up leaves the
  view where it is: the finished turn is no longer rebuilt (step lists you
  opened stay open), and only your own scroll to the bottom resumes following.
- **Calm session switches** `[v3.28.0]` — opening another session no longer
  flashes a blank or loading screen:
  - The chat you are leaving stays on screen, slightly dimmed, until the next
    one is ready, then fades in already scrolled to its newest turn. A slow
    load shows the transcript placeholder after a beat.
  - A session you viewed recently shows its last transcript at once, and the
    real history replaces it silently when it arrives.
  - Resting the pointer on a sidebar row fetches that session (and its
    workspace's agents) ahead of the click.
  - A session in another workspace keeps the chat and the composer in place
    instead of swapping to an "Opening workspace…" screen.
  - With Reduce Motion on, the switch snaps without the fade.
- **A steady transcript while you read** `[v3.25.0]` — scroll up while the
  agent works and the text you are reading holds still:
  - Images, math, diagrams and highlighted code that finish loading above the
    view no longer push it down; the browser anchors to the block you are on.
  - Images in replies and attachments hold their space before they load, at
    their exact size once seen.
  - Code in a long answer is highlighted as each part finishes, not all at
    once when the answer ends.
  - A tool whose live output you were watching stays open when it finishes,
    until the next step starts. *(Replaced in v3.47.0: tool rows open only
    when clicked.)*
- **A live caret while an answer streams** `[v3.25.0]` — a thin blue bar
  blinks after the last line an agent is writing, so a pause reads as
  thinking rather than finished. It goes when the answer ends, skips code
  blocks and tables, and stands still with Reduce Motion on.
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
- **A calmer transcript** `[v3.0.0]` — the chat reads as prompts and answers:
  - Every prompt you wrote has Edit (rewind to it and put it back in the
    composer; `/redo` brings the undone turns back), reachable from the
    keyboard.
  - A failed turn ends in an error card with Retry and Switch model, which
    opens the run picker (Session Settings before v3.40.0).
  - `⌥⌘↑`/`⌥⌘↓` (`Alt+↑`/`Alt+↓` on Windows and Linux) jump between your
    prompts; `⌥⌘↑` reaches earlier prompts in one press, loading them when
    they are not loaded yet. On mobile, Previous prompt and Next prompt in the
    chat actions menu do the same. Before `[v3.62.0]` the Windows and Linux
    keys were `Ctrl+Alt+↑`/`Ctrl+Alt+↓`, the same keys that send the focused
    Review panel tab up or down, so one press could do either.
  - Opening a session loads everything from your latest prompt to the end,
    up to 500 messages, so a long run shows the prompt it answers in both
    transcript styles, with no scrolling or extra requests. A longer run
    loads its newest 500 messages with the prompt pinned above them and a
    dashed line where the rest sits; scrolling up fills it in, as older
    history loads. The "Show earlier messages" button is gone: scrolling to
    the top reveals those turns `[v3.29.0]`.
  - `path:line` and `path:start-end` references (also `#L42-L58`) in replies
    and tool output open the file in the review dock with those lines
    selected. A bare name or partial path (`Button.tsx`,
    `src/app.ts` for `web/src/app.ts`) finds its file, preferring one the
    session read or patched; when several files match, Quick Open opens
    searching for the reference.
    A code span that names a whole Markdown or HTML document (`DESIGN.md`,
    `.agents/plans/x/mockup.html`) renders as a plain link rather than code,
    and paths through dot folders such as `.agents/` are recognized
    `[v3.35.0]`.
  - Clicking an `@path#L42-L58` mention or a design feedback source opens the
    file with that range selected too, not just the file `[v3.6.0]`.
  - On desktop a timeline scrubber replaces the transcript's scrollbar and
    marks prompts and a question waiting for you.
  - Reply footers add the turn's output tokens, or its cost when the model
    has a price.
    A `/compact` or idle compaction after a reply keeps the reply's footer
    under it, with the divider below, and the footer stays while it compacts;
    a compaction during a run stays inside it, under its one footer
    `[v3.28.0]`.
  - Inline diffs in tool cards show the first 400 lines with a "Show N more
    lines" button, so huge patches stay responsive `[v3.14.0]`. A turn shows
    every one of its steps, however long the agent ran; the "Show N earlier
    steps" button is gone `[v3.26.0]`.
- **Reader transcript** `[v3.0.0]` — an opt-in transcript style (Settings →
  General → Appearance → Transcript, or Toggle Reader Mode in the command
  palette, which also finds it as "compact" or "transcript"). Since
  `[v3.56.0]` it is the **Simple** level of the Detail setting, where a new
  install starts (Settings → Appearance → Detail, or Toggle Simple View).
  Each turn reads as its answer:
  - The thinking, every tool call, and the narration between them fold into
    one row such as "6 reads, 3 searches, 4 commands, 2 edits"; while the
    turn runs it names the current step ("Working ·
    Shell: Run web tests"). Opening it shows the steps as in the detailed
    transcript.
    Since `[v3.1.0]` the running row also says how long the turn has run,
    counted from its prompt ("Working · 1m 12s · Shell: Run web tests"),
    and a turn waiting on your answer shows its counts instead of "Working".
    Since `[v3.30.0]` the row no longer counts failures (a failed step still
    shows red once the row is open), and every built-in tool counts under a
    named group instead of "other": skills count as reads, MCP tool searches
    as searches, and there are plan updates (`plan`, `submit_plan`, `todo`,
    `schedule`), questions, delegations (`team`, `workspace`), preview
    actions, MCP calls, and generations. "Other" is left for plugin and MCP
    server tools, and tools saved under a former name count with their
    current one.
    Since `[v3.58.0]` a `script` call counts as a script ("1 script"), not
    as "other".
  - An open row stays pinned to the top of the transcript while its steps
    scroll under it, and a **Collapse** row ends the steps, so a long fold
    closes without scrolling back up. Closing from either leaves the row
    where you pressed it.
    Since `[v3.30.0]` the rest of the transcript works the same way: an
    opened tool call pins its header (inside an open row, just below it), an
    opened compaction summary pins its divider and ends in a **Collapse**
    row, an expanded long prompt keeps its collapse button in view, an
    expanded subagent report pins its header with a minimize button, and the
    open "N files changed" list pins its header. Each closes where you
    pressed it. This applies in the detailed transcript too.
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
- **Tool rows open files; a compact run deck** `[v3.48.0]`:
  - Tool rows have no hover tooltip, so hovering a shell row no longer
    shows its command. When a row's title is cut short (a long URL, query
    or pattern), the whole value is the first line of the open row.
  - Right-click or long-press on a **patch** row lists an **Open** item
    (`Open web/src/app.tsx`) for each file the patch left in place, named
    relative to the workspace. A deleted file isn't listed, and a renamed
    one opens under its new name.
    On a **read** row it opens the file at the line the read started from.
    Files open in the Review panel. Other tool rows keep the system menu,
    and nothing is fetched to build the menu.
  - The run deck's controls (**+**, Code / Plan, the model chip, the
    context ring and Send) are one height: 28px on desktop and 36px on touch
    screens, phones included, where their touch area is 44px. All are
    rounded 6px except Send, which stays a circle.
  - Code / Plan is one button that names the mode in force; a tap switches
    to the other, as Tab in the message field does. Plan is filled, so it
    shows at a glance. It takes half the room the two segments did, which
    goes to the model chip.
- **Jump to latest shows only when you have left the end** `[v3.48.0]`:
  - Opening and closing a tool row or a reader fold at the end of the chat
    no longer shows **Jump to latest**, and the chat keeps following new
    output.
  - When closing a fold leaves you at the end, the chip goes away. Scrolling
    down there (or End, Page Down, ↓) follows new output again.
  - Scrolling up while Jump to latest glides down stops the glide where you
    are, instead of pulling you back to the end.
  - Recalling an earlier prompt with ↑ always offers the chip back.
  - From more than two screens up, and with reduced motion, Jump to latest
    jumps instead of gliding. On touch screens the chip is 36px tall, with
    13px text on a phone.
