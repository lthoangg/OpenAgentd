---
title: "Features: Extension surface"
description: "Skills, MCP servers, plugins and commands."
---

# Extension surface

Part of the [feature catalogue](../features.md), under *7. Extension surface*. The index explains the version tags.

Four orthogonal ways to add capability.

- **MCP servers** `[since v1.0; v2.11.0]` — any Model Context Protocol server,
  hot-reloaded via `POST /api/mcp/apply`. A configured server is automatically
  available to the coding agent; agent Markdown no longer needs a per-agent MCP
  selection. OAuth-backed setup. Session Settings shows every configured server
  (the composer's **+** menu since v3.40.0)
  and can enable/disable it globally or connect OAuth-backed servers in place
  `[v1.52.2]`. Each server gets its own row showing connection state and tool count, with a
  toggle and an OAuth connect/reconnect action; the list re-polls while a server is
  starting so a freshly enabled server settles to ready in view `[v1.125.0]`.
  OAuth setup permits empty client ID and secret fields so servers that support
  dynamic client registration can complete setup without app credentials; issuer
  discovery also tolerates a sole trailing-slash difference at the origin root `[v1.124.0]`.
  - **One `mcp` tool for every server** `[v3.16.0]` — the agent no longer gets
    every server's tools (named `<server>_<tool>`) with their full schemas on
    each turn. It gets a single `mcp` tool: `search` finds tools by keywords and
    returns their input schemas, and `call` runs one by server, tool and
    arguments. Its description names the enabled servers only `[v3.30.0]`: a
    server starting, connecting, needing sign-in or failing no longer changes it
    and breaks the prompt cache (`search` and `call` report a server's state when
    it matters). Adding servers no longer grows every
    request, server tools can't clash with built-in tool names, and a server
    that finishes starting or reconnects is usable at once. In Plan mode the
    agent can search, and call tools the server marks read-only
    (`readOnlyHint`); the server sets that hint, so it is trusted as given.
  - **Arguments checked before a call** `[v3.44.0]` — `call` checks the
    arguments against the tool's input schema (types, required and unknown
    fields, allowed values, lengths and bounds, nested objects and lists) and
    returns every problem, with the schema, before the server or plugin sees
    the call. The check is lenient: keywords it does not know pass, and a null
    for an optional argument counts as left out.
  - **Sign in without OAuth setup** `[v3.45.0]` — an HTTP MCP server that asks
    for sign-in offers **Sign in** without an `oauth` block in its entry:
    OpenAgentd finds the server's authorization and registers itself, as the
    MCP spec describes. Plugin MCP servers sign in the same way. A server that
    does not ask connects as before, one with its own `Authorization` header
    keeps using it, and a background start never registers a client.
  - **Legacy HTTP+SSE servers** `[v3.45.0]` — `mcp.json` takes `type` as well
    as `transport`, with `stdio`, `http` (or `streamable-http`) and `sse`.
    `sse` reaches servers that still speak the 2024-11-05 HTTP+SSE transport,
    and an `http` server that refuses Streamable HTTP falls back to it on its
    own. Plugins can declare `sse` servers, and the Settings → Connectors form offers
    **SSE (legacy)**.
  - **Set up MCP servers from chat** `[v3.35.0]` — ask the agent to connect a
    server ("add the GitHub MCP") and it proposes the `mcp.json` entry
    (`mcp` with `action: "save"`, or `"remove"`). A **Confirm change** card
    shows the command it runs or the URL it connects to; only **Apply** saves
    it and starts the server, and the agent then reports whether it is ready
    and its tools, or the error. `action: "servers"` lists every server with
    its state, error, tools and config, also in Plan mode. The agent never
    sees a secret: `env` and header values and OAuth credentials show as
    `********` (a `${NAME}` reference shows as written), sending `********`
    back keeps the stored value, and tokens and OAuth sign-in stay in
    Settings → Connectors. The `mcp` tool is listed even before the first server, and
    its description is fixed for the session, so adding or removing a server
    does not invalidate the prompt cache; new sessions see the new list. A
    change that was made elsewhere after the card opened is not applied.
  - **Confirm change cards** `[v3.35.0]` — the card the MCP and workspace group
    changes above use: an ordinary question card with **Apply** and
    **Cancel**, answered on the server, so only your **Apply** runs the
    change, at most once. Typing an answer instead cancels and passes your
    words to the agent. One change is confirmed at a time; in a scheduled or
    goal turn nobody is there to confirm, so the change is refused.
  - **`$VAR` / `${VAR}` expansion in stdio server env** `[v1.122.0]` — stdio MCP
    server `env` entries in `mcp.json` now resolve environment/`.env`-style
    references the same way header values already did, so secrets can be
    referenced instead of written in plain text. Values saved from the MCP
    form (OAuth client secrets) live under `secrets:` in `credentials.yaml`;
    an exported environment variable of the same name wins `[v3.30.0]`.
  - **Markdown-rendered tool descriptions in Session Settings** `[v1.96.0]` —
    tool descriptions in the Session Settings tools panel now render as structured
    markdown (bullet lists, inline code, bold/italic, paragraph breaks) instead of
    a plain-text wall. MCP servers that include formatted descriptions in their tool
    schemas benefit automatically; plain-text descriptions render identically to before.
    The tool inventory is grouped by origin (built-in, then one group per MCP server)
    and open by default so available tools are immediately visible; the name/description filter appears past eight tools `[v1.125.0]`.
  - **Multimodal image tool returns** `[v2.20.0]` — MCP tools can return image
    MIME types (`ImageContent` and image embedded resources), which are
    translated to structured `ImageDataBlock` parts for vision models while
    preserving concise textual summaries in transcripts and history.
    Images are capped at 2000 px on the long edge for every provider `[v3.5.0]`: tool
    results (including `read`) are shrunk when they arrive, and requests also
    shrink oversized images replayed from older history, so Anthropic's
    many-image limit and other providers' pixel limits always hold.
