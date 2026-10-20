# Plugins

Plugins are trusted TypeScript/JavaScript files that run inside OpenAgentd.
They are **not sandboxed** — `fs` and `subprocess` reach the whole machine — so
treat a plugin like installing software.

## Where they live

- `<CONFIG_DIR>/plugins/` (unless `OPENAGENTD_PLUGINS_DIRS` overrides it;
  Settings → Plugins shows the active directories).
- Loaded: `*.ts` and `*.js`. Skipped: `.*`, `*.d.ts`, `*.py` (v2 plugins —
  Settings → Plugins lists them as unported), and `_*` files, which are helper
  modules other plugins can import (`import { x } from "./_util.ts"`).
- Runtime: QuickJS (ES2023). No Node.js or npm — use the `openagentd` module.
  TypeScript is stripped, not type-checked.

## Two kinds — decided by the exports

**Tool plugin** — `export async function plugin()` returning hooks that wrap
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

**Provider plugin** — `export const provider = definePlugin({...})` adds an
LLM provider. Required: `id`, `label`, `description`, `kind` (`"api_key"` or
`"oauth"`; `oauth` also needs `login`), and `build(ctx)`, which returns either
`{ base: "anthropic", options: {...} }` to reuse the built-in Anthropic client,
or `{ base: "http", request, streamParser, parseResponse }` for a custom
protocol. Declare `credentials` fields so the user can fill them in Settings →
Providers. Models are then addressed as `<id>:<model>`. A file that exports
`provider` is only a provider plugin.

Before writing a plugin, read `openagentd.d.ts` in this references directory —
it types the whole API (`fetch`, `subprocess`, `fs`, `credentialStore`, error
classes, chat message shapes).

## Installing or writing one

1. For a plugin from a URL, fetch the raw file and **review it with the user**:
   what it hooks, what it sends over the network, which commands it runs.
2. Write it to `<CONFIG_DIR>/plugins/<name>.ts`. To type-check, copy
   `openagentd.d.ts` next to it and run `tsc` if the user has it.
3. Tell the user to restart OpenAgentd — plugins load once per process.
4. After the restart, Settings → Plugins shows each file as loaded or with its
   error (`path:line:col`). A broken file is skipped, not fatal.

To remove a plugin, delete its file (or rename it to start with `_`), then restart.
