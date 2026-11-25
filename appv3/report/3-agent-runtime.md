# REPORT §3: the agent runtime

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

## Deviations, one per item

- **`/btw` side questions** (v3.17.0, v3 only). A quick question about
  the session, answered from its persisted context with no tools and never
  added to the transcript (`agent/src/side_question.rs`).
  - Endpoints (`api/src/routes/agent/chat.rs`):
    - `POST /api/agent/sessions/{sid}/btw {question}` streams
      `btw_start`, `btw_delta`, `btw_done` and `btw_error` (new
      `side_question_stream` in `crates/agent/data/sse_events.json`; `btw_error`
      carries `status: error|stopped` and the partial answer).
    - `GET …/btw?limit=` lists the thread oldest first, `GET …/btw/count`
      feeds the web chip, `POST …/btw/{id}/stop` (204, or 404 when not
      running), and `DELETE …/btw` stops and deletes.
    - Before streaming: 404 for an unknown session, 400 for a subagent
      session or an unconfigured provider, 422 for a question that is
      empty or longer than 20,000 chars.
  - Rows live in `side_questions` (revision 00000023, below), written once
    at start and once at the end, never per delta. Each ask replays the
    newest 20 finished exchanges and keeps at most 100 per session.
    Deleting a session deletes them.
  - The request reuses the system prompt and tool definitions of the
    session's last model call (recorded in memory by `RequestFrameHook`),
    so it hits the turn's prompt cache. After a restart they are rebuilt
    the same way a turn builds them. `tool_choice` is left unset because
    changing it invalidates Anthropic's cached messages: the `btw_prompt`
    forbids tools, and a tool call made anyway is dropped with a note.
  - Generation runs in a detached task, so a closed connection does not
    cancel it. Stop, clear and session delete do. A row left `streaming`
    by a restart is stored as `stopped` the next time the thread is listed.
  - Each ask records a `side_question` client span with the session id
    and usage (lengths only, no text).
