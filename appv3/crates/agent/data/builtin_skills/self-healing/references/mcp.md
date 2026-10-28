# MCP servers

MCP servers are global: the lead agent has one `mcp` tool for all of them.
`action='search'` finds a server's tools and returns their input schemas;
`action='call'` runs one by `server`, `tool` and `arguments`. In Plan mode only
tools the server marks `readOnlyHint: true` can be called. Members get no MCP
tools. Don't add `mcp:` (legacy, ignored) or MCP tool names to an agent's `tools:`.

## See what is configured

`mcp(action='servers')` lists every server with its state (`ready`,
`starting`, `error`, `auth_required`, disabled), its error, its tools, and its
config. Secrets show as `********`. It works in Plan mode too. Use it instead
of reading `mcp.json` or calling the API.

## Add, change or remove a server

Use the `mcp` tool. Don't edit `mcp.json` by hand: a hand edit needs a
restart, and the tool's change starts the server at once.

- `mcp(action='save', server='<name>', config={…})` adds a server or replaces
  its entry. Names match `^[a-zA-Z][a-zA-Z0-9_-]*$`.
- `mcp(action='remove', server='<name>')` deletes one.
- To disable or enable, `save` the same entry with `"enabled": false` / `true`.

The call does not apply the change: it shows the user a card with what will run
or connect, and pauses until they choose **Apply** or **Cancel**. The result
says what happened, and the server's state. Don't call it again unless they ask.
In a scheduled or goal turn nobody is there to confirm, so it is refused.

`config` is one `mcp.json` entry:

```json
{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/absolute/path"], "env": {}}
{"url": "https://example.com/mcp", "headers": {}, "oauth": {}}
```

- **stdio**: `command` (required), `args`, `env`, `enabled` (default `true`), `timeout`.
- **http**: `url` (required), `headers`, `oauth`, `enabled`, `timeout`. An entry
  with only `url` is http.
- Unknown keys are rejected.
- To change an entry, start from its config in `servers` and send the
  `********` values back unchanged: they keep what is stored.

## Secrets and sign-in

Never ask the user to paste a token into the chat, and never put one in
`config`. Save the entry without it, then tell the user where to enter it:

- A token in `env` or `headers` → Settings → MCP → the server → edit. A
  `${NAME}` reference (for example `"Authorization": "Bearer ${GITHUB_TOKEN}"`)
  reads a variable or a named secret instead.
- OAuth (`"oauth": {}` on an http server) → the state is `auth_required`; the
  user clicks **Connect** in Settings → MCP. Its tools appear once they have.

If a server fails to start, `servers` shows the error; fix the entry with `save`.
