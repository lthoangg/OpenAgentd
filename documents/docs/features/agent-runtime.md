---
title: "Features: Agent runtime"
description: "The turn loop, subagents, goals, plans, scheduling, and how a session runs."
---

# Agent runtime

Part of the [feature catalogue](../features.md), under *2. Agent runtime*. The index explains the version tags.

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
  A lead stays loaded while its subagents work, so a job longer than 30 minutes
  still reports back instead of being cancelled when the idle lead was unloaded `[v3.24.0]`.
- **Lead control over its subagents** `[v3.30.0]` — `team` takes an `action`:
  `interrupt` cuts one subagent's current step short and starts it on a new task at
  once, `stop` ends one subagent's work without a report (a later task resumes it with
  its context), and `list` shows each subagent's status. Calls without an `action`
  spawn or send as before; a follow-up sent to a busy subagent now says it waits for
  the subagent's current work. A subagent that fails tells the lead the real reason
  (e.g. "Provider Authentication Failed: …") and whether retrying can help, instead
  of "Subagent turn failed with error." One that can't reach its model (out of quota,
  or retrying for 2 minutes) tells the lead once, so the lead can stop it and go on.
  Stopped subagents show as `stopped` rather than `error`.
- **Finished subagents leave memory** `[v3.56.0]` — a subagent whose turn completed
  is unloaded 5 minutes after its report reached the lead; before, it stayed loaded
  until its lead was deleted. `team(action='list')` and the app still show it as
  done, and a message to its handle (`team(target='explorer#1', task='…')`) loads the
  same session back with its whole conversation. A subagent that failed, was stopped
  or waits on the lead's answer stays loaded.
  - After a restart, the list also shows the lead's earlier subagents; it used to
    say "No subagents yet."
  - A profile name alone (`target='explorer'`) finds only a loaded subagent; the
    handle always works.
  - A report longer than 32,000 characters is cut, and its notice now tells the
    lead to ask the subagent for the rest by its handle. It used to point at the
    subagent's session, which the lead cannot read.
- **Shorter tool names** `[v3.30.0]` — `schedule_task`, `send_to_workspace`,
  `delegate` and `todo_manage` are now `schedule`, `workspace`, `team` and `todo`,
  with the same arguments. A session from before the rename that calls a former
  name is told the new one ("Did you mean 'team'?"); agent files that list a
  former name are left as they are; old transcripts render as before.
  Calls to the older v2 team tools (`team_spawn`, `team_send`, `team_list`,
  `team_wait`, `team_stop`, `team_manage`, `send_to_lead`) in old transcripts show
  as ordinary tool cards, with the call and its result as text `[v3.56.0]`.
- **Built-in instructions that agree with each other** `[v3.23.0]` — the built-in
  prompt, runtime rules, Plan and Code notes, tool descriptions, bundled skill, and
  member prompts were reviewed together, so they no longer contradict each other or
  name tools the agent does not have:
  - The agent follows `AGENTS.md` files and loaded skills as working guidance; the
    runtime rules no longer call them untrusted data.
  - Delegated agents (`explorer`, `researcher`) get their own Plan and Code notes
    instead of the lead's instructions for tools they lack. They are told they see
    only the task the lead sent, and that the lead receives at most 32,000
    characters of their deliverable.
  - A member file that an earlier release wrote and you never edited now follows the
    built-in prompt, so prompt updates reach existing installs. New installs write
    member files with frontmatter only. A prompt you edited is kept.
  - Chat sessions are told they run in your Chat folder, not in a project.
  - The memory catalog lists each page by its path, so the agent can read it directly.
  - Compaction summaries keep the corrections you gave the agent.
  - Session titles in Vietnamese, Chinese, Japanese, Korean, and other scripts are no
    longer cut mid-word.
  - `/init` sends a quarter of the instructions it did (8 KB instead of 32 KB).
- **What a finished answer still waits for** `[v3.55.0]` — when the main agent's turn
  ends while work it started is still running (subagents, or sessions it asked in
  other workspaces for a reply), a line under the answer says **Waiting for 3
  sessions**, with **· 1 needs you** when one of them is stopped on a question or a
  plan review. Click it (a sheet on a phone) for the list: each session's title,
  whether it is a subagent (with its handle) or which workspace it runs in, and
  **Running**, **Needs you** or **Idle**. A row opens that session, in this workspace
  or the other one. The line follows sessions as they start and finish and goes when
  nothing is left; a subagent's own session has none. The Goal tab's "Waiting for…"
  line counts the same sessions, so it includes other workspaces now. The server
  reads which replies it is still owed back from its database when it starts (it
  kept them in memory only), so the line, the sidebar's active list and the
  held-back "Done" notification stay right across a restart. Deleting a session
  that owed a reply ends the wait for it.
  From `[v3.56.0]` the line shows while the main agent is still running too, in one
  place after the transcript, so it never jumps or doubles when the turn ends. On
  the desktop it opened the list inline under the line; from `[v3.57.0]` it opens
  a popover again, so the transcript stays put, and a phone keeps the sheet. Idle
  sessions are left out: the line, the list and the Goal tab count only sessions
  that are running or need you.
  From `[v3.63.0]` it counts the background commands the session waits for too
  ("Waiting for 2 sessions and 1 command"), and reads "1 command running" when
  only a server is left. Each command in the list has **Stop**.
