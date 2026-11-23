# Terminal

A shell in the session's workspace, inside the Review panel.

## Sub-features

- Opening a terminal tab.
- Typing a command and reading its output.
- On desktop: focus. A new terminal opened from the palette while the chat
  has focus takes the keys at once (no click into it). Typing in the chat
  while the shell exits and reconnects keeps the keys in the chat.
- On a phone: the key bar under the terminal, in two layouts (keyboard down:
  Show keyboard, Esc, Tab, ^C, ↑, ↓, Enter, More; keyboard up: Line, Esc,
  Tab, Ctrl, ^C, the arrows, More).
- On a phone: the gestures on the terminal (drag scrolls, hold then drag
  sends arrows, double tap sends Tab, pinch sizes the text, long press opens
  the four-row menu).

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
- Gestures go through CDP `Input.dispatchTouchEvent` (the journey's
  `fingers` helper): each frame is the touch points at that moment, then a
  pause. Coordinates come from `.xterm-screen`'s box.
- The soft keyboard is the visible viewport shrinking: the journey focuses
  the terminal and calls `page.setViewportSize` 300px shorter, which is what
  `useMobileViewportGuards` reads as the keyboard coming up.

## Gotchas

- Headless Chromium does not paint xterm's WebGL canvas. The harness turns
  WebGL off so xterm uses its DOM renderer; a WebGL-only fault would not show.
- The workspace's shell outlives a run, with its history and its prompt
  line: a step that needs one arrow up runs its own command first and
  drags only past the tolerance, lifting before the slowest repeat.
- Wait for a closing sheet to leave before the next touch on the terminal:
  its scrim takes the touch while it slides away.
- The command line field is not driven.
- Open Terminal from the palette, not the launcher, to test focus: Chromium
  focuses a clicked button, but macOS WebKit does not, so there the chat
  keeps focus. The palette hands focus back to the chat as it closes, which
  is the macOS case. The step then closes its terminal and the panel, or the
  launcher step after it does not settle.