- **Sandboxed UI artifacts** `[v1.36.0, updated v2.17.0]` *(beta)* — tool-produced HTML UI
  resources render as sandboxed sibling chat artifacts. The first producer is
  MCP Apps: MCP tools that declare `_meta.ui.resourceUri` can render `ui://`
  resources with MIME `text/html;profile=mcp-app`. First slice targets
  interactive Excalidraw diagrams; fullscreen now uses the full viewport with
  mobile safe-area padding, and the host exposes its own fullscreen button
  `[v1.45.2]`. If later tool results reference the same UI resource, chat shows only the
  newest artifact for that resource. The same-server bridge can invoke tools
  currently advertised by the artifact's originating MCP server only `[v1.37.0]`.
  Production desktop and mobile Tauri shells allow `about:` frames so `srcdoc`
  MCP Apps render interactively under the packaged CSP `[v1.44.11]`. The MCP app
  host runs on `@modelcontextprotocol/ext-apps` v2.0 with modular client/core architecture `[v2.17.0]`.
  An app runs in an origin of its own `[v3.55.0]`: it cannot read the
  OpenAgentd page, its storage or its access key, cannot call the OpenAgentd
  API, loads only from the domains its resource declares, and can open
  `http` and `https` links only. Its page loads from a single-use address, so
  apps that need a real page address work. What
  an app reports for the model, such as the shapes a user drew on a canvas,
  reaches the agent with the next message. Tools a server marks for the app
  alone are not offered to the agent. An app's page is stored once instead of
  with every result, so a session with many app results stays small. What an
  app saves for itself, such as a canvas you drew on, is kept per MCP server
  and is still there after a reload or a restart. An app keeps running when
  its turn ends instead of loading again. An HTTP MCP server's session is
  kept across restarts of OpenAgentd, so what a server holds for it (a
  canvas an app is editing) is still there afterwards; restart the server in
  Settings → Connectors to start a fresh session.
