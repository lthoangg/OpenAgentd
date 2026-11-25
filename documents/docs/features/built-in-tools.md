---
title: "Features: Built-in tools"
description: "The tools the agent can call without extra setup."
---

# Built-in tools

Part of the [feature catalogue](../features.md), under *6. Built-in tools*. The index explains the version tags.

Tools the agent can call without any extra configuration. Add more via skills or
MCP.

| Category | Tools |
|---|---|
| Filesystem | `read` (files + directory listings), `patch` (create/edit/delete/move), `glob`, `grep` |
| Shell | `shell` (supports `background=true` `[v2.0.0]`, which saves the output to a log and reports the exit, with `wait` for a result the session waits for `[v3.63.0]`; read-only in Plan mode `[v2.17.0]`) |
| Web | `web_search`, `web_fetch` (fast HTML extraction via `trafilatura` `[v2.0.0]`) |
| Generation | `generate_image`, `generate_video` |
| Scheduling | `schedule` (reminders + self-scheduling agentic loops; `schedule_task` before v3.30.0) `[v1.70.0]`; `update` changes a task's schedule, prompt, run limit or paused state in place, keeping its slug and run count `[v3.33.0]` |
| Tasks | `todo` (`todo_manage` before v3.30.0) |
| Team orchestration | `team` (lead agent; `delegate` before v3.30.0) `[v2.16.0]` |
| Cross-workspace messages | `workspace` (lead agent; Settings → Workspaces can turn it off; `send_to_workspace` before v3.30.0) `[v3.9.0]` |
| Subagent communication | `ask_lead` (subagents) `[v2.16.0]` |
| Ask the user | `ask_user` (coding agent) `[v1.131.0, v2.1.0]` |
| Session goal | `update_goal` (lead agent; claims the goal of a plan approved with Keep going complete or blocked) `[v3.32.0]` |
| Web preview | `browser` (lead agent with a workspace, Chat included; `preview` before v3.62.0) `[v3.3.0]` |
| Scripted tool calls | `script` (every agent, lead and member) `[v3.57.0]` |
| Secrets | `secret` (lead agent with a workspace); `shell` takes `secrets` `[v3.59.0]` |
| Utility | `skill` |

- **`secret` — ask for API keys without seeing them** `[v3.59.0]` — when a
  task needs keys, the agent names them (up to 8 on one card, with a reason
  and an optional link to where each is made). The card in the chat, on
  desktop or phone, has a masked field per key; each value goes straight to
  the secret store and the agent learns only which names it got. It then
  runs commands with `secrets: ["NAME"]` on `shell` (and so `script`), which
  sets just those variables for that one command. A key is saved for this
  project or for every project; worktrees share their repository's keys.
  One name can hold a different value per project (`STRIPE_SECRET_KEY` for
  two clients): a project that lacks one is offered the saved value or a
  new one, with neither picked. A key the project can already use needs no
  card, and one a service rejected is replaced everywhere or only here.
  Provider keys and connector secrets are never available to commands, names
  such as `PATH` or `LD_PRELOAD` are refused, and scheduled runs cannot ask.
- **`script` — chain tool calls in one step** `[v3.57.0]` — the agent can write a
  short JavaScript or TypeScript snippet that calls its other tools as
  `await tools.grep({...})`, with loops, filters and `Promise.all`, and gets
  back only what the snippet logs or returns. A task that took ten calls and
  ten model round trips, such as grepping several folders and counting the
  hits, takes one, and large intermediate results such as MCP JSON never
  reach the context. The snippet runs in a fresh, sandboxed QuickJS runtime
  with no network, file or process access of its own: each nested call goes
  through the same Plan-mode, denied-path and plugin-hook checks as a direct
  call, and a script cannot ask you questions, submit a plan, delegate, or
  start another script. A script stops after 270 s, which keeps the next
  model call on a warm prompt cache, and still returns what it logged.
  Scripts are reusable: `save_as` keeps one that ran without error in the
  project's `.agents/scripts/` folder (or in your personal scripts folder
  outside a project), `list` shows the saved ones with their `@description`
  and `@arg` lines, and the agent runs one again by `name` or by `path`
  (any workspace `.ts` or `.js` file) with new `args`; a file script may
  import helpers from its own folder. The tool row shows the code, a live
  list of the nested calls (time and size, errors in red), and the result,
  and looks the same after a reload.
  Since `[v3.60.0]` a nested call refreshes the panels a direct call would,
  as it finishes: a `patch` or `shell` updates the file tree, Git and an open
  file, a `todo` the task board, and a `schedule` the scheduled tasks, with
  the script still shown as one row.
  Since `[v3.62.0]` the closed row says how many calls the script made
  ("3 calls"), the name it was saved under and whether the time limit
  stopped it, as soon as it finishes and after a reload; before, that
  showed only once the row had been opened.
