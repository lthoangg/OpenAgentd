# Agent preview without the Browser tab

The agent's `browser` tool (`preview` before v3.62.0) opens a page and then drives it (snapshot, click,
fill). The page runs in an app window: the Browser tab, or a hidden copy the
app keeps loaded while no tab shows it.

## Sub-features

- The page opens in the Browser tab when the agent opens it (desktop).
- After the tab closes, the agent still clicks and reads the page.
- The same while another session is on screen, or after the app reloads: the
  server lists the agent's pages (`agent_page` in `GET /api/preview`), so any
  window loads them, not only the one showing the session that opened them.
- On a phone no hidden copy is kept; the agent gets a message saying the page
  did not connect, not one telling it to open the page again.

## How to get to it (user POV)

- Ask the agent to open a local page or a workspace HTML file. The Preview
  tab opens in the Review panel. Close it with the tab's close button and
  keep working; the agent still uses the page.

## Driving it with Playwright

- `drive:browser {"action": "open", "path": "<file>"}` makes the stub call
  `browser` with those arguments. `drive:script` runs page actions in one
  call (`tools.browser({ action: "snapshot" })`).
- The Browser tab's page is the iframe titled `Browser page of <file>`; its close
  button is `Close Browser <file>`.
- The background agent turn is started through `POST /agent/chat` with the
  first session's id: the user is on another session, so nothing on screen
  can start it. Its result is read from `/agent/<session>/tool-results/<id>`.

## Gotchas

- On a phone the tool row does not open the Browser sheet by itself, and the
  app keeps no hidden copy, so the phone run checks the agent's message
  instead of a click.
- The hidden copy starts 1.5 s after the server lists the page; the script's
  first page action waits up to 8 s for it.
- The phone run's step 4 is timing-dependent (failed 2 of 5 runs on
  2026-11-23): when the phone's page polled less than `STALE_AFTER` (10 s)
  before the reload, the server still counts it connected and the agent gets
  "did not pick up the command … call browser with action 'open'" instead of
  "did not connect". The page is gone either way; only the wording differs.
