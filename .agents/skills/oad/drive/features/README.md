# Feature map

One file per user-facing feature that `oad/drive` can exercise. Each says what
the feature is for, how a user reaches it at each width, how its journey
drives it, and what has tripped a run up. Keep them at the user's point of
view; find code paths in the source when you need them.

| Feature | Journey | What a pass proves |
|---|---|---|
| [Send a message](message.md) | `message` | A new session in a folder opened through the UI; the reply streams in; the server stored the turn |
| [Model protocols](protocols.md) | `protocols` | Text and a tool call over Anthropic Messages and OpenAI Responses, picked the way a user picks a model |
| [Session sidebar](sidebar.md) | `sidebar` | Sessions are listed under their workspace, open on a click, and are found by search |
| [Review panel](review.md) | `review` | A file the agent changed shows in Git with its diff, and matches `git diff` on disk |
| [Terminal](terminal.md) | `terminal` | A command typed in the panel's terminal runs in the session's workspace |
| [Script tool row](script.md) | `script` | A `script` call's nested tool calls run; its row shows the code, the calls and the result, and is the same after a reload |
| [Settings](settings.md) | `settings` | Search lands on the setting it names; a changed setting applies and survives a reload |

Not mapped yet: plan mode and plan review, subagents, scheduled tasks, the
command palette, attachments, web preview, undo, the account and remote
computers, and everything native. Add a file and a journey when you change
one of them.