- **Background commands report back** `[v3.63.0]` — a `shell` command the agent
  starts in the background gets a number and a log of its output under the
  session's data (the newest 10 MB is kept). When it exits, the agent gets a
  message with its exit code, how long it ran and its last 40 lines, so it no
  longer polls with `sleep` and `tail`. The transcript shows the message as the
  command, its exit code and the end of its output. In Simple detail a result
  the agent went on to answer folds with that turn's work ("1 command, 1
  report"); one no turn followed (a server exited, or you stopped it) shows
  after the last answer, which stays in place. A command's text is shown with
  stored secrets masked, in the list, the message and the notes alike.
  - The agent marks a command whose result it needs (a build, a test run) with
    `wait`. The session then counts as working until it ends: an idle session
    starts its next turn on the result, a goal holds its next turn, the sidebar
    keeps the session on its active list, and "Done" is not sent before it. A
    waited command still running after 2 hours is ended and reported as timed out.
  - A command without `wait` (a dev server) never starts a turn. If it exits
    while the agent works, the agent reads that before its next step; otherwise
    at the start of its next turn.
  - **Stop** on the turn ends the commands the session waits for, without a
    message, and leaves servers running. **Stop** on a command in the list ends
    that one and tells the agent. Deleting the session ends all its commands.
  - Quitting or restarting OpenAgentd ends the commands it started. On the next
    start each session is told which were cut off; one that waited for a
    command starts a turn on that note.
  - The goal check's record shows how a background command ended ("background
    command 3 ended: failed, exit code 101"), a goal's reminder lists the
    commands still running, and so does a note after compaction.
  - A subagent's background command gets the number and the log, but no
    message: a subagent's turn end is its report.
