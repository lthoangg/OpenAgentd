---
title: "Features: The app: composer"
description: "Writing a message: the composer, the run controls under it, attachments, mentions, slash commands and drafts."
---

# The app: composer

Part of the [feature catalogue](../features.md), under *1. The desktop coding workspace*. The index explains the version tags.

- **Run deck under the composer** `[v3.40.0]`:
  - The composer sits at the foot of the chat on every screen, in line with
    the transcript, up to the reading width, and is always open. It can no
    longer be dragged or minimized.
  - Under the text a run deck says how the next message runs: **+**,
    Code / Plan, the run chip (`provider:model · Thinking · Account`), the
    context ring and Send. There is no separate MCP button: while a server
    needs you (sign in, or it failed) **+** carries a small dot, says which
    server to screen readers, and opens at its MCP section. On a narrow
    composer the chip stacks into two lines and the provider part gives way
    first; then a long model name gives up its middle
    (`antigravit…sonnet-4-6`, or `sonnet-4-6` alone on a phone), the same in
    the picker and the turn footer, so the part that tells models apart
    stays. In Plan mode the placeholder says the agent reads and proposes
    without editing files.
  - The run chip opens one picker for model, thinking and account. Since
    `[v3.58.0]` it has two pages: search and pick a model, and the picker
    moves to that model's page, with its thinking levels as rows and its
    provider's accounts (state and quota left) under them. Enter or → opens
    the page, ↑/↓ and Enter pick a level and close, ← or Backspace go back
    with the search as it was; a phone does the same with taps. `/think`
    opens on the running model's page, and a model with no levels and one
    account is picked at once. **Reset to default** and **Make default** are
    gone: picking the agent's own model and level saves no override, and an
    agent's default is set in Settings → Agents.
    Every pick is saved on the session at once and survives a reload; if the
    save fails, a toast says so and offers **Retry**. Open it
    with `⌘.`/`Ctrl+.` (it was `⌘⇧A`/`Ctrl+Shift+A`), `/model`, `/think`, or
    **Model and Thinking…** in the palette or the View menu. On phones it is a
    bottom sheet.
  - The picker opens on the model that runs (highlighted and scrolled into
    view, so Enter keeps it), lists each model whole as `provider:model`,
    and when neither the session nor the agent sets a thinking level it says
    the model's own default applies. The cursor is in its search as it
    opens, from a click or the shortcut, so typing filters at once (with
    Reduce Motion on, it was left nowhere).
    As in the palette, a pointer resting on the list does not take the
    highlight from the keyboard when the list opens, filters or scrolls under
    it; only moving the mouse does.
  - The model search matches loosely, as the palette and Settings do
    (`sonnet46` finds `claude-sonnet-4-6`), and ranks the closest model
    first in one list, so Enter picks it. While a search narrows the list,
    the picker keeps its size and stays on the chip: the search field no
    longer moves under the typing, and a short result no longer leaves the
    picker hanging above the composer. Any popover opening upward now stays
    on its button when its content changes size.
  - **+** holds Attach, Mention a file, Snippet, Side question and the MCP
    servers (state in words, Sign in, on/off); `/mcp` opens it there.
  - A model reads `provider:model` in mono wherever it appears: the run
    chip, each answer's and prompt's details, the waiting and retry notes,
    Usage, the first-run card and Settings → Agents. When space runs out the
    `provider:` part gives way first; the full ID is in the tooltip.
  - The context ring opens the token numbers and **Summarize now**. The
    header and status bar no longer show the context meter or the model.
    Since `[v3.50.0]` it also shows the session's **Cost** so far, its
    subagents' included (hidden while nothing was priced).
    Its full track is drawn, so a part-filled ring reads as a gauge, not a
    spinner. Its labels are in the UI font and only the numbers in mono, as
    in an answer's details.
  - The composer marks focus with a darker border rather than a blue glow.
  - On phones the header keeps four controls (sidebar, title, Review panel,
    More), and Send is a 44px target (36px since v3.41.0, like the
    controls beside it).
  - Messages queued while a turn runs sit in the tray above the text, with
    the side question and the **Jump to latest** chip *(queued messages
    moved back to the transcript in v3.42.0; the tray keeps the other two)*.
  - On a touch tablet, in the app or a browser, the composer rides up on the
    soft keyboard as it does on phones, and Settings ends above the keyboard
    so its Save bar stays reachable. The header is 44px there, so its touch
    buttons sit inside it, and workspace rows use the phone's short marks
    (**missing**, the worktree count) so the always-shown row actions leave
    the name room.
  - In the iOS app the keyboard has no `< > ✓` bar above it `[v3.51.2]`,
    so the composer sits whole on the keyboard (on iOS 26 the bar covered
    it). Swipe down on the composer or tap the chat to put the keyboard away.