- **Goals: Keep going until done (v3.32.0, v3 only).** Approving a plan
  with Keep going starts a durable objective, the plan's Done when, that a
  top-level session keeps taking turns toward until a completion check
  confirms it, the agent reports a blocker, or a limit pauses it
  (`agent/src/goal.rs`, the completion check in `agent/src/goal/check.rs`,
  `agent/src/tools/goal.rs`). There is no `/goal`
  command and no goal field on `POST /api/agent/chat`. Formats:
  - *Table:* revision **00000028** adds `session_goals`, `WITHOUT ROWID` and
    clustered on `(session_id, id)` with uuid7 ids: `objective` (≤ 4,000
    chars), `status` (`active|paused|achieved|cleared`), `pause_reason`
    (`stopped|user|blocked|turn_limit|no_progress|unverified|check_failed|error|restart`;
    `token_limit` only on goals paused before goals lost their token budget),
    `detail` (blocker or last check reason), `max_turns`, and
    the counters `turns_used`, `tokens_used` (uncached input plus output),
    `active_seconds`, `rejected_claims`, `idle_turns`. The partial unique
    index `uq_session_goals_live` allows one active or paused goal per
    session. No foreign key; session delete removes the rows in its
    transaction. The `token_budget` column stays but is unused: a goal has
    no token budget, so spending tokens never pauses it.
  - *Starting a goal:* the plan review answer
    (`POST /api/agent/{sid}/question/{qid}/answer`) takes
    `keep_going` beside `answers`: `true`, `{}` or `{"max_turns": n}`
    (1–1000; omitted takes `goals.max_turns`). Request changes ignores it.
    With Approve the plan needs a non-empty Done when (`plan::done_when`
    reads a `**Done when:**` paragraph or a `Done when` heading section,
    capped at 4,000 chars; the plan JSON exposes it as `done_when`); a
    plan without one, or turns out of range, is a 422 that leaves the
    review open. After approval
    `AgentSession::start_goal_from_plan` clears a live goal, creates the
    goal, and saves its
    rules in a pinned, hidden `kind='note'` row with `extra.goal_note` and
    `extra.goal_id`, kept out of compaction while the goal is live; when no
    turn resumed, it starts one. The approval result asks for one `todo`
    task per plan milestone and, with Keep going, adds the goal rules.
    Once the goal ends the note is unpinned and a `<goal_ended>` note
    (`extra.goal_ended`) follows, both between turns only. The goal's part
    of the history starts at its rules note.
  - *Routes* (`api/src/routes/agent/goal.rs`): `GET
    /api/agent/sessions/{sid}/goal` returns `{goal}` (the newest goal of
    any status, or `null`); `POST …/goal/pause` and `…/goal/resume` return
    the goal, or 404 without a live one; `DELETE …/goal` is 204 and
    idempotent. Resume grants another settings-sized batch of turns
    when the turn limit paused it, and starts a turn when the
    session is idle; while a stopped turn is still ending it is a 422.
    Pause and clear delete a queued `goal_turn` row. Member sessions are
    404.
  - *Undo:* undoing a message before the goal's rules note (back past the
    approval) clears the goal, since the note goes with it; undoing a
    `goal_turn` row keeps the goal.
  - *Continuation:* when a goal turn ends normally, `run_turn` accounts it
    and queues a user row with `extra.goal_turn {id, turn, max_turns, why,
    check?}` holding a `<goal_reminder>`, which names the plan file and the
    next unfinished task (in progress, else first pending). `why` says why the
    goal went on, for the transcript's turn divider: `unclaimed` (the last
    turn ended without a claim), `rejected` (the last check said not yet;
    `check` is its reason), `check_failed` (the last check gave no
    verdict) or `resumed`. It then runs like an activated queued
    message, without `close_turn`, so no notification fires until the goal
    stops; that one is titled `Goal achieved`, `Goal blocked` or `Goal
    paused` instead of `Done`, and the `desktop_notification` payload gains
    `goal` (`achieved|blocked|paused`). Queued messages, working subagents, an open question,
    and Plan mode make it wait (`PATCH` to Code mode starts it). Two turns
    in a row without tool calls pause it (`no_progress`), as do the turn
    and token limits, a failed turn (`error`), and Stop (`stopped`).
    Startup pauses running goals with `restart` and deletes their queued
    `goal_turn` rows.
  - *`update_goal` tool* (`crates/tools/data/tool_definitions.json`):
    `{status: complete|blocked, evidence? (≤ 4,000 chars), reason? (≤ 2,000)}`, injected into every
    lead session so the cached tool list does not change; it fails without
    a live goal. `blocked` pauses the goal with the reason. `complete` runs
    the check inline: one request on the session's own model and thinking
    level (there is no separate check model), with its last request frame
    (system prompt and tools, from `RequestFrameHook`, as `/btw` does), the
    history the claim was made from, the claim's text without its tool call
    (a stand-in line when it has none),
    and a hidden `<goal_check>` user message asking for JSON `{met,
    reason}`, so the turn's prompt cache covers all but the new tail. The
    message also carries a `<runtime_log>`: the runtime's own record,
    from the goal's part of the history (after its rules note), of
    each `shell` command with its outcome (`succeeded`, `failed, exit code
    N`, `timed out`, `started in the background as command N`, `no result
    yet`), each background command's end from its report row (`background
    command N (…) ended: succeeded`, `failed, exit code N`, `timed out at
    its limit`, `stopped by the user`) and each
    applied `patch` with its files, the last 40 steps, then the files
    changed after the last command that ran to an end, and a
    `<task_board>` with the session's tasks; unfinished tasks count as
    unproven unless the claim explains them. The check is told
    to trust the log over the claimed evidence. The objective, evidence,
    log and board go in with their `<goal_check>`, `<objective>`,
    `<claimed_evidence>`, `<runtime_log>` and `<task_board>` tags defused,
    so none can close its block.
    `tool_choice` stays unset, which keeps Anthropic's message
    cache valid; a tool call in the reply is dropped. A reply without a
    verdict is asked once more; a second miss, or a check that cannot run,
    neither accepts nor rejects the claim (the result starts `The
    completion check failed:`), and three such failures in a row pause the
    goal (`check_failed`). Nothing of the check is saved to
    `session_messages`; the verdict goes in `detail`, and three rejected
    claims in a row pause the goal (`unverified`). A `complete` claim made
    after a rejection with nothing new since (no result of a tool other
    than `update_goal`, no incoming message other than a goal reminder) is
    rejected without a check: it counts as a rejection, and its result
    starts `The check did not accept the claim: Nothing ran since the last
    rejected claim` and repeats the last reason.
  - *Unattended turns:* unless `goals.allow_questions` is on, goal turns
    carry the unattended run metadata, as scheduled turns do, with a goal
    reason: `ask_user` returns the `goal_unattended_refusal` text instead of
    waiting, and `plan` with `submit: true` saves without opening a review and
    leads with `goal_unattended_submit`.
  - *Events and sessions:* the global stream gains `session_goal
    {session_id, goal}` (`sse_events.json`), sent on every goal change,
    ended goals included. `SessionResponse` gains `goal_status`
    (`active|paused`, omitted otherwise) and the live goal's
    `goal_turns_used` and `goal_max_turns` on the list and detail routes.
  - *Telemetry:* a goal turn's `agent_run` span gains `openagentd.goal.id`
    (API id) and `openagentd.goal.turn` (from 1). Each check request gets
    its own `goal_check` CLIENT span under the `update_goal` tool span:
    `gen_ai.operation.name=goal_check`, the session, agent, provider,
    model, workspace and goal id, the `gen_ai.usage.*` tokens and estimated
    cost, `goal_check.attempt`, and `goal_check.met` when the reply had a
    verdict (`goal_check.stopped` when Stop dropped it mid-request). The
    check's spend therefore counts in the Telemetry totals, per session,
    and as its own step in `cache_by_step`.
  - *Settings:* `settings.yaml` gains `goals: {max_turns,
    allow_questions, keep_going_default}`, each written only when it differs
    from the default (50, `false`, `false`); a `token_budget` left in an
    older file is ignored and dropped on the next save;
    `keep_going_default` ticks Keep going in the review footer.
    `GET/PUT /api/settings/goals` returns them plus
    `default_max_turns`; PUT keeps omitted keys, resets `max_turns` with
    `null`, and returns 422 for a `max_turns` outside 1–1000 or an unknown
    key (`token_budget` included).

  Tests: `agent/tests/goal_loop.rs`, `agent/tests/goal_questions.rs`, unit tests in `agent/src/goal/tests.rs`,
  `agent/src/plan/tests.rs`, `db/src/queries/goals.rs` and `db/tests/queries.rs`,
  `agent/tests/plan_review.rs`, `goal_flow` in `api/tests/http_api.rs`.
  v2 has no equivalent.
- **`ask_user` free text is unconditional.** The model-facing schema has no
  `custom` flag, and a `custom` arg from an older schema is ignored. The
  question payload still carries `custom: true`, because clients on an
  earlier web build only offer free text when it is set. The answer route
  takes one typed answer per question even for rows stored with
  `custom: false` (`tools/ask_user.rs`, `api/src/routes/agent/questions.rs`).
- **Queued messages ("steers") keep send order and their context.** Both
  change where rows sit in `session_messages`; old rows need no migration.
  - A new message promotes any rows still `kind='queued'` (left over from a
    failed turn) to the tail *before* it is saved, so they keep their place.
    Previously the new message was saved first and the older steers were
    promoted after it.
  - On promotion, a steer's attached rows (`extra.attachment_for_message_id`,
    its @-mention context saved at queue time) move right after it and are
    pinned, as an idle send's mention note is. Previously they stayed at the
    queue-time position, which could fall between a tool call and its
    result, and the steer was injected without them. Queued rows from older DBs
    get the same treatment. `queued_turn_start` still lists only the
    steers (`db::is_attached_row`). Covered by
    `agent/tests/queued_messages.rs`.
- **Unknown agent tools** are pruned from the agent file on build, as
  `_prune_unknown_tools_from_file` does (`loader::prune_unknown_tools_from_file`).
  `diff_prune.py` runs 2,017 generated agent files (CRLF, comments, dates,
  int keys, invalid YAML, non-list `tools`): all identical to v2. One more
  check was added to `diff_chat.py`: an unknown tool added to `code.md`
  before the first turn is pruned identically.
  Deviation: v2 re-emits shared objects with `&id001` anchors, but v3's
  trees have no aliases, so an agent file that uses YAML anchors is
  rewritten with the aliased values expanded.
- **Session plan and plan review** (`agent/src/plan.rs`,
  `agent/src/tools/plan.rs`; tested there, in `agent/tests/plan_review.rs`,
  the summarization hook and `api/tests/http_api.rs`). v2 has none of this.
  - **Tools.** The lead gets one session-injected tool, defined in
    `crates/tools/data/tool_definitions.json`: `plan` (`write`, `edit` with 1–20
    exact-match replacements, or `new`, and/or `submit: true` with an optional
    `summary`; works in both modes, and in Code mode its description limits
    submitting to when the user asks for a review). A call that both saves
    and submits opens no review when the save fails. Until v3.32.0 the review
    was a separate `submit_plan` tool; the name stays reserved, agent files
    listing it are skipped like other former names, a call to it is told to
    use `plan`, and the web still renders its old cards. Agent files cannot claim either name. The
    `<proposed_plan>` tag is no longer captured, detected or acted on; old
    transcripts still render it as a read-only card.
  - **Where the plan lives.** In a project (`coding`) workspace the first
    write creates `<workspace>/.agents/plans/<slug>-<id8>.md` (v3.14.0; earlier
    releases used `.openagentd/plans/`, and plans already written there keep
    loading through the absolute path in `plan.state.json`) (slug from
    the first `# ` heading, `id8` the last 8 hex digits of the session id,
    `-2`, `-3`, … when taken). Creating that folder also writes
    `.agents/plans/.gitignore` containing `*`, so plans stay out of git
    status, snapshots and commits; the file is never recreated for an
    existing folder. The target is resolved with symlinks followed and must
    stay inside the workspace and outside denied paths. Chat sessions keep
    `<data_dir>/sessions/<sid>/plan.md`, v2's location.
  - **State and edit detection.** `<data_dir>/sessions/<sid>/plan.state.json`
    pins the path and holds `revision`, the file's `sha256`,
    `agent_revision` and `approved_revision`. Every read compares the hash,
    so edits from the Plan tab, another editor or git bump the revision.
    The agent is told once: the next lead turn saves a hidden `note` row
    (`extra.plan_edit_note`) with the new plan, and a `write` over unseen
    edits is refused once. A session with only a v2 `plan.md` reads as
    revision 1; its first write in a project workspace moves it.
  - **New plan** (v3.32.0). `action: "new"` closes the current plan and
    starts a fresh one from `content`, under the same lock: the state file
    is removed, a workspace plan file stays where it is, and a data-folder
    `plan.md` is renamed to the next free `plan-closed-<n>.md`. Completed and
    cancelled tasks are cleared from the board, so `carry_note` does not take
    the new plan for a finished one. The new plan is created as a first write
    (new file name, revision 1, no approval). A `write` over the approved
    revision is refused once (`write_warned` in the state), naming `new`;
    `edit` is not guarded. The result reads "Started a new plan … The
    previous plan stays at …", and the web refreshes the task board on it.
  - **Routes.** `GET /api/agent/sessions/{id}/plan` adds `revision`,
    `approved_revision`, `path` and `workspace_path`. New `PUT` on the same
    path saves the user's edit (`{content, base_revision}`; 409 when the plan
    moved on). `DELETE` returns 409 while a review is open and otherwise
    detaches: it removes the state file and any data-folder `plan.md` but
    keeps a workspace plan file.
  - **Review.** `plan` with `submit: true` opens a `pending_questions` row whose payload
    adds `kind: "plan_review"` and `plan_revision` (extra JSON keys, no
    schema change), and `question_asked` plus the pending-question response
    carry both fields. The answer route takes one string of at most 8,000
    characters for these rows (2,000 stays the `ask_user` limit): `Approve`
    switches a Plan-mode session to Code mode in the runtime (dropping a
    mode switch queued during the review) and emits `interaction_mode`; in
    Code mode a queued switch still applies when the resumed turn ends.
    Approval records `approved_revision` and resumes the turn with the
    approval as the tool result; anything else resumes in the active mode
    with the feedback. Edits made during the review are included in that
    result.
  - **Open question in the replay.** An attach to a turn waiting on a
    question (`ask_user` or a plan review) replays that turn's
    `question_asked` last, after the agent status, until it is answered,
    dismissed or superseded. A session parked on a question with no stream
    state left (expired, or a server restart) gets the frame rebuilt from its
    `pending_questions` row. Same event and payload as the live one; clients
    that missed the live frame (a reattach, a feed that went quiet) otherwise
    showed the agent waiting with no card.
  - **A question opens before the reply's other tool calls (v3.54.0).** An
    attended `ask_user` runs first, so its `pending_questions` row, its
    placeholder tool row and `question_asked` come before the sibling calls'
    `tool_end` frames and rows (the placeholder sits right after the
    assistant row), and `agent_status` stays `working` until those calls
    finish. The turn then pauses (`waiting_input`) only if the question is
    still open. An answer that arrives while the turn runs starts no turn:
    the route still returns `resumed: true`, and the running turn continues
    with the answer when its calls finish (no `waiting_input` frame). A
    question superseded or dismissed meanwhile ends the turn without a
    pause. A message queued behind a running turn (not "Queue until done")
    supersedes a question that is open beside it. Plan reviews and
    confirmation cards still open after the other calls.
  - **Mode notes.** The Plan-mode note is versioned (`version 3` since
    v3.21.0: reviewer-shaped plans with an Appendix and visuals; `version 4`
    since v3.32.0: submit with `plan` and `submit: true`); a session
    whose last Plan-mode note is older gets the new instructions once, and a
    version-1 note also gets a line saying they replace the `<proposed_plan>`
    ones.
  - **Plan attachments** (v3.21.0). `patch` and `browser` (`preview` before v3.62.0) are allowed in
    Plan mode, each checking every call (`interaction_mode.rs`
    `PLAN_MODE_ALLOWED_TOOLS`): `patch` writes only files at least one folder
    below `<workspace>/.agents/plans/`, with every Add, Update, Delete and
    Move path resolved through symlinks first, so plan files themselves stay
    with the `plan` tool (`tools/src/patch.rs` `plan_mode_refusal`);
    `browser` refuses `click`, `fill` and `press`, in a `chain` too
    (`tools/browser_args.rs`). A `plan` save in Plan mode names the plan's
    attachments folder (its path without `.md`).
  - **Compaction.** Compaction inserts a pinned, hidden `note` row
    (`extra.session_plan`) restating the plan before the summary unless one
    is still in context.
  - **v2 compatibility.** v2 ignores the state file, the workspace plan
    files, the extra payload and `extra` keys; the web client treats the v2
    404 as "no plan".
