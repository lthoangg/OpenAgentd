# REPORT §5

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

## 5. Plugins (embedded QuickJS)

v3 contains no plugin code. It loads plugins at runtime from the same
`plugins_dirs` v2 uses: `~/.config/openagentd/plugins` in production and
`.openagentd/dev/config/plugins` in dev.

- **Discovery** (`crates/jsplugin/src/lib.rs`): every `*.ts`/`*.js` file,
  sorted per dir, deduplicated by canonical path. Files matching `_*`,
  `.*` and `*.d.ts` are skipped, and so is every `*.py`. Broken files are
  logged (`plugin_load_failed`, `provider_plugin_load_failed`) and skipped,
  as in v2.
- **Classification is by export.** A file can be either kind, but not both:
  - `export const provider = definePlugin({...})` is a provider plugin. It
    uses v2's validation (id, `build`, oauth needs `login`).
  - `export async function plugin()` (or a default export) that returns
    `{"tool.before", "tool.after", "applies_to"}` is a tool plugin. This is
    v2's functional contract. `applies_to` receives role `"agent"`, as in v2.
- **Runtime** (`runtime.rs`): rquickjs 0.14. Each file gets its own OS
  thread, QuickJS runtime and current-thread tokio LocalSet, so plugins are
  isolated from each other and concurrent calls interleave at `await`
  points. The memory limit is 512 MB per runtime. oxc 0.146 strips
  TypeScript on load (`transpile.rs`). Errors are reported as
  `path:line:col`.
- **Host API** (`host.rs`, `prelude.js`, `module.js`): the `openagentd`
  module provides:
  - `fetch` (Rust reqwest), `listen` (loopback OAuth callbacks),
    `subprocess`, `crypto`, `base64`, `utf8`, `url`, `env`, `fs` and
    `tokenPath`. Single-file plugins are trusted code, as in v2: `fs` and
    `subprocess` are not sandboxed, and isolation is between plugins, not
    from the host. The code of a plugin folder is sandboxed (below).
  - `credentialStore`, the error classes (`AuthError`, `HttpError`, …),
    which map onto the Rust `ProviderError`, and Python-compatible helpers
    (`pyJsonDumps`, `pyRepr`, `url.parseQuery`, ISO parsing). These keep
    output byte-identical to v2.
- **Several credentials (v3.30.0, opt-in).** A provider plugin that sets
  `supportsMultipleCredentials: true` joins the same pooled rotation as the
  built-in providers. Without it nothing changes: one credential, file
  tokens, `login(emit)` and `oauthCallback(code, emit)` as before.
  - *SDK.* `BuildContext.credentialId` and `CredentialStore.credentialId`
    name the account (`null` in legacy mode). OAuth `login(emit, ctx)` and
    `oauthCallback(code, emit, ctx)` get an `OAuthContext` with
    `providerId`, `credentialId` and `credentials`. `ctx.credentials`:
    `readOAuth()` returns the saved document or `null`;
    `writeOAuth(doc, { expected?, label? })` is an atomic compare-and-swap
    that returns `false` when a refresh raced it and throws if the account
    was deleted; `removeOAuth(expected?)` revokes the tokens and keeps the
    row.
  - *Storage.* OAuth tokens live in `credentials.yaml`. `tokenPath`,
    `readJson` and `writeJson` become per-account (plain names only) for
    caches and the pending login state. Legacy token files are not migrated.
  - *Wire.* The providers listing adds `supports_multiple_credentials` and
    `supports_credential_usage`. The OAuth callback API accepts an optional
    `credential_id`, required for an opted-in plugin, and login progress
    events carry `credential_id`. Each login reserves a pending row, so a
    deleted account cannot be resurrected by a login that finishes late.
    Per-credential OAuth operations on a legacy plugin are rejected, not
    ignored; saving a plugin's API key through the single-key route still
    works.
  - Globals: `fetch`, `Headers`, `Response`, `console`, `setTimeout`,
    `TextEncoder`/`TextDecoder`, `crypto`.
- **Provider instances** reuse the Rust providers, so streaming I/O stays
  native:
  - `base: "anthropic"` wraps `AnthropicProvider`, with the `beforeCall`,
    `transformInput`, `transformChunk` and `transformResponse` hooks.
  - `base: "http"` lets the plugin describe the request (`request`,
    `onError`, `streamParser().event`, `parseResponse`). Rust performs it.
  - The Gemini message/tool conversions are exposed as natives
    (`gemini.convertMessages`, …) for `http` plugins.
  - Chat types cross the boundary through a lossless JSON schema
    (`providers/src/plugin_json.rs`).
