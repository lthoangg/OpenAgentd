# Plugins

A plugin is a **folder** that adds skills, MCP servers and tools. Older
**single-file** plugins (one `.ts`/`.js` file) still work for providers and
tool hooks. Both live in `<CONFIG_DIR>/plugins/` (unless
`OPENAGENTD_PLUGINS_DIRS` overrides it; Settings → Plugins shows the active
directories).

## Plugin folders

```text
<CONFIG_DIR>/plugins/changelog-tools/
  plugin.json                  # manifest: $schema and name are required
  skills/release-notes/SKILL.md
  mcp.json                     # MCP servers: stdio or streamable-http
  dev.openagentd/plugin.ts     # optional code: tools, hooks, a provider
```

- The format is the open Agent Plugins layout, so a folder written for it works
  here, and the `skills/` and `mcp.json` parts of a folder written here work in
  other clients.
- Names: skills are `<plugin>/<skill>`, MCP servers `<plugin>/<server>`.
  `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in an MCP server's `args`, `env` and
  `cwd` become the plugin folder and its data folder (kept across updates).
- Folders reload on their own when a file changes; there is no restart. New
  skills reach **new sessions**; MCP servers and tools are usable at once.
- Plugin tools are not in the tool list. Agents reach them through the `mcp`
  tool with the plugin's name as the server: `action: "search"` finds them and
  returns their schemas, `action: "call"` runs one. In Plan mode only tools
  marked `readOnly` run. An MCP server in the user's `mcp.json` with the
  plugin's name hides its tools; pick plugin names that do not clash.
- Plugin MCP servers are managed by their plugin: the `mcp` tool cannot change
  or remove them, and they go on and off with the plugin.

### Manifest and permissions

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "changelog-tools",
  "version": "1.2.0",
  "description": "Draft release notes from merged PRs",
  "extensions": {
    "dev.openagentd": {
      "permissions": { "net": ["api.github.com"], "env": ["GITHUB_TOKEN"] }
    }
  }
}
```

The code in `dev.openagentd/` is sandboxed: without permissions it reads its
own folder, reads and writes its data folder, and nothing else. Grant only what
it needs: `net` (hosts, or `true`), `listen`, `fs` (absolute folders),
`subprocess` (program names), `env` (variable names). A call outside them
throws an error naming the permission to add. MCP servers are **not**
sandboxed: they run with the user's permissions, like any program.

### Code: tools, hooks, a provider

```ts
import { defineTool, env, fetch, type Plugin } from "openagentd"

export default {
  tools: [
    defineTool({
      name: "draft_release_notes",           // mcp call: server changelog-tools, tool draft_release_notes
      description: "Draft release notes from PRs merged since a tag",
      readOnly: true,                        // allowed in Plan mode
      input: {
        type: "object",
        properties: { since: { type: "string", description: "Tag to start from, e.g. v1.2.0" } },
        required: ["since"],
      },
      async run({ since }) {
        const r = await fetch("https://api.github.com/…", { headers: { authorization: `Bearer ${env.get("GITHUB_TOKEN")}` } })
        return `notes since ${since}: ${r.status}`
      },
    }),
  ],
  // hooks: { "tool.before"(input, out) {}, "tool.after"(input, out) {} },
  // provider: { id, label, description, kind, build(ctx) { … } },
} satisfies Plugin
```

Give every input property a `description`. Before writing code, read
`openagentd.d.ts` in this references directory: it types the whole API and the
permission rules.

### Installing, checking, removing

Use the `agentd plugin` command from `shell`:

1. `agentd plugin check <folder>` validates a folder without installing it and
   prints what it adds.
2. `agentd plugin add <git-url or folder>` (git URLs: `https://`, `ssh://`,
   `user@host:path`, `file://`; `--path <subfolder>` when the plugin is not at
   the root). From `shell` it only prints the summary and exits with status 2.
   **Show that summary to the user** — skills, the exact command or URL of each
   MCP server, the permissions, the tools — and ask before installing, even
   when they asked for the install: MCP servers run unsandboxed. Then run it
   again with `--yes`.
3. `agentd plugin list` shows each plugin and its state;
   `agentd plugin remove <name>` deletes the folder and keeps its data.

In the desktop app `agentd` lives inside the app, and `shell` adds its folder
to the end of `PATH`. The user's own terminal does not have it: for them, give
the full path that `command -v agentd` prints. From `shell` the CLI may not
reach the app's server (it listens on a port of its own), so `add` and
`remove` report that no server answered; the server still sees the folder
change and reloads by itself.

To write a plugin, create the folder with `patch`, run `agentd plugin check`
on it, and fix what it reports. Settings → Plugins turns a plugin on or off,
reloads the folders, and shows each plugin's contents and errors.

## Single-file plugins

Trusted `*.ts`/`*.js` files in the plugin folder, **not sandboxed** (`fs` and
`subprocess` reach the whole machine), loaded once per process: **restart
OpenAgentd** after adding or changing one. Skipped: `.*`, `*.d.ts`, `*.py` (v2
plugins, listed as unported) and `_*` files, which are helper modules other
plugins can import (`import { x } from "./_util.ts"`). Runtime: QuickJS
(ES2023), no Node.js or npm; TypeScript is stripped, not type-checked.

**Tool hooks** — `export async function plugin()` returning hooks that wrap
every tool call:

```ts
import type { ToolHooks } from "openagentd";

export async function plugin(): Promise<ToolHooks> {
  return {
    "tool.after": async (input, out) => {
      if (input.tool === "shell") out.output = out.output.replace(/ghp_[A-Za-z0-9]{36}/g, "[redacted]");
    },
  };
}
```

- `tool.before(input, { args })` — mutate `args`; throwing aborts the call and
  the error becomes the tool result.
- `tool.after(input, { output })` — replace `output` to change what the model sees.
- `applies_to(agentName, role)` — limit to some agents (`role` is always `"agent"`).
- Files run in name order; the first file is the outermost wrapper.

**Provider** — `export const provider = definePlugin({...})` adds an LLM
provider. Required: `id`, `label`, `description`, `kind` (`"api_key"` or
`"oauth"`; `oauth` also needs `login`), and `build(ctx)`, which returns either
`{ base: "anthropic", options: {...} }` to reuse the built-in Anthropic client,
or `{ base: "http", request, streamParser, parseResponse }` for a custom
protocol. Declare `credentials` fields so the user can fill them in Settings →
Providers. Models are then addressed as `<id>:<model>`. A file that exports
`provider` is only a provider plugin.

By default a provider plugin has one credential. Set
`supportsMultipleCredentials: true` to let users add several accounts or keys
that rotate like the built-in providers; `build(ctx)` then gets
`ctx.credentialId`. An OAuth plugin's `login(emit, ctx)` and
`oauthCallback(code, emit, ctx)` receive `ctx.credentials`: `readOAuth()`
(document or `null`), `writeOAuth(doc, { expected?, label? })` (compare-and-swap;
`false` means a refresh raced it, it throws if the account was deleted) and
`removeOAuth(expected?)`. Tokens then live in `credentials.yaml`, not files;
`tokenPath`/`readJson`/`writeJson` are per-account (plain names only), and
old token files are not migrated.

To install one from a URL, fetch the raw file and **review it with the user**
(what it hooks, what it sends over the network, which commands it runs), write
it to `<CONFIG_DIR>/plugins/<name>.ts`, and tell the user to restart. After the
restart, Settings → Plugins shows it as loaded or with its error
(`path:line:col`); a broken file is skipped, not fatal. To remove one, delete
its file (or rename it to start with `_`), then restart.
