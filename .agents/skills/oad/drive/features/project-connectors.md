# Project connectors

MCP servers a repository ships in `<project>/.agents/mcp.json`, approved once per server by the user.

## Sub-features

- The composer's "+" menu lists the project's servers with a "from this project" chip: **Needs approval · Allow**, then **Revoke**.
- Allow starts the server for that workspace only; the agent reaches it by its plain name through `mcp`.
- A changed entry needs approval again; deleting the file stops its servers.
- Settings → Connectors lists the open workspace's project servers with the same chip; their detail page is read-only with Allow/Revoke.
- When the agent searches or calls an unapproved one, a confirm card asks (covered by `appv3/crates/mcp/tests/project_servers.rs`, not this journey).

## How to get to it (user POV)

- **Desktop:** the "+" in the message box → Connectors section. Settings → Connectors.
- **Phone:** the "+" → Connectors (a page of its own in the sheet).

## Driving it with Playwright

- The journey writes `<demo>/.agents/mcp.json` in the demo repository, with a tiny python stdio server kept outside the repository, and removes both at the end.
- Region "Connectors"; the row is a list item named after the server, holding "from this project", the status chip and Allow/Revoke.
- `GET /api/mcp/servers?workspace=<demo>` lists project servers with `project` set; the state reads `needs_approval` before Allow.

## Gotchas

- The server name carries `run`, so each width approves its own server.
- `python3` must be on the PATH of the shell that runs the journey; the backend gets its absolute path.
- The app names the workspace by its real path (`/private/tmp/…` on macOS), so API cross-checks use `realpathSync(demo)`: approvals belong to that path.
- While a project connector waits for approval, "+" carries the attention dot and the phone sheet opens straight on its Connectors page.
