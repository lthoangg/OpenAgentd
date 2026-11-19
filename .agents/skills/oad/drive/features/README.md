# Feature map

One file per user-facing feature that `oad/drive` can exercise. Each says what
the feature is for, how a user reaches it at each width, how its journey
drives it, and what has tripped a run up. Keep them at the user's point of
view; find code paths in the source when you need them.

| Feature | Journey | What a pass proves |
|---|---|---|
| [Send a message](message.md) | `message` | A new session in a folder opened through the UI; the reply streams in; the server stored the turn |
| [Model protocols](protocols.md) | `protocols` | Text and a tool call over Anthropic Messages and OpenAI Responses, picked the way a user picks a model |
| [Run picker](run-picker.md) | `run-picker` | A model, then its thinking level on its own page, picked with the keys on a desktop and taps on a phone; `/think` opens on the levels; the turn runs with the level |
| [Key and account cooldowns](cooldown.md) | `cooldown` | A rate-limited key hands the turn to the next one; the picker and Settings show it cooling, then ready again when the cooldown ends, with no reload |
| [Session sidebar](sidebar.md) | `sidebar` | Sessions are listed under their workspace, open on a click, and are found by search |
| [Worktree list](worktrees.md) | `worktrees` | A worktree removed outside the app drops off while its session stays; a plain-git one is listed as external |
| [Review panel](review.md) | `review` | A file the agent changed shows in Git with its diff, and matches `git diff` on disk |
| [Terminal](terminal.md) | `terminal` | A command typed in the panel's terminal runs in the session's workspace |
| [Script tool row](script.md) | `script` | A `script` call's nested tool calls run; its row shows the code, the calls and the result, and is the same after a reload |
| [Settings](settings.md) | `settings` | Search lands on the setting it names; a changed setting applies and survives a reload |
| [Seen on a screen](notify-seen.md) | `notify-seen` | A session on screen is reported seen when it opens and when its turn's notification arrives |
| [Connectors](connectors.md) | `connectors`, `connectors-remote` | Context7 turns on from the gallery and an agent calls it in a session; Connect opens Notion's sign-in, Cancel ends it; `oauth-done.html` refuses a stale code. From another device, Linear's sign-in returns through the callback page, which waits for Continue, to `oauth-done.html` and the server's token exchange |
| [Secrets](secrets.md) | `secrets` | The agent asks for keys on a card; a pasted value reaches only the store, a command uses it as `$NAME` with its output masked, and Settings → Secrets lists it |
| [Agent preview without the tab](preview.md) | `preview` | After the Preview tab closes and the app reloads on another session, the first session's agent still clicks and reads its page |
| [Plan review](plan-review.md) | `plan-review` | A comment on a submitted plan goes to the chat box with Reply in chat and is sent as a message with a Plan comments card the model reads; a resubmitted plan is approved with Keep going |
| [Failure, loading and confirm states](ui-states.md) | `ui-states` | A failed folder list and a failed session lookup say so with Retry; a TypeScript-tools line and a loading session title in Usage and a loading Read row; Usage stays closed after a relaunch; a group delete asks with Cancel; the QR scanner's focus and Escape; ✎'s hold opens an action sheet on a phone |

Not mapped yet: switching to Plan mode, subagents, scheduled tasks, the
command palette, attachments, web preview, undo, the account and remote
computers, and everything native. Add a file and a journey when you change
one of them.