- **Runtime protocol and proactive memory** (`agent/src/hooks/basic.rs`,
  `memory/src/lib.rs`; tested there and in `agent/tests/runtime_protocol.rs`).
  v2 keeps its memory and git-safety rules inside the built-in `code` prompt,
  so an agent file with its own prompt loses them, and delegated agents get
  the memory block with no rules.
  - **Protocol.** `RuntimeProtocolHook` appends `runtime_protocol`
    (instruction sources, interaction mode, secrets, workspace and destructive
    git rules) to every agent's prompt, and `MemoryContextHook` puts
    `memory_protocol_lead` or `memory_protocol_member` just before
    `<openagentd_memory>`. The texts are new keys in
    `crates/agent/data/builtin_prompts.json`; `coding_prompt` drops its memory,
    interaction-mode and git-safety sections and one duplicated rule. The
    member rules are prompt-level only: the `patch` tool does not refuse
    memory writes from delegated agents.
  - **Proactive saving.** The lead is told to save preferences, corrections
    and durable facts the user states, in the same turn and without asking,
    using its normal file tools; no extra model call is made. v2 allows
    `preferences.md` edits only on explicit request.
  - **Limits.** `preferences.md` is pinned up to 1,500 characters (v2: 400)
    and the memory block up to 4,000 (v2: 1,500). The "more pages" marker now
    counts against the budget, which v2 overshoots by its length.
  - **User profile.** `user.md` is pinned in full up to 1,000 characters as
    `<user_profile>` after `<global_preferences>` and left out of
    `<global_knowledge>`; v2 lists it as a catalog line like any other page.
    Both memory protocol texts name the new element.