- **`browser` — show a page, read its console, and use it** `[v3.3.0]` — the agent
  opens a running local dev server or a workspace HTML file in your Browser
  tab, called Preview before v3.62.0 (it comes forward on desktop, and the
  tool card has **Open in Browser**).
  It then reads that page's recent console errors, warnings and logs, newest
  first, and can clear them to see only new output after a fix. It can also
  use the open page: a **snapshot** lists headings, text and controls with
  refs (`e1`, `e2`, …), and it can **click**, **fill** fields, **press**
  keys, **scroll**, **navigate**, **wait** for text, and **inspect** an
  element's source, styles and HTML. Acted-on elements flash in the page.
  A cursor in the page glides to each element it acts on, labeled with what
  it is doing (*Clicking*, *Typing*), so you can follow along `[v3.5.0]`.
  It can **chain** up to 20 of these actions in one call, such as filling a
  form, submitting it and taking a snapshot, stopping at the first step that
  fails `[v3.5.0]`. Session settings list `preview` among the agent's tools
  in coding workspaces `[v3.5.0]`.
  Since v3.62.0 `open` also takes a page of the public web
  (`https://example.com/docs`), shown by the desktop app on a Mac in its own
  browser profile, where you may be signed in. The agent may use a site only
  once you allowed it (a card asks the first time; Settings → Browser keeps
  the lists), each command runs only while the page is still on the site it
  was allowed for, what a page says reaches the agent marked as data from
  the site, password fields stay hidden from it, and it has no access to
  cookies. In Plan mode it only looks, as on local pages. With several
  pages loaded, an action that names no page goes to the one the agent
  opened or used last.
  Since v3.62.0 the tool is called `browser` (it was `preview`), and Chat
  has it too, not only project workspaces. Old sessions show their
  `preview` calls as before; an agent there that calls `preview` again is
  told to use `browser`.
  A server on this computer is opened by its loopback URL, never the OpenAgentd API port. Everything
  works only while the page is open in the Browser tab *(since v3.42.0, or
  loaded out of sight while the desktop app is open)*; there is no headless
  browser and no screenshots.
- **Hints on wrong tool names and paths** `[v3.28.0]` — calling a tool by a
  name from another harness (such as `bash`) answers "Did you mean …?" and
  lists the available tools. A missing absolute path such as `/DESIGN.md` that
  exists inside the workspace names the workspace-relative path, so the agent
  corrects itself on the next call. Path resolution is unchanged.
- **`ask_user` — durable suspend and resume** `[v1.131.0, v2.1.0]` — in
  **coding mode** `[v2.1.0]`, the agent can stop mid-turn and ask you 1–4 questions rather
  than guessing on a decision that would cost real work to undo. Each question
  carries up to 5 options with optional descriptions, single- or multi-select,
  a "Recommended" badge on the agent's preferred choice, and a free-text
  answer. **Type your own answer** is on every question `[v3.4.0]`; the agent
  can no longer turn it off. Multi-question cards are stepped through one at a time
  with **Back** and **Next**, and the whole set is
  submitted together with **Send** at the end. The card renders **inline in the transcript**, in place of
  the tool call that raised it, with exactly two states: waiting (the questions
  and their suggested answers) and resolved (your answer, or the dismissal).
  The suspension is **durable, not in-memory**: the pending question and the
  interrupted tool call live in the database, so the turn survives an app
  reload, a daemon restart, and a switch to another device, then resumes from
  exactly where it stopped. Answering, stopping the session, or simply typing
  something else are the only ways to move it — there is no timeout. Members keep working
  throughout and are never interrupted by an answer. Turns support multiple
  questions across suspensions `[v2.10.0]`;
  in a turn a scheduled task started, the tool stays listed but refuses when
  called, because nobody is there to answer; `submit_plan` does the same
  `[v3.24.0]`.
  Question text can be up to 1,000 characters, option descriptions up to 400,
  and a `submit_plan` summary up to 600, so long questions and summaries are
  no longer rejected and retried `[v3.28.0]`.
  Since `[v3.54.0]` a question asked in the same reply as other tool calls
  opens at once, while those tools still run, where it used to wait for the
  slowest of them. Answer it then and the agent continues as soon as the
  tools finish, without pausing; leave it and the turn pauses on it as
  before. Sending a message instead supersedes it, and Stop dismisses it.
  Failed scheduled tasks remain eligible to retry until their run limit is met `[v2.13.0]`.
  A run that fails on the task's last allowed run stops the task instead of
  firing again past the limit: its details say "Stopped: its last run
  failed" with the error and Run again. A scheduled run aimed at your own session
  waits for a message you are sending and then skips that slot, so it never
  starts a second turn beside yours `[v3.59.0]`.
  Every session lists the same tools on every turn, whoever started it, so a
  scheduled run never invalidates the prompt cache. A task that runs in your
  own session (`"current"` or a session ID) no longer takes `ask_user`,
  `plan`, `submit_plan`, `delegate`, `preview` or idle compaction away from
  it, and sessions that lost them get them back on upgrade `[v3.24.0]`.
