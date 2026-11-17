# Plan review

The agent submits a plan with the `plan` tool (`submit: true`) and the turn
waits for the user. The user approves it in the Plan tab, or comments on it
and replies in the chat.

## Sub-features

- The Plan tab shows the plan with a review footer: comments, **Reply in
  chat** and **Approve**. There is no feedback box.
- Selecting plan text offers **Comment on selection**; the comment is listed
  in the footer and Approve waits until it is sent or removed.
- **Reply in chat (N)** moves the comments into the chat box as one
  "Plan comments" chip and focuses the box. A phone closes the plan sheet.
- Sending it is a normal message: the bubble shows the typed text and a
  **Plan comments** card; the server stores a `<plan-comments>` block; the
  review closes as superseded and the model reads the block.
- **Approve and keep going (N turns)** starts a goal from the plan's Done
  when with that many turns.

## How to get to it (user POV)

- Ask for a plan (Plan mode). Desktop: the Plan tab opens in the Review panel
  by itself. Phone: tap **View** on the "Needs you · a plan to review" bar
  over the chat box.

## Driving it with Playwright

- `drive:plan {"action": "write", "content": "…", "submit": true}` makes the
  stub call `plan` with those arguments (one line of JSON; `\n` in the
  content).
- Comment with `locator.selectText()` on a plan line, then the **Comment on
  selection** button and the **Comment** field.
- The phone's Keep going is a toggle button (`aria-pressed`); the desktop's
  is a checkbox. Both show the **Turns for this goal** field once on.
- Cross-checks: the stored user message (`/agent/<id>/history`), the last
  model request (`modelRequests()`), and `/agent/sessions/<id>/goal`.

## Gotchas

- The pinned bar's text "Needs you · a plan to review" also shows on the
  transcript card; take the first match.