- **Global instructions file** (`agent/src/hooks/basic.rs`): `~/.agents/AGENTS.md`
  is the global file and `{config dir}/AGENTS.md` is read only when it is
  missing; v2 prefers the config-dir file and falls back to the home one. A workspace at `~` does not
  repeat the global file as workspace instructions.
- **Transport retries** (`agent/src/retry.rs`, `agent/src/streaming.rs`):
  a dropped connection, DNS failure or timeout retries on a flat, jittered
  3–5 s interval. The turn's model call retries without limit until the
  network is back or the user stops (its `provider_status` frames carry
  `max_attempts: null`); summarization, which cannot be stopped mid-call,
  gives up after 10 attempts. v2 backs off exponentially (up to 27 s) for 5
  attempts and then resumes the turn at most 3 times before failing with
  `ProviderConnectionError`; that resume layer is gone. HTTP errors keep
  v2's exponential backoff.
- **Cancelled tool calls** (`agent/src/agent/dispatch.rs`): a call still running when
  the user stops the turn records the output it had streamed (its last
  16 KiB) followed by `Cancelled by user after N seconds.`, stores
  `duration_ms`, and ends with a `tool_end` frame carrying that text. v2
  records a bare `Cancelled by user.` and sends no `tool_end`. A call that
  never started keeps v2's text. The shell tool also flushes pending live
  output and stops its streaming timer when its call is dropped.
