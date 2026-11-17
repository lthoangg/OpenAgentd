# REPORT §3: tools, providers, plugins, skills and MCP

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

## Deviations, one per item

- **Project folders** (v3.14.0). `.agents/` is the only project folder:
  v3 no longer reads `<workspace>/.openagentd/{skills,commands,snippets}`,
  `<workspace>/.opencode/{skills,commands}`, or
  `~/.config/opencode/{skills,commands}`, all of which v2 read
  (`agent/src/skills.rs`, `api/src/routes/library.rs`,
  `api/src/config_watch.rs`). New plans go to `.agents/plans/`.
- **One `mcp` tool instead of `<server>_<tool>` tools** (v3.16.0). v2 gave
  the lead one model-facing tool per MCP server tool. v3 gives it a single
  `mcp` tool (`search` / `call`, `mcp/src/hub.rs`), attached by
  `loader::build_agent` whenever a server is configured. MCP tools are no
  longer in `default_tool_registry`, so `<server>_<tool>` names in an
  agent's `tools:` are pruned as unknown. Old transcripts keep their
  `<server>_<tool>` tool calls; `mcp` `call` also accepts that prefixed
  name. Tool rows store `name: "mcp"` with `server`/`tool` in the
  arguments; `extra.mcp_app` keeps `server`/`tool`, so MCP Apps and
  `/api/mcp/app-tools/call` are unchanged. `mcp` is allowed in Plan mode
  and refuses calls to tools without `readOnlyHint: true`. For Gemini,
  nested object schemas without properties are sent as JSON-string params
  (`providers/src/google.rs`).
- **Plugins:** v3 loads `*.ts`/`*.js` plugin files and never reads `*.py`
  (§5). v2 loads only `*.py`. The same plugin dir therefore serves both
  versions, but every plugin needs a TS/JS port. The four user plugins are
  ported. Other gaps:
  - v2's class-based `Plugin(BaseAgentHook)` form has no equivalent. Only
    the functional contract is supported: `plugin()` returns
    `tool.before` / `tool.after` / `applies_to`.
  - The JS runtime is QuickJS with a small host API: no Node, no npm
    packages, no `URL`/`URLSearchParams`. Imports can only be relative or
    `"openagentd"`.
  - JSON that passes through JS loses the int/float distinction (`1.0`
    becomes `1`). The plugin payloads the harnesses compare are unaffected.
  - The loopback OAuth callback page sends `Server: openagentd` instead of
    `BaseHTTP/0.6 Python/3.x`.
  - Plugin disconnect removes only that plugin's token dir. A plugin that
    opts in to several credentials (§5) keeps its tokens in
    `credentials.yaml` instead, and disconnect is per account.
- **Documents (`read`, `web_fetch`):** v3 uses the `anydoc` crate that v2's
  `firecrawl-anydoc` wheel wraps, at the same version. Its PDF engine was
  pinned to the wheel's (`pdf-inspector` 1.14.2) for byte-identical output,
  then moved to 1.25.2 once v2 parity stopped being a goal. PDF text now
  differs from v2: sub/superscripts render as `<sub>`/`<sup>`, words split
  by line-end hyphens are rejoined, code listings are fenced, and some
  multi-column reading order is fixed. DOCX output, the encrypted /
  needs-OCR → vision fallback paths, and the error hints (anydoc's own
  texts, which are the Python exception strings) are unchanged.
- **`web_fetch` HTML:** v2's control flow is ported exactly, with the
  `trafilatura` crate (a port of go-trafilatura) standing in for Python
  trafilatura: main-content extraction, a fallback to `html2txt` when the
  extraction is empty or lost the code blocks, and `format="text"` via
  `html2txt`. `html2txt` is ported line by line and byte-identical on every
  page tested. The Markdown is close but not identical:
  - Code blocks are fenced with custom `htmd` handlers, like Python.
  - Links are made absolute.
  - Listing pages (blog indexes, HN) yield more content than v2's
    extraction.
  - GitHub issue pages are weak in both.
  - Where Python renders a page's code inline and v3 fences it, v2's
    "code lost" fallback fires only in v2. Example: RFC 9110, where v2
    returns the whole page as one text line and v3 returns structured
    Markdown.
  - Short pages (≤ ~100 characters of body text) reproduce Python's
    baseline output, because go-trafilatura's last step there duplicates
    text.
- **`web_fetch` bot walls (v3 only):** anti-bot interstitials (Cloudflare,
  Reddit, DataDome, PerimeterX, Vercel, AWS WAF) return "Browser
  verification required." with the vendor named. v2 recognises only
  Cloudflare's `cf-mitigated` 403 and otherwise returns the interstitial's
  text.
- **`web_search`:** scrapes DuckDuckGo's HTML endpoint instead of using the
  `ddgs` library, then falls back to Exa the same way v2 does.
- **Copilot:** catalog cached for 5 min; reasoning-effort gating resolved at
  provider build; `_verify_copilot_access` prints only in CLI mode.
- **MCP:** v3 does not hold the auth lock across the whole
  body read of concurrent requests. A loopback-callback timeout followed by
  a second wait returns an immediate timeout (v2 waits another 300 s).
- **Multimodal:** API keys are read from the environment at call time (v2
  captures settings at startup).