- **MCP `PATH` resolution on desktop** `[v1.17.x]` — desktop auto-resolves the
  shell `PATH` so `npx` / `uvx` stdio servers can find their commands. Restart
  any MCP server in Settings to re-detect.
- **MCP timeouts and cancellation** `[v3.14.0]` — an MCP tool call that does
  not answer in 210 s (other MCP requests: 30 s) fails with a "timed out"
  error instead of hanging the turn, and the server is sent
  `notifications/cancelled` when a call times out or is stopped. Set
  **Tool timeout** (1–270 s) per server in Settings → Connectors, or `"timeout"` in
  `mcp.json`.
- **`.agents/` is the only project folder** `[v3.14.0]` — skills, commands and
  snippets load from `<project>/.agents/`, the OpenAgentd config dir, and
  `~/.agents/`. A project's `.openagentd/` and `.opencode/` folders, and
  `~/.config/opencode/`, are no longer read: move their `skills/`, `commands/`
  and `snippets/` into `.agents/` (for example `mv .openagentd/skills .agents/skills`).
  New plans are saved in `.agents/plans/`.
- **Skills** `[since v1.0]` — markdown `SKILL.md` files, lazy-loaded, hot-reload
  on mtime change, token substitution. Compatible with the Agent Skills (agentskills.io) spec.
  One nested namespace level (`parent/sub`) is supported `[v1.27.x]`; Settings
  lists the full runtime-visible catalog and can edit/delete non-bundled skills
  in place `[v1.27.x]`.
  - **Reference files and scripts support** `[v1.87.0, v1.92.0]` — fully compatible with the
    `agentskills.io` specification. Resolves `{SKILL_DIR}` and `${SKILL_DIR}` placeholders
    inside loaded skill instructions. Project-level skill directories resolve to clean relative
    paths (e.g. `.agents/skills/my-skill`), while global/bundled skill directories resolve
    to absolute paths, allowing the agent to use standard `read` and `shell` tools to access them.
    `load_skill` now always prepends a `Skill directory: <path>` line to its response so the
    agent finds bundled reference files without relying on the author adding `{SKILL_DIR}`
    tokens `[v1.92.0]`. Skill cache invalidation now also watches project-local skill roots
    (`.agents/skills/` `[v2.12.0]`), not just the global config directory, so
    edits are picked up on the next `discover_skills()` call `[v1.92.0]`.
  - **Stable skill list, fresh skill content** `[v3.28.0]` — the skill list in the
    `skill` tool's description is fixed for the session, keeping the prompt cache
    intact; a skill added or re-described mid-session appears in the next session.
    Loading a skill always reads its current body from disk, so edits to a skill's
    instructions apply right away.
  - **Bundled `self-healing` skill with references** `[v3.3.0]` — one bundled skill covers the
    agent's own setup: its `SKILL.md` is an index linking reference files for agents, MCP servers,
    skills, plugins (with the `openagentd` plugin API typings), and image/video generation. It
    replaces the separate `skill-installer` skill. `read`, `grep`, and `glob` may open bundled
    skill files, while write tools and `shell` still cannot touch them.
    References for slash commands (where the files go, `$ARGUMENTS`, names
    to avoid) and workspace groups were added, so "make a /review command for
    this project" writes `.agents/commands/review.md` `[v3.35.0]`. The
    plugins reference covers plugin folders and `agentd plugin`, and the agent
    shows what a plugin adds before installing it `[v3.44.0]`.
  - **Semantic docs search skill experiment** `[v1.98.0]` *(beta)* — project workspaces can ship
    an `oad/search-doc` skill plus a turbovec-based document-search experiment for semantic lookup
    over `documents/`, giving agents a higher-level alternative to exact-string grep when docs
    queries are conceptual or paraphrased.