- **Notifications** (`agent/src/notification.rs`, `agent/src/session/turn.rs`):
  `desktop_notification` titles are a short status and the workspace
  directory name (`Done · openagentd`, `Failed · …`, `Needs input · …`,
  `Plan ready · …`), and each body is one line of at most 100 characters,
  cut with `…`. v2 sends `Session completed - …` / `Needs your input - …`
  and the full question or session title, newlines included. The event
  shape is unchanged. v3 also changes when a lead turn notifies: a failed
  turn sends `Failed` (kind `assistant_done`), while v2 sends nothing. A turn
  the user stopped sends nothing, where v2
  sends `Session completed`. A turn that ends while its subagents still run
  also sends nothing: their reports start another lead turn, and the last
  one notifies. The event never names the computer. Each surface adds it
  where it shows the title: a push to the account's phones ends with the
  name this computer gives for itself (`Done · api · studio-mini`,
  `api/src/cloud/letters.rs`, from `routes::server_name::current_name`), and
  the apps add the name their server lists show (`DESIGN.md`, Companions).
  Since v3.55.0 an `assistant_done` notification carries `outcome`, how the
  turn ended: `done`, `failed`, or what became of the goal it worked on
  (`goal_achieved`, `goal_blocked`, `goal_paused`;
  `notification::outcome`). `kind`, `title` and `goal` are unchanged.
  Clients tell a failure from a finish by `outcome` and no longer by the
  title's first word: the phone letter's kind (`letters::kind_of`, where
  `failed` and `goal_blocked` are `failed`), the desktop notch's Failed row
  and the pet's bubble (`desktop/src-tauri/src/island.rs`, `Finish`). The
  desktop shell still reads the title when a server before v3.55.0 sends no
  `outcome`.