- **Resilient web search Exa fallback** `[v2.21.0]` — `web_search` uses `web_search_exa`
  with Server-Sent Events (SSE) stream parsing and normalized result structures
  when DDGS search backends are unreachable or return no results.
- **Search usage guidance** `[v2.21.0]` — `web_search` instructions guide agents to
  write focused queries, fetch known URLs directly, evaluate primary sources,
  and report uncertainty when search results cannot be verified.
- **Fast HTML & document extraction** `[v2.0.0]` — `web_fetch` uses `trafilatura` for
  clean HTML-to-markdown extraction, and `read` uses `anydoc` for robust document
  conversion, dropping `markitdown`.
- **Safe, bounded web fetching** `[v2.9.0]` — `web_fetch` streams responses under
  a 50 MB limit, validates every redirect against public-network policy, reports
  concise typed HTTP/network/conversion failures, and supports distinct Markdown,
  text, HTML-source, and raw-text output modes. Destinations that resolve to
  loopback, private, or link-local addresses are refused unless
  `OPENAGENTD_WEB_FETCH_ALLOW_PRIVATE_NETWORK=true` is set, which lets the agent reach local
  dev servers and trusted internal hosts. The check is enforced at connect time
  and the socket is pinned to the validated address, so a DNS answer cannot
  change between validation and connection. Repeated fetches reuse one pooled
  HTTP client that is closed on server shutdown.
- **Anti-bot block detection** `[v3.2.0]` — when a page is blocked by
  anti-bot protection (Cloudflare, DataDome, PerimeterX, Reddit, Vercel, AWS
  WAF), `web_fetch` returns a clear "Browser verification required" error
  that names the vendor, instead of the interstitial's text.
- **Structured Markdown for landing pages** `[v3.10.0]` — `web_fetch` keeps
  headings, lists and links on landing and app-shell pages, where article
  extraction used to return bare paragraphs or one flat line of text. Navigation,
  footers and inline data-URI images are left out. Articles convert as before.
- **50k character read limit** `[v2.0.0]` — expanded `read` tool context limit to
  50,000 characters for reviewing larger source files in a single pass.
- **View an image the agent read** `[v3.24.0]` — a `read` of an image in the
  workspace gets a **View image** button on its transcript row, which opens the
  image in the side panel. It is hidden once the image is gone from the workspace.
- **SVG files read as text** `[v3.46.0]` — `read` returns an `.svg` file's XML
  instead of sending it as an image, which every provider rejected (the session
  then failed on every later turn). Other images models cannot view (BMP, ICO,
  TIFF) come back as a note with a command to convert them to PNG, and a request
  replaces any such image already in the history with a one-line note, so
  sessions that broke this way work again.
