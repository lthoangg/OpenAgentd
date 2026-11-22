# Site access for the agent

The agent's `preview` tool can open pages of the public web, which the
desktop app shows in a browser view of its own where the user may be signed
in. The agent uses a site only after the user allows it.

## Sub-features

- The first use of a site opens a card: **Allow once**, **Always allow**,
  **Decline**.
- Decline holds for the chat: the next call is refused without a card.
- Always allow saves the site; Settings → Browser lists and removes it.
- A client that cannot show a site (a browser, a phone) says where sites
  open, in the Preview tab.

## How to get to it (user POV)

- Ask the agent to open or use a site. The card appears over the message
  box; pick an answer and press **Send**.
- Settings → Browser (search "allowed sites").

## Driving it with Playwright

- `drive:preview {"action": "open", "url": "https://<host>/"}` makes the stub
  call `preview` on a site. The server never fetches the page, so any host
  works and no network is used.
- The card is the radio group that holds "Always allow"; **Send** answers.
- The tool result the model got is the last `tool` message of the last
  request in `ctx.modelRequests()`.
- The rules are `GET /api/browser/sites`.

## Gotchas

- The journey runs in a browser, which has no native view: it proves the
  card, the rules and the notice, not the page itself. Check a real site in
  the desktop dev build (`oad/testing` → `references/native.md`).
- Each run uses hosts named after `ctx.run`, so a site an earlier run saved
  cannot satisfy a check.
- On a phone the Preview sheet opens only from the tool row, so the notice
  is checked at the desktop width.