- **LSP:** full port (`crates/tools/src/lsp/`: client, manager, managed
  Bun/TypeScript + PyPI ruff/ty installs, `lsp_install_required` event,
  `LspHook`, `/api/settings/lsp*`, `agentd lsp status|install`).
  `diff_lsp.py` (fake stdio servers + mock PyPI/Bun host): 218/218
  identical. Deviations: "packaged" ruff/ty are looked up beside the v3
  executable (and `../bin`) instead of beside the Python interpreter; musl
  is detected at compile time; malformed server payloads (non-object
  `params`, non-list `diagnostics`) are tolerated where v2's read loop would
  die; the `lsp` navigation tool is ported but, exactly like v2, is not in
  any runtime registry, and it has no model-facing definition (removed from
  `tools/data/tool_definitions.json`). Python runs one type checker, not every installed
  one: the first of ty, pyright and pylsp that starts, with ruff (lint)
  beside it (`start_servers` in `tools/src/lsp/manager.rs`). v2 starts all
  of them, so ty and pyright both reported the same type errors.
- **`todo_manage` clear:** `clear` without a status removes every task
  (`tools/src/todo.rs`; the `status` description in
  `crates/tools/data/tool_definitions.json` says so). v2 defaults to `finished`, so
  agents resetting the board for a new plan left the old plan's pending and
  in-progress tasks behind.
- **Bundled skills:** v3 bundles one skill, `self-healing`
  (`crates/agent/data/builtin_skills/self-healing`). Its `SKILL.md` is an index of
  `references/*.md` files, plus the plugin typings (`jsplugin/openagentd.d.ts`).
  They describe v3 behavior: the `patch` tool, global MCP servers, the
  `multimodal.yaml` schema, and no skill discovery cache. v2's `skill-installer`
  became `references/skills.md`. Materialisation deletes files that are no
  longer bundled, so an old copy is not discovered. The files live in the
  denied cache dir, so `DeniedPaths::read_only_roots` lets `read`/`grep`/`glob`
  open them. Write tools and `shell` still refuse them, and the denied patterns
  still apply. v2 kept bundled skills in the source tree, where they were
  readable. Tests: `agent/src/skills.rs`, `tools/src/denied/tests.rs`,
  `agent/tests/bundled_skill_references.rs`.
- **MCP request deadlines (v3 only):** `mcp.json` server entries (stdio and
  http) accept an optional integer `timeout` in seconds, 1–270, written only
  when set; the MCP settings API returns 422 outside that range. `tools/call`
  waits `timeout` (default 210 s) and other requests wait
  `min(30 s, timeout)`. When a request times out or its future is dropped, the
  client removes the pending entry and sends `notifications/cancelled`
  (never for `initialize`). Stdio writes run in a spawned task, so a
  cancelled caller cannot leave a half-written line on stdin. Tests:
  `mcp/src/tests.rs`. v2 waits without a deadline.
- **`read` tool `outline` removed (v3.14.0):** the `outline` argument and
  `crates/tools/src/outline.rs` are gone and `crates/tools/data/tool_definitions.json`
  no longer lists it, so a call passing `outline` fails as an unknown
  argument. v2 still offers it.
- **Plugin watchdog (v3 only):** a plugin thread running JS for more than 5 s
  without yielding is interrupted (`TimeoutError`); loads time out at 30 s,
  blocking calls at 10 s and tool hooks at 60 s. Tests:
  `jsplugin/tests/host.rs`.

## Modules and plugin folders (v3 only)

The server starts and stops through a module kernel (`crates/kernel`). The
built-in services are modules (`api/src/modules.rs`), started in dependency
order and stopped in reverse, in the same order as before
(`builtin_modules_stop_in_the_servers_shutdown_order`). An optional module
that fails is marked failed and only the modules that depend on it are
blocked; a critical one still stops the server.

- **`GET /api/modules`** (new): `{"modules": [{id, deps, critical, state,
  error, start_ms}]}`, with `state` one of `pending`, `running`, `failed`,
  `blocked` and `stopped`. `agentd doctor` prints it.
- **Plugin folders** (§5) each run as a module `plugin:<name>`. Its
  contributions (skills, MCP servers, tools, tool hooks, a provider) leave
  with it when it stops, so a reload replaces them.
- **`GET /api/plugins`** adds `bundles`, one item per folder: `name`,
  `version`, `description`, `path`, `enabled`, `state` (a module state, or
  `disabled`), `errors`, `warnings`, `skills`, `mcp_servers` (`name`,
  `transport`, `command`, `args`, `url`), `tools` (`name`, `description`,
  `read_only`), `permissions` and `has_code`. `POST /api/plugins/reload`
  rescans the folders and answers like the GET.
  `PUT /api/plugins/bundles/{name}` with `{"enabled": bool}` records the
  choice in `<config>/plugins.json` (a `disabled` list), reloads, and answers
  with that bundle (404 for an unknown name). The config watcher also reloads
  when a file under a plugin dir changes.
- **MCP:** `GET /api/mcp/servers` lists plugin servers with `plugin` set to
  the folder's name (the user's servers have no such key), and their
  `config` is the plugin's. `PUT` and `DELETE` on a plugin server return 409;
  restart and OAuth work as for any server. The `mcp` tool's `save` and
  `remove` refuse them too.
- **Tools:** the built-in tool definitions, the agents they go to and
  whether they run in Plan mode live in one table
  (`agent/src/tool_registry.rs`); the Plan mode tool list is derived from it.
  Plugin tools are not in the request's tool list: the `mcp` tool searches
  and calls them with the plugin's name as the server, reading the live
  tools, so `call` runs a tool's current version. The plugins with tools join
  the server names in its description, which is frozen with the session
  (`mcp_tool_description`). Without plugin tools the description, and so
  the first request, is byte-identical to before
  (`agent/tests/request_snapshot.rs`, `mcp/tests/plugin_tools.rs`). In Plan
  mode only `read_only` tools run. A server of the user's named like a plugin
  hides that plugin's tools; the plugin's Settings entry warns.