- **Authoring:** `crates/jsplugin/openagentd.d.ts` (also exported as
  `appv3_jsplugin::TYPES`) types the whole API. With that file and a
  `tsconfig.json` in the plugin dir, `tsc -p <plugin dir>` type-checks the
  plugins. The runtime itself never type-checks.
- **The user plugins** now exist as `.ts` files next to their `.py`
  originals in both plugin dirs. v2 globs `*.py` only, so both versions
  run side by side from the same dir. The
  harnesses in §1 compared v2's `.py` against v3's `.ts` on the same inputs.

### Plugin folders (plugin API v2)

A folder in a plugin dir is a plugin when it has a manifest
(`crates/plugins`). Folders starting with `.` or `_` are skipped, which is
where `agentd plugin add` stages a download.

- **Layout.** Agent Plugins 1.0: `plugin.json` (`$schema` and `name`
  required, unknown fields reported and ignored), `skills/<name>/SKILL.md`
  (direct children only), and `mcp.json` (`stdio` with a single-token
  `command`, and `streamable-http`; a server using the optional `sse`
  transport is reported as unsupported). Everything specific to OpenAgentd
  lives under the `dev.openagentd` namespace: the manifest's
  `extensions["dev.openagentd"]` (permissions) and the `dev.openagentd/`
  folder (`plugin.ts`, else `plugin.js`).
- **Paths.** Every path a manifest names must stay inside the folder after
  resolving links. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are replaced in MCP
  `args`, `env` and `cwd`, and both are set in each MCP server's environment.
  The data folder is `<data>/plugin-data/<name>`, kept across updates and
  removals.
- **Isolation.** One folder that fails to load is reported (`state:
  failed`, `errors`) without affecting the others; failing code drops only
  that folder's tools, hooks and provider. A reload restarts only the folders
  whose files or enabled state changed.
- **Code** (`dev.openagentd/plugin.ts`): its default export may hold
  `tools` (`defineTool`), `hooks` (`tool.before`/`tool.after`, run after the
  single-file plugins' hooks) and `provider`. It runs in its own QuickJS
  runtime with a sandbox (`crates/jsplugin/src/sandbox.rs`): it may read its
  folder, read and write its data folder, and use the pure helpers; `fetch`,
  `listen`, other `fs` paths, `subprocess` and `env` need the matching
  permission (`net`, `listen`, `fs`, `subprocess`, `env`), and a refused call
  throws a `PermissionError` naming the permission to add. Single-file
  plugins keep their v1 contract and are not sandboxed.
- **Credentials.** A folder's code uses the credentials, OAuth documents and
  token folder of one provider id only: the one its default export
  declares, when the id is a plain name and the server has accepted that
  provider from this plugin's module (no built-in, single file or earlier
  plugin has the id, compared ignoring ASCII case). The host's gate
  (`jsplugin::set_credentials_gate`) is asked at every use, so a plugin
  that stops loses access; a program that sets no gate (the CLI's code
  check) gives none. `credentialStore(id).get(name)` then returns that
  provider's saved value, or the exported variable only when
  `permissions.env` lists it; it never searches other providers or reads
  named secrets. A provider whose key is only exported can therefore look
  configured in Settings while its code reads nothing until `env` lists the
  variable. A plugin whose provider is skipped because another has the id
  is logged, not shown on the plugin.
- **Tools** are reached through the `mcp` tool with the plugin's name as the
  server (§3); `/api/plugins` names them `<plugin>/<tool>`. A call that is
  running when its plugin reloads finishes on the old code; later calls use
  the new one.
- **CLI.** `agentd plugin check <folder>` validates a folder and runs its
  code once without permissions to list the tools. `agentd plugin add <git
  URL or folder>` stages a copy or a shallow clone (`https://`, `ssh://`,
  `user@host:path`, `file://`; links leading outside the folder refused),
  prints the same summary, asks (exit 2 without a terminal and without
  `--yes`), moves it into the plugin dir and asks a running server to
  reload. `list` and `remove` (keeps the data folder) complete it.
