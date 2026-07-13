---
title: Shell commands from chat
description: Run opencode-style `!command` shell commands from the OpenAgentd composer or API without asking the model to decide on a tool call.
status: stable
updated: 2026-07-13
---

# Shell commands from chat

Start a message with `!` to run the rest of the message as a shell command:

```text
!git status --short
!pwd
!pytest -q
```

OpenAgentd dispatches the command directly through the built-in shell tool. The
current turn does **not** call the model first and does not ask the agent whether
to run a tool.

In the web/desktop composer, typing `!` as the first character switches the input
into shell mode: the `!` disappears and the placeholder changes to `Enter shell
command...`. This also works from the desktop compact strip's type-to-focus path:
pressing `!` expands the composer directly into shell mode. Desktop and mobile
shells also expose a terminal button in the expanded composer for entering shell
mode without typing `!`. While shell mode is active, attach/voice controls are
replaced by the active Shell button. Press Backspace on an empty shell command,
or Escape, to return to normal chat mode.

Inserting a `#`-snippet (coding workspaces only, see
[Chat Input & Message Queue](./web/chat-input.md#shell-mode)) into an empty
composer also enters shell mode when the snippet's rendered body itself starts
with `!` — the leading `!` is stripped the same way it is when typed directly,
so a snippet authored as a shell command (e.g. `.openagentd/snippets/migration.md`
containing `!make revision MSG="…"`) runs as a shell command instead of being
sent as a literal chat message starting with `!`.

**Pasting** also enters shell mode: pasting clipboard text that starts with `!`
so that it replaces the *entire* current draft — an empty composer, or
existing text fully selected — strips the leading `!` and switches to shell
mode with the rest of the pasted text as the initial command. This covers both
a direct paste into the textarea and the desktop floating composer's
paste-while-minimized path (`⌘V`/`Ctrl+V` while the bar is collapsed, which
expands the bar and forwards the clipboard text). Pasting `!` mid-sentence, or
over a partial selection, inserts it as plain text — only a paste that
replaces the whole draft is treated as a shell-command shortcut.

## What is saved in history

Shell sends are stored as normal shell-tool history so the UI, replay, and future
model context stay structured:

1. visible user row: `!<command>`
2. assistant shell tool call with the command arguments
3. shell tool result

The visible user row is styled as a shell command (Shell label, terminal icon,
monospace command text) both optimistically right after send and after history
reload.

Future model turns see an opencode-style synthetic user marker — `The following
tool was executed by the user` — followed by the shell tool call/result. This
keeps command output as tool output rather than user-authored text, while the UI
continues to show the original `!command`.

## Attachments and undo

`!command` sends cannot include file uploads. Use a normal prompt when you need
to attach files.

In coding sessions, a `!command` is a normal visible user turn for `/undo` and
`/redo`: undo can target the `!command` row and restore the associated workspace
snapshot just like any other user turn.

## Stop and background processes

Pressing **Stop** terminates a running `!command` plus foreground and
background shell process groups owned by the active session. Background
processes from other sessions are left running. Outside an active session Stop,
use `bg` with `action="stop"` to terminate a specific process by PID.

## API

POST to `/api/team/chat` with form data:

| Field | Value |
|-------|-------|
| `message` | `!git status --short` or `git status --short` |
| `shell` | `true` |
| `session_id` | optional existing session UUID |
| `mode`, `workspace` | optional; required for coding mode as usual |

The endpoint returns `202 Accepted` with the `session_id`. Subscribe to
`GET /api/team/{session_id}/stream` for `tool_start`, `tool_output_delta`,
`tool_end`, and `done` events.

## Manual smoke test

```bash
uv run python -m manual.bang_shell
uv run python -m manual.bang_shell --command "pwd && echo oad-bang-shell-ok"
```