- **Plugin folders** `[v3.44.0]` — a plugin can now be a folder in the plugin
  dir that adds skills, MCP servers and tools. The layout is the open Agent
  Plugins 1.0 format (`plugin.json`, `skills/`, `mcp.json`), so plugins written
  for other clients that read it work here, and the standard parts of a plugin
  written here work there. Skills are named `<plugin>/<skill>` and MCP servers
  `<plugin>/<server>`, with `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` (a data
  folder kept across updates) filled in. Adding, editing or removing a plugin
  needs no restart: it reloads when its files change. New sessions get its
  skills, its MCP servers and tools are usable at once, and running sessions
  keep their requests unchanged. A broken plugin is marked failed without
  affecting the others. Single-file plugins keep working as before.
  - **Plugin tools through the `mcp` tool** `[v3.44.0]` — a folder's
    `dev.openagentd/plugin.ts` can define tools (`defineTool`), tool hooks and
    a model provider. Agents reach plugin tools through the `mcp` tool, with
    the plugin's name as the server: `search` finds them with their input
    schemas and `call` runs one, so installing tools never grows the tool
    list. A plugin installed or edited mid-session is usable at once and runs
    its new version; its name joins the `mcp` tool's description in sessions
    that start afterwards, and without plugins the request is unchanged. In
    Plan mode only tools marked `readOnly` run. An MCP server of the user's
    with the same name as a plugin hides that plugin's tools, and Settings →
    Plugins says so.
  - **Plugin permissions** `[v3.44.0]` — a folder's code runs sandboxed: it
    reads its own folder and reads and writes its data folder, and anything
    more needs a permission in `plugin.json` (`net` hosts, `listen`, `fs`
    folders, `subprocess` programs, `env` variables). A call outside them
    fails with an error that names the permission to add. A folder's provider
    reads only its own saved credentials and the variables `env` lists, never
    another provider's keys or MCP secrets, and only while no built-in provider
    or other plugin has its id. MCP servers from a plugin run as ordinary
    processes and are not sandboxed.
  - **Manage plugins in Settings** `[v3.44.0]` — Settings → Plugins lists each
    folder under **Plugin folders** with its state, an on/off switch, a
    Reload button, and details: skills, the command or URL of each MCP
    server, tools (read-only ones marked), permissions, errors and warnings.
    Plugin MCP servers appear in
    Settings → Connectors marked "from <plugin>": they can be restarted there, go on
    and off with their plugin, and the agent's `mcp` tool cannot change them.
    With no plugin folder yet, it suggests asking an agent to install one.
  - **`agentd` for the agent in the desktop app** `[v3.44.0]` — the desktop
    app keeps `agentd` inside the app and puts nothing on `PATH`, so the
    agent's `shell` now adds that folder at the end of `PATH` when it finds no
    `agentd`, and the agent can run `agentd plugin check`, `add`, `list` and
    `remove`. An `agentd` you installed still comes first. When `add` or
    `remove` reaches no server (the desktop app's listens on a port of its
    own), they say no server answered and that a running server picks the
    change up on its own, instead of saying none is running.
  - **Plugin skills in the Agent Skills format** `[v3.57.0]` — a plugin
    skill whose frontmatter `name` is its folder name, as the format
    requires, now shows as valid in Settings → Skills instead of "does not
    match directory name". Its siblings can load it by that bare name
    (`code-review` for `review-kit/code-review`) when no other skill has the name and no
    other plugin has the folder.
- **Slash commands** `[since v1.0]` — `.md` files with optional frontmatter,
  available globally or scoped to a coding workspace (`[v1.17.0]`). One nested
  namespace level is supported and displayed in the composer as colon syntax
  (`/git:commit`) `[v1.27.x]`.
  - **Skills in the `/` menu** `[v3.57.0]` — every skill is listed after the
    commands, badged *skill* (`/review-kit:code-review`); running one asks the
    agent to load it, with the typed text appended. A skill with
    `disable-model-invocation: true` is left out of the model's skill list,
    so the agent does not reach for it on its own.
- **Self-healing skill** `[v1.14.0]` — agent edits its own `.md` config (model,
  tools, MCP) and the runtime picks up the change at end-of-turn.
