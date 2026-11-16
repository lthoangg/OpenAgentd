# Review panel

See what the agent changed: the files it touched and each file's diff.

## Sub-features

- The agent's tool call in the transcript (a `shell` row).
- The Review panel and its Git view: Changes, with a count, and History.
- A file's diff, expanded in place.

## How to get to it (user POV)

- "Review panel" in the header opens the panel: docked on the right on
  desktop, a full screen with "Back to Chat" on a phone.
- An empty panel shows a launcher (Git, Terminal, Preview, …). With a tool
  already open, "Open in Review panel" lists the others: a menu on desktop, a
  sheet on a phone.
- In Git, "Expand diff for <file>" shows the diff.

## Driving it with Playwright

- `ctx.openInReviewPanel("Git", (p) => p.getByRole("tablist", { name: "Git view" }))`
  handles the three panel states and returns the panel.
- The changed files are the list "Changed files".
- The prompt `drive:shell printf '…' > greeting.ts` makes the change.
- Cross-check: `git -C <demo> diff -- greeting.ts`.

## Gotchas

- The Git button's name differs by width and state: "Git (⌘⇧G)" on desktop,
  "Git 3" on a phone with three changed files.
- A terminal opened in the workspace is remembered by the server, so a new
  session's panel can open on "Terminal 1" instead of the launcher.
- `code/demo` keeps earlier runs' changes until the next `up`; the journey
  checks the line it wrote, tagged with `ctx.run`.