- **Real-time LSP diagnostics injection** `[v1.89.0, v1.105.0, v2.0.0]` — in **coding mode**, after the
  `patch` tool modifies one or more files, OpenAgentd runs the
  matching language server(s) over the changed files and injects the resulting
  errors/warnings straight into the tool result as a compact `[LSP Diagnostics]`
  block, so the agent sees and fixes problems on the very next turn. Servers run
  **on demand** (spawned lazily per project+language, reused warm, reaped after
  ~5 min idle) and are **matched to the project's own toolchain**: detection reads
  `pyproject.toml` / `Cargo.toml` / `package.json`, so a repo that pins `ty` + `ruff`
  gets exactly those. Resolution precedence is **project config → `settings.yaml`
  (`lsp:`) → built-in defaults**. Python is special-cased to run *multiple*
  complementary servers and merge results — a type checker (`ty`/`pyright`) **and**
  a linter (`ruff`) — because neither alone catches both type errors and lint;
  only one type checker runs, `ty` when it starts, else `pyright`, else `pylsp`
  `[v3.5.0]`;
  `ruff`/`ty` are **not bundled** with the runtime: when a project pins them (or
  declares them bare), the backend silently downloads the checksum-verified
  wheel for the project's exact `==` pin (PyPI latest for ranges) into the user
  cache (`{cache}/lsp/python/{tool}-{version}/`), so the desktop sidecar stays
  ~22 MB lighter; a failed or disabled install degrades to `pyright`/`pylsp`.
  every other language uses its single canonical server (`gopls`,
  `typescript-language-server`, `clangd`). Multi-file `patch` checks run
  concurrently, the report is capped per file (errors first, then a `…and N more`
  summary) to protect the context window, and the whole hook is fail-safe — an LSP
  error never crashes the tool. The coding workspace renders the block as a compact,
  color-coded `ERR`/`WARN` strip beneath the diff. Diagnostics depend on the server
  being available and on normal LSP scope rules (e.g. TypeScript honours `tsconfig.json`).
  A clean TypeScript edit returns as soon as tsserver says the file has no
  errors or warnings, instead of after a fixed 1 s quiet period; an edit with
  errors still waits for the diagnostics that report them `[v3.35.0]`.
  Pinned `ty` + `ruff` now ship with the Python runtime, while TypeScript is a
  consented, on-demand backend component with a verified Bun download, locked
  npm packages, a cross-surface install prompt (styled as a floating, non-blocking, draggable and minimizable notification card `[v2.12.0]`), and `agentd lsp` status/install
  commands. Managed tools live under the regeneratable cache and do not modify
  the user's project.
- **Semantic LSP navigation** `[v1.133.0]` — coding agents can find definitions,
  references, document symbols, and workspace symbols through the language server,
  using compact workspace-relative results instead of text search for code navigation.
  Results include a readable symbol kind (`Widget (class)`, `run (function)`) when the
  language server reports one; a file's own symbols list in source order (top-to-bottom),
  while cross-file results (references, workspace-wide symbol search) stay alphabetically
  sorted for determinism across multiple language-server clients. A `hover` operation
  returns type/signature/docstring info for a position (flattening `MarkupContent` and
  `MarkedString` shapes across servers); an optional `kind` filter narrows
  `document_symbol`/`workspace_symbol` results to one symbol kind (e.g. `function`,
  `class`, and accepting several at once, e.g. `function, method`); files with no
  mapped language server (anything outside
  `.py .ts .tsx .js .jsx .go .c .cpp .h .hpp`) get an explicit "no language server
  support" message instead of a misleading empty result. A `find_implementations`
  operation resolves interfaces, protocols, abstract classes, and overridable
  members, and `find_references` tags each hit `[definition]`/`[read]`/`[write]`
  when the server reports it. Empty results explain themselves instead of a bare
  "No results.": a cursor on whitespace, a comment, a keyword, or past the end of
  the file says so, and a position that is already the declaration reports
  "already at its definition site". Symbol resolution follows the project's own
  setup — `tsconfig.json` `paths`/`baseUrl` are forwarded to the TypeScript
  server and a project virtualenv (`.venv`/`venv`/`env`) is detected for Python,
  so aliased and site-packages imports resolve; `go_to_definition` falls back to
  `textDocument/declaration` and `textDocument/typeDefinition` when the primary
  request comes back empty. The chat UI's tool-call
  header/args display covers `hover` (position header, e.g. "Hover at path:line:col"),
  `find_implementations` ("Implementations at path:line:col"), and the `kind` filter
  (surfaced in both the `document_symbol`/`workspace_symbol` header and the expanded
  args), matching the existing per-operation formatting for
  `go_to_definition`/`find_references`/`document_symbol`/`workspace_symbol`.
  Position results (`go_to_definition`, `find_references`, `find_implementations`)
  carry the matching source line (trimmed, capped at 120 chars) next to each
  location, so an import, call, or annotation can be told apart without a
  follow-up read — the chat UI renders it as a muted second line under the path.
  `workspace_symbol` hits are tagged `[exact]`/`[prefix]` against the query and
  ranked by match quality ahead of fuzzy matches; results beyond the 50-item cap
  end with an explicit `… truncated: showing 50 of N results` note instead of
  silently disappearing. Empty results stay honest: `find_implementations` reports
  a cursor position problem (whitespace, comment, keyword, out-of-bounds) as such
  rather than claiming the symbol is not overridable, and a missing path says paths
  are workspace-relative and points at glob.
  Fixed a position-accuracy bug: the LSP client didn't advertise
  `hierarchicalDocumentSymbolSupport`, so servers (pyright, ty) fell back to
  flat `SymbolInformation` and `document_symbol`/`workspace_symbol` reported
  the start of the whole declaration (e.g. the `async`/`def` keyword) instead
  of the identifier — a position that then failed when fed into
  `go_to_definition`/`find_references`/`hover`. The client now requests
  hierarchical results and the manager prefers each symbol's
  `selectionRange` (the identifier) over its full `range`, so a
  `document_symbol` location now round-trips correctly into the other
  operations.