- **Cross-workspace messages (v3 only):** lead sessions get an injected
  `send_to_workspace` tool (`agent/src/tools/send_to_workspace.rs`,
  `agent/src/workspace_messages.rs`). It sends a user prompt to a new or
  existing top-level session in another visible registered workspace (or
  Chat), and optionally delivers that session's final answer back. The
  formats it adds:
  - The request row in the target stores `extra.sent_from`: `session_id`,
    `workspace`, `workspace_name`, `session_title`, `reply`, `hops`, and later
    `replied_at` / `error_notified_at`.
  - The reply is a queued user row in the sender with `from_agent` (the target
    workspace name) plus `extra.reply_from`: `session_id`, `workspace`,
    `workspace_name`, `status`.
  - `history.rs` adds a model-only header to both kinds of row.
  - `settings.yaml` gains `workspace_messages: {enabled}` (default `true`,
    written only when `false`), served by `GET/PUT
    /api/settings/workspace-messages`.
  - `UserMessage`/`Dispatch` take an `extra` map for the request row.

  Replies are decided when a top-level turn closes. They wait for working
  subagents. Failures send one interim notice and keep the request pending.
  A delivered answer replaces the target's own "Done" notification. Tests:
  `agent/tests/workspace_messages.rs`, unit tests in the two modules and
  `history.rs`, `db/src/queries/messages/tests.rs`, `core/src/runtime_settings.rs`,
  and `api/tests/http_api.rs`. v2 has no equivalent.
