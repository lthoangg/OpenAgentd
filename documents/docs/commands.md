---
title: Slash commands
description: Reusable prompt templates triggered with `/name` in the chat input. Compatible with opencode's command format.
status: stable
updated: 2026-05-26
---

# Slash commands

Slash commands are short, named prompt templates. Type `/` in the chat
input to open the picker, choose one, append any arguments, and submit —
the rendered body is sent as your user message.

The format is intentionally the same as
[opencode's commands](https://opencode.ai), so a library you've built
for one tool works in the other without duplication.

## File format

Each command is a `.md` file with optional YAML frontmatter:

```markdown
---
description: Make a commit with a conventional message.
---

Run `git status --porcelain`. Stage everything if nothing is staged.
Produce a conventional commit message describing: $ARGUMENTS
```

- `description` (optional) — shown in the picker.
- `$ARGUMENTS` (optional) — replaced with whatever the user typed after
  the command name. If absent and arguments are supplied, they are
  appended to the body on a new line.

The filename (minus `.md`) becomes the command id. One nested folder level is
supported: `commands/git/commit.md` registers as `git/commit`. Deeper files
such as `commands/a/b/c.md` are ignored. In the chat picker, nested commands are
shown and inserted with colon syntax (`/git:commit`) while the API/storage name
remains `git/commit`.

## Where commands live

Discovery walks four roots in this order — first match wins on a name
collision:

| # | Root | Source label | Use it for |
|---|------|--------------|------------|
| 1 | `{workspace}/.openagentd/commands/` | `project-openagentd` | Project-specific, OpenAgentd-native |
| 2 | `{workspace}/.opencode/commands/`   | `project-opencode`   | Reuse an opencode project library |
| 3 | `{OPENAGENTD_CONFIG_DIR}/commands/` | `global-openagentd` | Your personal library |
| 4 | `~/.config/opencode/commands/` | `global-opencode`   | Reuse your global opencode library |

`{workspace}` is the selected coding workspace. Local command roots are
loaded only in coding mode, so a `/run` template in Project A does not
appear while coding in Project B or while using the regular cockpit chat.
Cockpit chat lists only global commands.

## Picker behaviour

Slash commands live in the composer picker only; the command palette does not list custom slash commands.

- **Built-in commands** (`/stop`, `/continue`, `/compact`, `/undo`, `/redo`, `/new`) execute immediately on pick.
  `/continue` resumes the last assistant response; `/compact` runs the session summarizer; `/undo` reverts the latest user turn, restores its workspace snapshot, and puts the text back in the composer; `/redo` restores all undone turns sequentially, replaying the workspace forward to the live tip.
- **Built-in prompt commands** (`/init`, `/loop <prompt>`, `/loop:{subcommand}`) are handled by
  OpenAgentd. `/init` renders through the backend command endpoint. `/loop:*`
  is coding-mode only and controls a Ralph Wiggum loop for the current session.
  Use `/loop:set 5|10|20|50` to set the loop budget, `/loop <prompt>` to
  start, then `/loop:pause`, `/loop:resume`, or `/loop:stop` to control it.
  The control forms are transport commands, not chat turns; only `<prompt>`
  from `/loop <prompt>` is saved as the user message. While a loop is ready
  or active, the chat header shows a compact status chip with progress and
  pause/resume/stop controls.
- **Discovered commands** insert `/<name> ` into the textarea so you
  can type arguments before submitting. For nested commands, the picker uses
  colon syntax: `git/commit` is displayed and inserted as `/git:commit`.

When you submit a message starting with `/`, the backend renders the
template and sends the expanded body to the agent. The picker closes
once you type a space, so the menu does not get in the way while you
write arguments.

Shell commands use a separate opencode-style shortcut: start a message with
`!` to run the rest directly through the shell tool instead of sending a prompt.
See [`shell-commands.md`](./shell-commands.md).

## API

| Method & path | Purpose |
|---------------|---------|
| `GET /api/commands` | List discovered commands with `name`, `description`, `source`. Sorted alphabetically. |
| `POST /api/commands/{name}/render` | Body `{"arguments": "..."}` returns `{"name": ..., "content": <rendered body>}`. Nested names (`git/commit`) are allowed in the path. |

## Example

`~/.config/openagentd/commands/git/commit.md`:

```markdown
---
description: Stage, analyse the diff, and write a conventional commit.
---

Run `git status --porcelain`. If no files are staged, run `git add .`.
Then `git diff --cached`, summarise the changes, and produce a
conventional-commits message describing: $ARGUMENTS
```

Then in chat:

```
/git:commit fix off-by-one in cursor decoder
```

The agent receives the full rendered prompt, not the `/git:commit …`
line.

Ralph Wiggum loop example:

```text
/loop:set 20
/loop Run uv run pytest tests/api/routes/test_commands.py -q. If it fails, make the smallest fix and rerun the same command.
```

OpenAgentd sends the exact configured prompt as a user message. Each time the
team becomes idle, the backend injects the same prompt again in the same session
until the configured budget is exhausted or you send `/loop:pause` or
`/loop:stop`.

You can still steer mid-loop with an ordinary message. If the team is already
working, the normal queued-message path runs first; after that turn completes,
the loop continues with its configured prompt unless paused or stopped.