- **Clean tool argument validation errors** `[v1.77.0]` — when a tool call
  fails Pydantic validation, the LLM receives a compact `field: message`
  summary instead of the full Pydantic noise (type codes, raw input value,
  docs URL). Errors with multiple fields are joined with `; `; nested field
  paths use ` -> ` separators.
- **Gemini zero-argument tool calls no longer crash** `[v1.77.0]` — Gemini
  omits the `args` key entirely for tools that take no arguments; the schema
  now defaults `FunctionCall.args` to `{}` so the response parses correctly
  on both streaming and non-streaming paths.
- **Cross-tool `tool_output_delta` streaming** `[since v1.0]` — long-running
  tools (shell, web search) stream output to the inspector as they run.
  - **Live output trimmed to the rendered window** `[v1.120.3]` — each delta now
    carries only the trailing lines the inspector actually paints instead of up
    to 24 KB per flush. A noisy command (`bun test`, builds) previously streamed
    ~87% bytes that the client discarded on arrival, costing SSE bandwidth plus
    an immer transaction and React re-render per frame on desktop and mobile.
    Full output still reaches the model and the user in the final tool result.
- **Rich inline ToolCall rendering & scroll guardrails** `[since v1.0, v1.72.0]` — compact tool summaries and status lines, sticky headers for diffs, and automatic scroll/truncation boundaries for extremely large outputs.
  - **Tool arguments max-height and recursive JSON formatting** `[v1.72.0]` — tool arguments now respect a compact 10-line max-height scrollable container and recursively parse stringified JSON properties into pretty-printed formatting for optimal readability.
- **Tool result offload** `[since v1.0]` — bulky tool outputs (large file
  reads, shell spills) move to `{OPENAGENTD_DATA_DIR}/sessions/{id}/.tool_results/` and the inspector
  links to them.
- **`.gitignore`-aware file tools** `[v1.20.1, v1.131.3, v2.0.0, v3.14.0, v3.20.0, updated v3.63.0]` — `glob`, `grep`, and
  workspace file browsing respect `.gitignore` and skip dependency and cache
  directories. Workspace file listings (file tagging, the command palette, the
  files sidebar) come from git itself in a git work tree, so tracked files no
  longer disappear because their directory name looked generated, and the
  palette says when a listing hit its cap. Dot-directories other than `.git`
  and caches are searchable, `.env`-style secrets stay excluded, and `glob`
  understands `{ts,tsx}` brace patterns, finds bare patterns at any depth, and
  names the directory when a pattern matched one instead of dead-ending
  `[v1.131.3]`. Naming a generated directory in the pattern itself
  (`web/node_modules/@scope/pkg/**`) is treated as an explicit request and
  searched rather than silently pruned, and an anchored pattern walks only its
  own subtree — 2.6x–50x faster, and 35x on a pattern pointing into a
  dependency `[v2.0.0]`.
  Quick Open and the `@` picker also find gitignored files (a rendered
  `out/clip.mp4`, downloads), listed after every visible file, ranked lower,
  and muted; dependency and cache directories, `.env` secrets, OS clutter, and
  ignored directories over 500 files (`target/`) stay out. A workspace that is
  a subfolder of a repo now honours the repo's `.gitignore`s, so `app/target/`
  no longer fills the listing cap `[v3.14.0]`.
  The agent's `grep` and `glob` search gitignored files too, after every
  visible match, and skip the same ignored directories over 500 files unless
  the search names one (`directory="target"`, `target/doc/**`); a search that
  finds nothing says which it skipped. They apply git's rules as git does:
  nested `.gitignore`s, the ones above a subfolder search up to the repository
  root, `.git/info/exclude` and the global excludes file. Files that an editor, terminal or build
  writes into a gitignored folder now refresh Quick Open and open file tabs
  live `[v3.20.0]`.
  `grep`'s `include` filter understands `{ts,tsx}` braces as `glob` does, and
  a filter that names no file (a comma list, a path) says nothing was
  searched instead of answering "No matches" `[v3.63.0]`.
- **Search answers in one step** `[v3.63.0]` — `grep` takes `context` (0 to
  50 lines), so a search returns the lines around each match and the agent
  no longer opens the file at that spot in a second call. A result cut at
  `max_results` ends with a note: how many lines match in all and which files
  hold the rest, so a full result is no longer mistaken for a complete one.
  The search card in the transcript counts matches, shows the lines around
  them in a quieter colour with a rule between groups, and shows the note
  under the list.