- **Idle compaction (v3 only, opt-in):** when a lead session's turn
  completes, a timer starts (`agent/src/idle_compaction.rs`,
  `agent/src/session/idle.rs`). If the session is still idle 270 s later, which is
  just under the 5-minute prompt-cache TTL some providers use, and its last
  prompt reached `idle_compaction_percent`% of the effective compaction
  trigger, it runs the same forced compaction as `/compact`. Any new turn
  cancels the timer. Subagent and scheduler sessions are skipped, as are
  sessions with an open question or a summary newer than their last model
  call. A lead whose turn ended while subagents are still working, or
  while another workspace still owes it a reply, is compacted like any
  other; a report delivered during the compaction turn is queued and runs
  a lead turn right after it. The compaction
  turn sends no desktop notification and does not re-arm the timer.
  The timer lives in memory. On startup the server resumes it for every
  lead session whose last turn completed (a reply that calls no tools and
  was not stopped) less than 300 s ago, since the provider's cache outlives
  the restart; older sessions are left alone. The manager counts a session
  as idle from the later of its last lookup and its last turn's start or
  end, so a turn longer than the 30-minute eviction cutoff no longer gets
  the session evicted, and its timer dropped, as soon as it ends. Formats:
  - `settings.yaml` gains `summarization.idle_compaction` (default `false`,
    written only when `true`) and `summarization.idle_compaction_percent`
    (1–100, written only when set; absent or out of range means 70).
  - `GET/PUT /api/settings/summarization` return both keys. PUT accepts both
    as optional, keeps a key's stored value when the body omits it, and
    returns 422 for a percent outside 1–100.

  Tests: `agent/tests/idle_compaction.rs`,
  `agent/tests/idle_compaction_restart.rs`, `agent/tests/session_eviction.rs`,
  unit tests in `agent/src/idle_compaction.rs` and
  `core/src/runtime_settings.rs`, and `api/tests/http_api.rs`. v2 has no
  equivalent.
- **Stop force-ends a stuck turn (v3 only):** if a turn has not finished
  10 s after Stop, `run_turn` drops it, marks that turn's assistant row
  interrupted (`db::mark_turn_assistant_interrupted`) and runs the normal
  end-of-turn path. Orphaned tool rows are healed on the next load. Test:
  `agent/tests/force_stop.rs`.
- **Model refusals end the turn with an error (v3 only):** when a response
  ends with `finish_reason: "refusal"` (Anthropic's streaming safety
  classifier), the agent loop drops the response. Its tool calls do not run,
  because they are truncated, and the assistant row is not saved, because
  Anthropic requires the refused turn to leave the context. Its tokens still
  count toward the turn total. The turn then ends with an `error` event:
  code `model_refusal`, category `provider`, title "Model Declined to
  Continue", and the message carries `stop_details.explanation` when
  present. The Anthropic adapter forwards `stop_details` on the stream delta
  (`ChatCompletionDelta::stop_details`, plugin JSON key `stop_details`), and
  the assembled message keeps it in `extra.stop_details`. v2 treated a
  refusal as `end_turn`: the turn ended silently and any partial tool call
  ran. Tests: `agent/tests/refusal.rs`, `providers/src/anthropic.rs`.
- **A provider that keeps failing ends the turn with `provider_unavailable`
  (v3 only):** when the HTTP retry budget is spent on an error other than
  429, or the request can never be completed
  (`ProviderError::NetworkPermanent`), the `error` event has code
  `provider_unavailable`, category `provider`, the title "{provider:model}
  is unavailable", a message in plain words, and a new optional `details`
  field holding the transport's own text (status line, URL, the provider's
  message). `agent_status` carries the same `details` in its metadata. v2
  and earlier v3 sent the transport text as the message under "Agent
  Execution Error" (`agent_execution_failed`). Tests: `agent/src/streaming/tests.rs`.
- **Lead messages to a member carry `extra.from_lead` (v3 only):** the
  rows the lead sends a subagent (the spawn task `[Task from Lead]: …`, and a
  follow-up `[Lead]: …` whether the member was idle or mid-turn, so queued)
  are saved with `extra.from_lead = {"session_id": "<lead id>"}`, the
  hyphenated form the API gives as `parent_session_id`
  (`subagents::from_lead_extra`). The web client uses it to link the row back
  to `/<id>`. It is UI metadata: `/history` returns `extra` unchanged, the
  key survives queue promotion and the merge in `handle_user_message`, and the
  model never reads it. Unlike `from_agent` it does not make the row a report
  (no `[handle]:` header, still a user prompt). Rows saved before this have no
  `from_lead`. Test: `agent/tests/subagent_from_lead.rs`.
- **Question dismiss route removed (v3 only):** `POST
  /api/agent/{session_id}/question/{question_id}/dismiss` and
  `AgentSession::end_turn_after_question_dismissed` are gone, since no client
  calls them. A question is now closed unanswered only by stopping the session
  (or by a new message superseding it), which resolves it as `dismissed` /
  `superseded` and pushes `question_dismissed`; the event, the statuses and
  the web client's handling of them are unchanged. Test:
  `agent/tests/stop_dismisses_question.rs`. v2 still has the route.
