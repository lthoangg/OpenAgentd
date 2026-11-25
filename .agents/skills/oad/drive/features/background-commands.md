# Background commands

A `shell` command the agent starts with `background=true` keeps a log and
reports back when it ends. With `wait=true` the session waits for it: its
result starts the agent's next turn. Without, it only keeps running (a
server).

## Sub-features

- The line under the transcript: "Waiting for 1 command" while a waited
  command runs, "1 command running" when only servers are left, nothing when
  nothing runs.
- Its list (a popover on desktop, a sheet on a phone): each command by its
  description (else the command), its number and a clock, "keeps running"
  for one nothing waits for, and **Stop**.
- The end report in the transcript: the command, `exit N` coloured by
  outcome (or `stopped`, `timed out`), how long it ran, and the end of its
  output.
- A waited command's report starts a turn by itself. A server's end, or one
  the user stopped while the session is idle, adds the report without a turn.

## How to get to it (user POV)

- Ask the agent to run something long in the background. The line appears at
  the end of the transcript, under the last answer.
- Click or tap the line for the list; **Stop** is on each row.

## Driving it with Playwright

- `drive:shell {"command": "…", "background": true, "wait": true,
  "description": "…"}` makes the stub start one. Give it a description with
  `ctx.run`, so rows can be found by name.
- The line is a button named `Waiting for 1 command` or `1 command running`.
  The list is the dialog "Waiting for", or "Running commands" when only
  servers are left. A row's Stop is the button `Stop command <n>`.
- A report is `[data-command-report]` (the one place a journey needs an
  attribute: the report has no role of its own); its output is the `pre` in it.
- The stub answers a report by quoting it (`Stub reply (chat): [shell]:
  [Background command 2 failed: …`), which shows the agent came back.
- Cross-check: the history row with `extra.command_exit`, `GET
  /agent/sessions/<id>/waiting`, and the count of model requests since the
  command's prompt (three for start, result, report: none of them a poll).

## Gotchas

- The waited command sleeps 8 s so the list can be opened while it runs; a
  slow machine that takes longer than that to open the list fails the step.
- Escape closes the popover and the sheet alike.
- An instance with no sessions starts in Simple detail, and one with
  sessions in Full, so the first width of a fresh sandbox (the phone) sees a
  finished turn's work folded: the build's report and its "started · command
  2" row are behind the button `1 command, 1 report`. The journey opens the
  folds it finds; the report of a command no turn followed is never folded.
- The stub cannot show a model that polls: the request count proves the
  runtime needs no polling, not that a real model will not try.