- **Cross-workspace messages** `[v3.9.0, updated v3.35.0]` — the lead agent's `send_to_workspace`
  tool sends a request to an agent session in another workspace you have opened
  that shares a workspace group (see **Workspace groups** below) with its own (a related
  repository, a worktree of its repository, or Chat), for example from an app
  repository to its infrastructure repository. The request starts a new session there, or
  continues one of its top-level sessions (queued when that session is busy). It
  arrives as a prompt with a **From <workspace> · <session>**
  chip that opens the sending session. Since `[v3.50.0]` it is the sending
  agent's, not yours: it has no Edit, Undo or Retry, and undo and redo step
  over it. A session a send started shows **Handled by the agent in
  <workspace> · <session>** above its composer, which opens the sender; you can
  still type into it and steer as usual. `mode: "plan"` makes a new session plan
  first and wait for your approval; an existing session keeps its mode, and a
  `mode` sent along with `session_id` is ignored instead of refused `[v3.35.0]`.
  The tool card in the sending session has an
  **Open in <workspace>** button that switches to the session it reached
  (since `[v3.49.0]` a small **Open ↗** chip in the card's own row). With
  `reply: true`, the other session's final answer comes back as a **Workspace
  reply** report that starts the sender's next turn and links to the replying
  session:
  - The answer waits until that session's subagents finish, and until any
    question or plan review it raises is answered.
  - A failed or stopped run sends one interim notice, and the answer still
    follows if it is retried.
  - You get one completion notification, from the sender, instead of one from
    each side.
  - Since `[v3.50.0]` a turn only agents worked in (another workspace's
    request, with nothing you typed into it) sends no Done or Failed
    notification and does not mark the session unread. A turn you start or
    steer in that session notifies as usual.
    Since `[v3.51.0]` the notch and the tray's list follow the same rule
    (they used to show such a turn as **Done**), and while the sending
    session is listed, the session it started is left out of the notch, as
    the sidebar nests it under its sender; a question from it still shows.
    In such a turn the agent's `ask_user` does not reach you either, since
    you are not following it: the agent is told to end with its question,
    which goes back to the sending agent to answer with a follow-up, or,
    when no reply was asked for, to decide and state its assumptions. Once
    you write into the turn, its questions reach you as usual.

  When the session it continues is busy, `delivery` picks how the message lands,
  the same three ways you can send while a turn runs `[v3.35.0]`:
  - `steer` (the default): the session reads it before its next step.
  - `queue`: it waits, shown as "Sends when this turn ends", and starts a turn
    of its own once the running turn ends. Several queued messages start one
    turn together.
  - `stop_and_send`: the running turn (and its members) is stopped, an active
    goal stays active, and the message starts a new turn that is told its
    previous turn was stopped. It can stop a session you are working in, so the
    tool tells agents to use it only when the current work is wrong or obsolete.

  An idle session just starts a turn for any of the three. A message already in a
  session's history never changes, so the provider's prompt cache stays valid.

  `action: "list"` shows the workspaces you can message under their groups,
  each with its brief, or one workspace's recent sessions with their state,
  most recently active first with their last activity time (the sidebar's
  order) `[v3.39.0]`.
  Sending to a workspace outside its groups is refused with a message telling
  the agent it can propose a shared group (see **Workspace groups** below)
  `[v3.35.0]`. Limits: a request can pass through at most
  three workspaces, a turn can make at most ten sends, and a reply is trimmed to
  32,000 characters. **Settings → Workspaces → Messages** turns the
  tool off for every agent; replies already on their way still arrive.

  **Worktrees from chat** `[v3.36.0]` — to run several features in one
  repository at once, the agent can send work to another checkout of the same
  repository by naming it in `worktree` (the workspace defaults to the current
  one). An existing worktree is matched by name, `"main"` targets the main
  checkout, and a new name creates a worktree on branch `oad/<name>` from the
  sender's current commit and starts the session there, so you no longer create
  and pick each worktree yourself. The tool card shows a **Created worktree**
  chip and the checkout the message reached. Folders that are not git
  repositories cannot have worktrees, and the agent is told so.

  **Sessions that work together, in one place** `[v3.46.0]` — a session a send
  started is listed in the sidebar under the session that sent it, down the
  whole chain (app sent to infra, infra sent to web: both under app). The
  sender's row has a **↗ N** pill, folded at first like subagents, whose mark
  says when one of those sessions is running or waiting on you. Open it to see
  each session with its workspace and state, and click one to switch to it.
  The started session still sits in its own workspace too, with a **↰ app**
  mark that opens the sender. In the Status, Date and None views it is listed
  only under its sender, so no session shows twice; Needs you still lists it
  when it asks you something. A session you started yourself stays where it
  is when another workspace messages it. Sessions sends started before this
  release are grouped too, and deleting the sender leaves them in place.
  Since `[v3.51.0]` the **Running** section (the phone's Sessions page and the
  sidebar's Status view) lists only sessions you started; one an agent started
  stays under its sender (or in Recent when its sender is not listed), and
  still shows under **Needs you** when it asks you something. The ↗ list and
  the subagent list under a session show the most recently active first.
- **Workspace groups** `[v3.21.0]` — named tags on
  repositories that say which workspaces belong together. Set them up in
  **Settings → Workspaces → Groups**: create a group, give it a
  name, any colour (from the colour picker, or typed or pasted as a hex code
  such as `#3b82f6`), and a **brief** (a short note such as "web = Next.js
  frontend, api = Rust backend" that agents see in `send_to_workspace`
  listings), and add or remove its repositories, all on one screen. A
  repository can be in several groups. Its actions menu in the sidebar
  (right-click, **…**, or long-press on phones) has a checkbox per group for
  quick tagging and **Manage groups…** to open the settings. Each sidebar
  row shows a dot in each of its groups' colours, and **View options →
  Workspace group** narrows the Project view to one group, with **Show all
  workspaces** to go back. Groups decide who can message whom:
  - Two workspaces can message each other only when their repositories share
    a group. Worktrees use their repository's groups, and a repository and
    its worktrees can always message each other.
  - Chat can message every workspace, and every workspace can message Chat.
  - A repository in no group can message only Chat and its own worktrees,
    so after upgrading, group related repositories to let them talk again.
  - Replies are never blocked: a request that was allowed when it was sent
    still gets its answer back.
  - **Group repositories from chat** `[v3.35.0]` — ask the agent ("group this
    repo with infra") and it proposes the groups one repository joins or
    leaves (`workspace` with `action: "set_groups"`; a new name creates the
    group, its other groups stay). Nothing changes until you choose **Apply**
    on a **Confirm change** card that names the repositories that will be able
    to message each other. The change is checked again when you apply it: if
    the repository's groups changed in the meantime, or a group it would
    create now exists, nothing is applied and the agent is told why. Only
    registered workspaces can be grouped (the agent asks you to open a folder
    in the app first), a worktree is grouped through its repository, and Chat
    is in no group. In Plan mode the agent can only list.
    The same card can set or clear a group's **brief** (`brief` with one group
    in `join`), when the group is created or on its own; the card shows the
    brief before and after, and an edit made in Settings meanwhile is not
    overwritten.
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
  transcript keeps one retry notice that counts the attempts, and since
  `[v3.46.0]` it goes away once the call answers or the turn ends.
  Summarization, which cannot be stopped mid-call, gives up after 10 attempts.
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
- **Automatic provider quota-exhaustion wait and resume** `[v2.20.0, updated v2.22.0, v2.23.0, v3.30.0]` — when an
  OAuth provider (such as Codex, GitHub Copilot, or Grok) or any configured
  model hits rate-limiting or quota exhaustion with a known reset window
  (detected via headers, JSON metadata, body text phrasing, or live usage API
  lookup), the agent does not abort or fail. It transitions to an
  interruptible quota-wait state, emits live `waiting_quota` status events,
  displays a minute-updating countdown in the transcript, restores an active
  countdown after a browser page reload, and automatically resumes work once
  the window resets. Stale quota-wait banners are cleared when turns resume,
  when later transcript activity supersedes the wait state, or when a reopened
  session is no longer actively waiting. The user can manually stop or
  interrupt at any time. Since `[v3.46.0]` the card gives way to the reply
  dots the moment the quota resets, a reload keeps a pinned account's card
  and its choices, and a run of failed retries ends in one line ("Stopped
  retrying … after 5 attempts") above a single error card instead of a
  blank "Model error" card. An account spend cap (such as Anthropic's monthly
  spend limit) is not waited out: the turn fails at once and says to raise
  the limit or switch model `[v3.30.0]`.
  Since `[v3.54.0]` a provider that still fails after its retries ends in a
  "*model* is unavailable" card that says how often it failed and that your
  messages and changed files are kept, with the same Retry, Switch model and
  Open Providers buttons. The provider's own error text is no longer the
  card's message: it is in **Copy details**.
  With several keys or accounts for the provider, a limit first switches to
  the next one; the wait (for the earliest reset of any of them) and the
  spend-cap failure apply only once every credential is unavailable `[v3.30.0]`.
- **Actionable provider HTTP errors** `[v1.56.0]` — non-retryable provider
  responses (400/401/403/404/422) are classified into typed errors that carry
  the provider's own explanation instead of a bare status code. 401/403 render
  the "configure / reconnect provider" banner; 400-class errors surface the
  specific reason (bad model, unsupported parameter, context too long) in the
  error event and agent notification. Exhausted connection/timeout failures
  likewise become a typed `ProviderConnectionError` naming the transport error
  and pointing at the provider's base URL.
- **Model refusals are visible** `[v3.14.0]` — when Claude's safety
  classifier cuts a response off (`stop_reason: "refusal"`), the turn ends on
  a "Model Declined to Continue" error card with Retry and Switch model,
  quoting Anthropic's explanation when present. The refused response is not
  saved, so it does not trigger repeat refusals, and its truncated tool calls
  do not run. Before, the turn just ended with nothing shown.
- **Empty model answers** `[v3.37.0]` — when a model answers with nothing
  after a tool result, the agent retries up to three times with a short
  backoff (0.5 s, 1 s, 2 s; Stop ends the wait), then ends the turn on an
  error card instead of finishing silently. Responses-API replies whose text
  arrives only in the finished item (no streamed deltas) are no longer read
  as empty, and a truly empty reply logs `responses_empty_output` with the
  events it carried.
- **Stop cancels the whole active session run** `[v1.101.1]` — Stop directly
  cancels the agent, in-flight model/tool work, direct shell
  commands, and the background commands the session waits for before the request
  returns (from `[v3.63.0]`; before, v3 left every background command running).
  A background command the session does not wait for, such as a dev server,
  keeps running. Queued and late mailbox work cannot restart the stopped turn.
  A tool that was still running keeps the output it had streamed, followed by
  "Cancelled by user after N seconds.", both in its card and in what the
  agent sees next turn `[v3.0.0]`.
  If the turn still has not ended 10 s after Stop (for example a plugin hook
  that never returns), it is ended forcibly, its reply is marked interrupted,
  and the session goes back to idle `[v3.14.0]`.
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
  pick it from the model list like any other model.
  Changing the agent's default model, thinking level, prompt or tools in
  Settings while a session runs no longer switches that run: member reports,
  queued steers and answered questions continue on the config the run started
  with, and the edit applies from the user's next message `[v3.30.0]`.
  Since `[v3.40.0]` the choice is made in the run picker under the composer,
  saved on the session as soon as it is picked (not on the next send), and
  can include the account to run on.
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