- **Pin a session to one account** `[v3.40.0]` — when a provider has several
  keys or OAuth profiles, the run picker can pin the session to one of them;
  **Auto** keeps today's rotation. A pinned session only ever uses that
  account, and so do its subagents on the same provider, its title (also a
  separate title model on the same provider) and its summaries. If the
  account is cooling down, the turn waits and says so, with **Use Auto for
  this session**, **Choose account…** and **Stop**. If the provider rejects
  it (signed out, out of credit), the turn stops with the same choices and
  **Reconnect…**, and the run picker offers **Reconnect** beside that
  account. If the account is deleted or disabled, the session goes back to
  Auto with a note. Each answer's footer names the account it ran on, and
  Settings → Models shows how many sessions pin each account. The desktop
  tray names the account a pinned session runs on (**Pinned to Work**), and
  its Provider limits name the account in use when a provider has several
  (**OpenAI Codex · Work**).
  Since `[v3.48.0]` a locked account is where the session starts, not the
  only account it uses. When it hits a limit (or is rejected), the turn moves
  on to the next account with room, as every session does, says so in the
  transcript ("Work hit its usage limit. Continuing on Home with the same
  model."), and goes back to the locked account once it resets. A turn waits
  only when every account is limited, for the first one to reset. The
  **Auto** row is gone: with no lock, the picker checks the account the
  provider uses now. The run chip
  always names the account in use, and the picker tags the account a locked
  session moved to with **in use**. Each account row shows every limit of the
  account in % used, as Settings → Models does (`5h 12% · 7d 64% · $84.50
  left`). A limit that was hit is red and one at 90% or more is orange, and
  the tooltip gives reset times and other models' own limits. The wait and
  error cards no longer offer **Use Auto for this session**.
  Since `[v3.57.0]` an account picked while a turn runs serves its next model
  call, not only the next turn, and picking an account that is cooling down
  tries it again at once (if it is still limited, the turn moves on as
  above).
- **Run picker and Git changes fixes** `[v3.43.0]`:
  - An account whose credits are spent but whose usage windows still have
    room reads "N% left · no credits" in the run picker, not "Limit reached":
    the plan's windows still run it.
  - Closing the run picker puts focus back where it was: the message box
    after `⌘.`/`Ctrl+.` (so Tab switches Code/Plan again), not the chip.
  - Enter on a model from another provider that has several accounts keeps
    the run picker open on that provider's account list; Enter on an
    account picks it and closes.
  - In the Git panel's **Changes**, a click on a file shows or hides its
    diff right under the row; **Open diff in tab** stays in the row's ⋯,
    right-click and long-press menus.
- **Type-to-focus composer** `[v1.40.0]` — in coding chat, start
  typing on the chat surface to expand/focus the composer and capture the first
  character without pressing `⌘I`/`Ctrl+I` first.
- **Slash commands** `[since v1.0]` — `/init`, `/compact`, `/undo`,
  `/redo`, `/redo-all`, `/btw`, plus user-defined commands. Commands are contextually
  filtered by active session state `[v2.0.0]`.
  - **`/redo` and `/redo-all` slash commands** `[v2.0.0]` — restore undone chat turns
    step-by-step or fast-forward completely back to the latest turn.
  - **Return on a phone keyboard picks the command** `[v3.60.0]` — with the
    slash, snippet or @-mention menu open, an Android keyboard's Return picks
    the highlighted row instead of adding a new line.
  - **Undo messages** `[v3.57.0]` — `/undo-messages` (and **Undo messages to
    here** in a prompt's long-press sheet on a phone) takes the turn back out
    of the chat but leaves the workspace files as they are; `/undo` still
    rolls files back too. The undo notice then adds "Files were not changed.",
    and **Redo** / **Redo all** bring the turns back without touching files. If
    an earlier Undo in the same run rolled files back, Redo restores files as
    usual. Not listed in Chat, whose `/undo` never touches files. API:
    `POST /api/agent/commands` with `{"command": "undo", "keep_files": true}`.
  - **`/btw` side questions** `[v3.17.0, v3.18.0]` — `/btw <question>` asks a quick question
    about the session, even while the agent is working, without interrupting the turn
    or adding anything to the chat. The model answers from the conversation so far,
    with no tools. Side questions are saved with the session; copy an answer, stop it,
    or clear the thread. On desktop with a workspace they open in the review dock's
    **BTW** tab, which lists every question and answer `[v3.18.0]`; on phones and
    without a workspace they open in a panel above the composer, where you step back
    through earlier ones and Close only hides the panel. Show them again with a bare
    `/btw`, **Cmd+K → Side Questions**, or the **BTW** chip.
    Answers no longer credit you with the runtime's own notes, such as a Plan
    mode note or a goal reminder `[v3.31.1]`.
  - **`/init` AGENTS.md analysis & generation** `[v1.9.0, v2.0.0]` — analyzes codebase
    structure and generates standard `AGENTS.md` context files at repository root and
    subdirectories with a guided analysis protocol.
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
- **Drafts survive a reload** `[v3.14.0]` — text typed in the composer,
  unsent answers to an agent's question, and plan-review comments are kept in
  local storage per session, so a reload, crash or app restart no longer loses
  them. Attachments are not kept.
- **The composer while the agent works** `[v3.0.0, updated v3.51.0]`:
  - Scrolled away from the live end, a "↓ N new" chip rides on the
    composer and counts what arrived since.
  - While a turn runs, Send splits in two. The pill steers: the agent reads
    the message before its next step (`Enter`). The chevron adds Queue until
    done, which the server holds and sends as a turn of its own once the turn
    ends, even if this window is closed or reloaded meanwhile `[v3.51.2]`
    (`⌥Enter` / `Alt+Enter`), and Stop & send
    (`⌘Enter` / `Ctrl+Enter`). In the transcript, steering messages read
    "Read before the next step" and held ones "Sends when this turn ends".
  - Stop & send waits for the stopped turn, including a running tool, to
    wind down, then sends; steers the agent had not read go out first, after
    the stopped turn `[v3.11.0]`.
  - Queued messages reach the agent in the order they go out: steers first,
    then held messages, which start the next turn together. A steer is read before the running
    turn's next step, or starts the next turn if that turn makes no further
    step. Its `@` mentions arrive with it `[v3.4.0]`. A steer sent while a
    question or plan review waits replaces it and starts a new turn; a held
    message waits until the question is answered or dismissed.
  - A steer sent with another model or thinking level switches the running
    turn to it from the step that reads the steer `[v3.48.0]`.
  - Stop, or a turn that fails, returns what the agent has not read yet to
    the composer: unread steers, then held messages `[v3.4.0]`. A steer the
    agent read first stays in the transcript. A steer with files sent from
    another window stays with the agent and goes out ahead of the next
    message. Reports from members, and messages from another workspace's
    agent, are never handed back: a member's report waiting for a busy lead
    stays out of the queue and appears as "Report from …" once the lead
    reads it or the turn is stopped `[v3.30.0]`.
  - Limits: a steer sent late still goes out before an earlier held message. Steers
    read together run with the model and thinking level of the last one
    sent.
- **`@file` / `@folder` mentions in composer** `[v1.17.0]` — files render blue,
  folders render orange. Mentioned files inject inline hidden context on the
  turn without becoming uploads; mentioned folders inject a lightweight directory
  listing without becoming uploads. In coding sessions,
  clicked file mentions in sent user messages open that file in the workspace
  files sidebar. Caps at 20 mentions / 20 MB / ~32k chars per turn. Persists
  on queued messages.
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
  The ring now sits in the composer's run deck, not the header. The whole
  session's cost moved from its popover to Usage, so cost shows per turn
  (the answer's footer) and for the last 24 hours (the status bar)
  `[v3.48.0]`.
