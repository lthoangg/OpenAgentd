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

A repository with a `plugin.json` at its root is a plugin: install it with
`agentd plugin add` (see `plugins.md`), which brings its skills too, instead of
saving its servers here.

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
{"url": "https://example.com/mcp", "headers": {}}
```

- `transport` (or `type`) is `stdio`, `http` (Streamable HTTP; `streamable-http`
  is the same) or `sse` (the legacy HTTP+SSE transport).
- **stdio**: `command` (required), `args`, `env`, `enabled` (default `true`), `timeout`.
- **http** and **sse**: `url` (required), `headers`, `oauth`, `enabled`,
  `timeout`. An entry with only `url` is http. An `http` server that refuses
  Streamable HTTP falls back to HTTP+SSE on its own.
- Unknown keys are rejected.
- To change an entry, start from its config in `servers` and send the
  `********` values back unchanged: they keep what is stored.

## Secrets and sign-in

Never ask the user to paste a token into the chat, and never put one in
`config`. Save the entry without it, then tell the user where to enter it:

- A token in `env` or `headers` → Settings → MCP → the server → edit. A
  `${NAME}` reference (for example `"Authorization": "Bearer ${GITHUB_TOKEN}"`)
  reads a variable or a named secret instead.
- OAuth needs nothing in `config`: an http or sse server that asks for sign-in
  goes to `auth_required`, and the user clicks **Sign in** in Settings → MCP
  (OpenAgentd registers itself with the server). Its tools appear once they
  have. Add `"oauth": {"client_id": …, "client_secret": …}` only when the
  server's provider requires an app the user registered. A server with an
  `Authorization` header uses that header instead.

If a server fails to start, `servers` shows the error; fix the entry with `save`.
