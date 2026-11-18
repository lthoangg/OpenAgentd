# Connectors

Turn on ready-made connectors from the gallery, and sign in to account ones from any device.

## Sub-features

- Settings → Connectors: "Your connectors" first (each with its logo or monogram, status, switch, and Connect when it needs sign-in), then the gallery "Add a connector" of ones not added yet: free (switch), account (Connect → sign-in) and key (Set up) tiles, with category filters. One search box filters both.
- Gallery connectors show the service's logo (an SVG path in the signed list, `icon`); `GET /api/mcp/servers` names each connector's gallery entry (`gallery: {id, name, icon}`), so the list and the "+" menu show it too.
- Sign-in driven by the client: the server hands back the service's page, and the code returns to localhost (a browser on the server's machine) or through the relay page (`account.openagentd.dev/oauth/callback`) to `oauth-done.html` or `openagentd://mcp-oauth`.
- `oauth-done.html`: finishes a relayed sign-in with this browser's access key.

## How to get to it (user POV)

- **Desktop:** Settings in the status bar → Connectors.
- **Phone:** Settings in the Sessions toolbar → Connectors.

## Driving it with Playwright

- Dialog "Settings", button "Connectors", regions "Your connectors" and "Add a connector", one searchbox.
- A gallery tile is a list item in "Add a connector" holding the name: free ones have the switch "Turn on <name>", account ones "Connect", key ones "Set up". An added connector leaves the gallery.
- A row in "Your connectors" is a list item named after the connector (the service's name for a gallery one); its switch is "Turn off <name>" / "Turn on <name>", and "Connect" shows while it needs sign-in.
- Context7 needs the internet; a turned-on one shows "Ready · N tools", and `GET /api/mcp/servers` lists it as ready.
- An agent reaches it through `drive:script` calling `tools.mcp({action: "call", server: "context7", …})`.
- Connect opens a popup to the service's page; the connector's row in "Your connectors" shows "Waiting for sign-in in your browser…" with Cancel and Paste address.

## Gotchas

- The drive's browser and backend share a machine, so `connectors` signs in through localhost. `connectors-remote` takes the other-device path: it adds `X-Forwarded-For` to every API request, so the server picks the relay page.
  - With no setting it uses the published page, `https://account.openagentd.dev/oauth/callback`. To try a changed page first, start the backend with `DRIVE_SERVER_ENV="OPENAGENTD_MCP_OAUTH_CALLBACK=<url>" drive.sh up`: the staging page (`https://staging-account.openagentd.dev/oauth/callback`), or a local copy of `account-pages/oauth/callback.html` served at `/oauth/callback`.
  - The journey stands in for Linear with a made-up code, so it ends at Linear's token endpoint refusing it (`invalid_grant`). A real approval needs a Linear login.
  - Linear advertises RFC 9207: the return must carry `iss`, or the server refuses it. A stand-in redirect has to include it too.
- The gallery reads `account.openagentd.dev/connectors/v1.json` (`source: cloud` in `GET /api/mcp/gallery`) and falls back to the copy in the app when that cannot be fetched or its signature fails.
- A real sign-in waits on a person, up to 10 minutes, inside the server's `initialize` request; the journeys' instant made-up codes cannot show that. Checked by hand (Notion, from a phone, 2026-11-17).
- From a phone, a sign-in the server started as local (loopback) ends on `localhost:<port>/callback`, which the phone cannot open; the address it shows can be pasted into "Paste address".
- Both widths share one backend: the second finds Context7, Notion and Linear already added (no longer in the gallery), so the journeys delete them through the API first.
