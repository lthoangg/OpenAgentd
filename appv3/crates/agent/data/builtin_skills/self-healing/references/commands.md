# Slash commands

A slash command is a Markdown prompt the user runs by typing `/<name>` in the
chat input. Use this to add or change one when the user asks ("make a /review
command for this project").

## Where they live

OpenAgentd reads commands from these roots, in order. The first file with a
given name wins:

1. `<workspace>/.agents/commands/<name>.md` — this project only
2. `<CONFIG_DIR>/commands/<name>.md` — global
3. `~/.agents/commands/<name>.md` — global, shared with other agents

The project root (1) is read only in project sessions. In Chat there is no
project scope, so write the command globally.

- "this project / repo" → project root. "everywhere / all projects" → `<CONFIG_DIR>/commands/`.
- In a project session with no hint, use the project root; ask one short
  question only if the user may want it in other projects too.
- For `~/.agents/commands`, resolve `$HOME` first (`printf '%s\n' "$HOME"`
  via `shell`); file tools refuse `~`.

## File format

```markdown
---
description: Review the staged diff for bugs and missing tests
---

Review the staged changes (`git diff --cached`). Focus on: $ARGUMENTS
```

- The file name (without `.md`) is the command name: lowercase kebab-case.
  One sub-folder level gives a namespaced name — `git/commit.md` shows in the
  `/` menu as `/git:commit`. Deeper files are ignored.
- `description` is shown in the `/` menu. Quote it if it contains `: `.
- `$ARGUMENTS` is replaced by the text typed after the command. Without it,
  that text is appended after a blank line.
- The body is sent as the user's message, so write it as an instruction to the agent.

## Names to avoid

`btw`, `compact`, `undo`, `redo`, `redo-all`, `new`, `stop` and `init` are
built into the chat input, and `memory` is a built-in command; a file with one
of these names is shadowed or shadows a built-in. Pick another name.

Before writing, check the roots above for a command with the same name. If one
exists, read it and ask before overwriting; a project command also hides a
global one of the same name.

## When changes take effect

Commands are read from disk each time the `/` menu opens or a command runs, so
a new or edited command works at once — no restart. Tell the user how to run
it (`/review <what to focus on>`).
