# Terminal

A shell in the session's workspace, inside the Review panel.

## Sub-features

- Opening a terminal tab.
- Typing a command and reading its output.
- On a phone: the key bar under the terminal (Esc, Ctrl, arrows, …).

## How to get to it (user POV)

- Review panel → Terminal, at both widths.
- The terminal starts in the workspace folder of the session.

## Driving it with Playwright

- `ctx.openInReviewPanel("Terminal", (p) => p.getByRole("textbox", { name: "Terminal input" }))`.
- Focus the textbox, then `page.keyboard.type(…)` and `press("Enter")`.
- Output is the text of `.xterm-rows` (the one place a class is used: xterm
  draws its rows without roles).
- The command prints a value the shell computes (`drive-$((40+2))`), so the
  echoed command line cannot pass the check, and it creates a file the
  journey then finds on disk.

## Gotchas

- Headless Chromium does not paint xterm's WebGL canvas. The harness turns
  WebGL off so xterm uses its DOM renderer; a WebGL-only fault would not show.
- The phone key bar and the command line field are not driven.
