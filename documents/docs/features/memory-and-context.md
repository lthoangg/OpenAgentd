---
title: "Features: Memory and context"
description: "Summarization, memory pages, instructions files, and what the agent carries between turns."
---

# Memory and context

Part of the [feature catalogue](../features.md), under *4. Memory and context*. The index explains the version tags.

OpenAgentd carries context across sessions via rolling-window summarization.

- **Persistent Markdown memory subsystem** `[v2.22.0]` — file-backed persistent knowledge
  in global (`{OPENAGENTD_CONFIG_DIR}/memory/`) storing authoritative human-editable `.md` pages.
  Dynamically compiles a bounded
  XML catalog (`<openagentd_memory>`) capped at 4,000 rendered characters (up from 1,500 `[v3.3.0]`
  and 3,000 `[v3.17.0]`) into
  `state.system_prompt` during `before_agent` (0 filesystem I/O across model turns),
  pins `preferences.md` directives (<= 1,500 chars, up from 400 `[v3.3.0]`), synchronizes concurrent edits with reference-counted
  path locks and quoted strong SHA-256 ETags (HTTP 412/428), provides `/memory` slash
  commands, and exposes a Settings viewer/editor with conflict resolution and deterministic
  wikilink linting.
- **User profile always loaded** `[v3.17.0]` — `user.md` is included in full (up to 1,000
  characters) in every session's memory block instead of as a one-line catalog entry, so
  the agent knows who the user is from the first turn without reading files.
- **Proactive memory about the user** `[v3.3.0]` — the lead agent saves stated
  preferences, corrections, and durable facts about the user (to `preferences.md`,
  `user.md`, or topic pages) in the same turn without asking, and says what it saved.
  Delegated agents read memory but do not write it.
  The agent now knows it has memory: asked whether it can remember things, it says yes
  and explains how. It also saves facts you mention in passing inside a request
  (your name when you introduce yourself, your setup, your editor) before doing the
  task, and it saves in Plan mode too. Rules for a single repository are not saved;
  the agent suggests adding them to that repo's `AGENTS.md` instead `[v3.24.0]`.
- **Frozen per-session memory** `[v3.10.0]` — the memory rules are always added for the
  lead agent, and the `<openagentd_memory>` block is read once on a session's first turn
  and reused unchanged, so the system prompt stays byte-identical and prefix caching holds.
  Pages saved mid-session appear from the next session.
- **Runtime protocol for every agent** `[v3.3.0]` — rules for instruction sources,
  secrets, workspace and git safety, and memory are added by the runtime, so agents
  with a custom prompt in their agent file get them too.
- **`/compact` rolling-window summarization** `[v1.5.0, v2.7.0]` — compresses old turns
  into a single summary message kept in context; UI shows the unabridged
  conversation. Preserves reasoning and loaded skill/tool context; skill
  Auto-compaction default threshold is raised to 90% of model context `[v2.7.0]`.
  instruction tool-call pairs remain active after repeated compaction while the
  summarizer keeps the same cacheable prompt prefix as normal chat turns.
  Changing the trigger in Settings → Sessions applies from the next model
  call, including inside a turn that is already running `[v3.3.0]`.
  Summaries in sessions with an active goal, @-mentioned context, or a
  session plan now reuse the turn's prompt cache too, so compaction there no
  longer re-reads the whole context `[v3.34.0]`.
  Opt-in **idle compaction** in Settings → Sessions → Idle sessions
  compacts a session in the background when it has been idle for 4½ minutes
  after a turn and its context has reached a set share of the trigger
  (default 70%). This uses the provider's prompt cache while it is still
  warm, so the next message starts from a short context. It sends no
  notification and skips subagent sessions `[v3.12.0]`. Sessions a scheduled
  task owns compact too, after its runs and after yours `[v3.24.0]`.
  It also runs after a turn that took longer than 30 minutes, which used to
  unload the session and drop the countdown as soon as it ended `[v3.24.0]`.
  After a server or app restart, a session whose turn ended less than 5
  minutes earlier resumes its countdown while the cache is still warm
  `[v3.24.0]`.
  Since `[v3.43.0]` a lead whose subagents are still running (or which still
  waits on another workspace's reply) compacts too once it has been idle that
  long; a report that arrives meanwhile runs right after the compaction.
  The summary under the "Session compacted" divider starts collapsed; click
  the divider to read it, including while it is still being written
  `[v3.13.0]`.
  Compaction no longer fails on a nearly full context: the summary's output
  budget (at most 16k tokens) shrinks to the room the context has left, and
  for models whose context size is unknown the provider picks it `[v3.19.0]`.
  Summaries are written as a handoff the agent can resume from: they quote
  your latest request word for word, keep the unfinished items of any task
  list or roadmap you gave or approved, name the immediate next action, leave
  out rules that stay in context anyway, and never copy secrets. The agent
  reads the summary marked as a summary of earlier context, not as a new
  message from you, so it carries on after compacting mid-turn `[v3.24.0]`.
  The latest request a summary quotes is always a message you wrote, never
  a Plan/Code mode note, a plan approval, a goal reminder, or another
  agent's message; with nothing new from you since the last summary, it keeps
  the request that summary recorded `[v3.31.1]`.
- **`AGENTS.md` at repo root and subfolders** `[v1.9.0]` — written by `/init`;
  standard repo- and folder-scoped agent context files.
- **Global `AGENTS.md`** `[v2.10.0]` — a developer-wide instructions file at
  `~/.agents/AGENTS.md` `[v3.17.0]` (before: `{config dir}/AGENTS.md`, now read only
  when the home file is missing) is injected into every turn ahead of the
  workspace's `AGENTS.md`, so cross-project
  preferences live in one place. Matches how pi, OpenCode, and Codex order
  global → project guidance.
- **`AGENTS.md` read once per session** `[v3.28.0]` — the global and workspace
  `AGENTS.md` are read at a session's first turn and kept for the rest of it, so
  editing them mid-session no longer throws away the provider prompt cache.
  Edits (and a newly created file) apply from the next session.
- **Host environment in the shell tool** `[v2.10.0]` — the shell tool schema
  states the OS, CPU architecture, and shell binary the command runs under
  (e.g. `Darwin arm64, shell=zsh`), so the model stops guessing platform
  commands. Static facts only, keeping the tool schema prompt-cache stable.
- **Truncation markers name the omitted amount** `[v2.10.0]` — shell output
  keeps half head / half tail and the marker now reads
  `...output truncated (N lines omitted)...`, so the model can judge whether
  the spilled full output is worth reading.
- **One backend-connection rulebook for desktop and mobile** `[v2.10.0]` —
  server URL normalization, the saved-servers file, keyring access keys, and
  download limits now come from one shared native crate. Mobile gains the
  desktop behaviours it lacked: a pasted `http://host:4082/api` connects
  instead of probing `/api/api/health/live`, and removing a server matches
  entries saved with a trailing slash or `/api`. Desktop gains mobile's
  fallback to the default "Local CLI server" entry when the list empties.
- **Workspace root injected into coding-mode system prompt** `[v1.133.0]` —
  coding agents are told their workspace's absolute
  path unconditionally, not only when an `AGENTS.md` happens to
  exist.
- **Per-message provider metadata** `[v1.17.0]` — assistant messages persist
  the model that generated each reply (visible in inspector).
