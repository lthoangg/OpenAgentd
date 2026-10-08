# OpenAgentd v3 (Rust) — migration status and v2 vs v3 benchmark

Status as of this run: every v2 surface is ported. That covers the HTTP API,
SSE, WebSockets, the desktop sidecar contract, the full `openagentd` CLI,
providers (including codex/copilot/grok/bedrock/vertexai), user plugins
through an embedded QuickJS host for TypeScript/JavaScript plugin files
(§5), provider and MCP OAuth, multimodal tools, LSP, OTEL spans, file
logging, Alembic migrations and PyYAML-exact YAML. v3 contains no plugin code
and reads no Python files. v3 is now the shipped backend: the CLI release
binaries and the desktop sidecar are built from `appv3/`, and `make run` /
`make dev` start it. v2 (`app/`) is end-of-life and remains the reference
for wire and on-disk formats.
v3 shares v2's DB and config files. What still behaves differently is
listed in §3. macOS/Linux/Windows support, the in-process `gix` snapshot
engine, the new grep and live workspace refresh are in §6.

## 1. How parity was verified

**The differential harnesses (`appv3/scripts/`) and their Rust probe
examples (`crates/*/examples/`) have since been deleted.** The table below
records what they showed for the final state of the port. It can no longer
be reproduced; the ongoing check is `cargo test --workspace`. Script names
here and in §3 identify which harness produced each result.

All checks ran v2 and v3 side by side in throw-away sandboxes (`/tmp/oad-*`,
own `HOME`/XDG roots, production mode). The real DB is never touched. The
cloned DB is a migrated copy of the production clone (~880 MB, 1,016
sessions, 224k messages). Every row below is from the last full run
(`run_all_diffs.sh` against the release binary; exit 0), with one
exception. After the switch to the JS plugin host, only the harnesses that
cover changed code were re-run: plugin cases, plugin chat, plugin payloads,
scrubber, builtin OAuth and MCP OAuth. Those rows show the new numbers. The
full suite was not re-run; the other rows cover code this change did not touch.

| Harness | What it compares | Result |
|---|---|---|
| `diff_api.py` (cloned DB) | read endpoints, error envelopes, 404/422 paths | 69/69 identical |
| `diff_sessions.py` (cloned DB) | session detail, history (+paging), subagents, todos, files, questions, permissions, session list pages | 1,142/1,142 identical over a 150-session sample. An earlier full sweep (`SESSIONS=1100`) gave 8,158/8,158 over every session; it was not re-run in this pass. |
| `diff_api.py mutation_cases.json` (fresh) | 45 write flows: settings, providers, agents, MCP, skills, scheduler | 45/45 identical |
| `diff_api.py yaml_cases.json` | agent/skill frontmatter, command files, raw `denied_paths.yaml`/`multimodal.yaml` | 115/115 identical |
| `diff_chat.py` (mock OpenAI provider; plain, forced `/compact`, user plugins) | real agent turns with tools and permission prompts, SSE stream, history, undo/redo with restored files, exact provider request bodies, pruned `code.md`, span structure | 0 diffs in all three runs (the plugin run is v2 `.py` vs v3 `.ts` plugins) |
| `diff_api.py plugin_cases.json` / `oauth_cases.json` | provider plugins (catalog/usage/auth; v2 `.py` vs v3 `.ts`); builtin OAuth providers (login/usage/reset/models/disconnect) | 21/21 and 18/18 identical |
| `diff_mcp_oauth.py` | MCP OAuth + streamable HTTP transport (mock AS and MCP server) | 32/32 identical |
| `diff_plugins.py`, `diff_builtin_providers.py`, `diff_usage.py` | provider request payloads for cloned sessions (user `.ts` plugins vs v2 `.py`; codex/copilot/grok/bedrock), usage-parser fuzz | 1,600 plugin cases over a 400-session sample (the earlier all-session sweep with the native ports gave 4,076), 4,000 and 15,000 cases; 0 mismatches |
| `diff_multimodal.py` | generate_image/generate_video against mock backends | 69/69 identical (63 spans compared) |
| `diff_lsp.py` | fake LSP servers, managed ruff/ty/TypeScript installs, diagnostics hook | 218/218 identical |
| `diff_observability.py` | span JSONL fixtures → `/api/observability/*` | 33/33 identical |
| `diff_migrations.py` | Alembic replay from an empty DB and from every revision, seeded rows | 22/22 identical |
| `diff_yaml.py` | PyYAML `safe_load` (PyYAML test corpus, repo YAML, edge cases, fuzz) and `safe_dump` | load 30,722/30,728 (the other 6 are documented deviations); dump 22,303/22,303 byte-identical (9 unrepresentable values skipped) |
| `diff_prune.py` | `_prune_unknown_tools_from_file` rewrites | 2,016/2,017 (1 documented anchors case) |
| `diff_cli.py` | CLI argparse tree: help/usage at 8 widths, 3.14 colour theme, error texts, abbreviations, parsed namespace, 3,000 fuzzed argv | 3,307/3,307 identical (superseded in v3.1.0: the CLI moved to `clap`, §3) |
| `diff_cli_cmds.py` | CLI commands in seeded sandboxes: doctor, `server start/status/health/restart/stop` against live daemons, logs, auth, cleanup (dry/apply/vacuum), transfer export/import/migrate (incl. bad archives), `run` (mock provider, tool loop), lsp, and a pty run for the TTY colour paths | 24 scenarios / 81 commands, 0 diffs (outputs, file trees, DB rows, archive members) |
| `diff_scrubber.py` | secret scrubber fuzz (v2 `.py` vs `secret_scrubber.ts` in QuickJS) | seeds 11, 7, 3, 99: 20,000 cases each, 0 mismatches |
| `diff_auth.py` | access key / desktop token, 401s, exempt paths, WS 403, CORS, `--generate-token` handshake, non-loopback refusal | 0 diffs |
| `diff_terminal.py` | PTY ticket → WS → resize/input/output/exit | identical |
| route sweep (task 57) | all 118 v2 routes with dummy params | same status on every route |
| `make verify-v3` (`cargo fmt --check` with `appv3/rustfmt.toml`, `cargo clippy --all-targets -D warnings`, `cargo test --all-targets`) | unit + integration tests (incl. `jsplugin` host tests, chat-schema JSON round-trips, document/HTML conversion, a PTY round trip through `/bin/sh`) | fmt clean, 0 clippy warnings, 147 passed, 0 failed |
| document / HTML conversion vs v2 (one-off, corpus in `/tmp/oad-eval`) | `read`/`web_fetch` documents (3 real PDFs + 17 anydoc fixtures); `web_fetch` on 34 real pages (docs, articles, blogs, listings, forums, error pages) | documents 20/20 byte-identical; `format="text"` 34/34 byte-identical; `format="markdown"` median word-F1 0.993 vs v2, 29/34 pages ≥ 0.9, code-block and heading counts match on 28 and 30 pages |

I also checked the desktop sidecar contract by hand earlier.
`openagentd server serve --host 127.0.0.1 --port 0 --handshake --parent-pid <pid>`
with `OPENAGENTD_DESKTOP_TOKEN` printed the same handshake as v2, returned 401
without the token and 200 with it, and shut down cleanly when the parent died.

Later hardening changed some of this on purpose (§3, "Hardening beyond v2").
In particular, `diff_auth.py`'s CORS rows would now differ unless
`CORS_ORIGINS=["*"]` is set.

### Bugs this verification found (all fixed)

- **Undo/redo did not restore files.** `snapshot_service` had never been
  ported, so v3 undo only moved the message boundary. It is now a full port
  (`crates/agent/src/snapshot.rs`). It uses the same git calls and the same
  `{STATE_DIR}/snapshot/<sid>` repo layout as v2, so the two versions can
  share snapshot repos. The port covers queued-message snapshots, session
  delete cleanup and the 6-hourly retention sweep. Snapshot hashes come out
  byte-identical to v2's.
- **Float values drifted.** serde_json's default parser is not correctly
  rounded, so stored costs such as `0.12220750000000001` came back as
  `0.1222075`. Fixed by enabling `float_roundtrip`. Python's `round(x, n)`
  and compensated `sum()` are now ported bit-exactly (`core::pymath`,
  fuzzed against 200k CPython results). That fixed off-by-one-ulp
  `estimated_cost_usd` values.
- **Concurrent reads were serialised.** SQLite's global memory-stats mutex
  (`SQLITE_DEFAULT_MEMSTATUS=1`) was taken on every row free, so concurrent
  history reads queued behind one another. Turning it off before init made
  history throughput 5.6x higher.
- **CORS headers differed.** tower-http's `CorsLayer` behaves differently
  from Starlette, e.g. it sends `allow-credentials` without an `Origin`
  header and uses a different preflight body. Replaced it with an exact port.
- **Small wire-format differences** in the WS-reject response headers and the
  MCP stdio spawn error text.
- **`server.yaml` port parsing was stricter than v2.** v3 typed the port as
  `u16`, so a file with `port: "4082"` or `port: 70000` failed to load
  while pydantic accepts both. It now follows pydantic's lax `int`.

## 2. Benchmark

A black-box comparison (the deleted `bench.py`): same machine, same sandbox
layout, same inputs, one server at a time.

**Setup:**
- Host: Apple M1, 8 cores, 16 GB.
- Load generator: ApacheBench `-k -c 16 -n 5000` after a warm-up.
- v2: a single uvicorn process started with the venv python directly. This is
  how the CLI and desktop app ship it; there is no `uv run` wrapper in the
  timing.
- v3: `cargo build --release`, all features in this report enabled.

| metric | v2 | v3 | v3 advantage |
|---|---|---|---|
| Cold start, spawn → `/health/ready` 200 (fresh DB), p50 of 5 | 1,007 ms | 38 ms | 26x |
| Cold start (880 MB cloned DB), p50 of 5 | 950 ms | 27 ms | 35x |
| Idle RSS after start | 167 MB | 21 MB | 8x |
| RSS after the HTTP load phase¹ | 252 MB | 247 MB | ~1x |
| RSS after the chat phase | 207 MB | 77 MB | 2.7x |
| `GET /api/health/live` | 9,232 req/s (p99 2 ms) | 69,077 req/s (p99 1 ms)² | 7.5x |
| `GET /api/agents` | 857 req/s (p50 19 ms) | 11,904 req/s (p50 1 ms) | 14x |
| `GET /api/skills` | 682 req/s (p50 23 ms) | 2,730 req/s (p50 5 ms) | 4x |
| `GET /api/settings/providers` | 449 req/s (p50 35 ms) | 11,230 req/s (p50 1 ms) | 25x |
| `GET /api/agent/sessions?limit=20` (real data) | 279 req/s (p50 56 ms, p99 96) | 9,025 req/s (p50 2 ms, p99 4) | 32x |
| `GET /api/agent/{largest session}/history` | 93 req/s (p50 160 ms, p99 301) | 808 req/s (p50 17 ms, p99 97) | 8.6x |
| Total server CPU for the whole HTTP phase | 43.0 s | 22.5 s | 1.9x less CPU |
| Chat turn, sequential (POST → SSE `done`), p50 | 34.1 ms | 16.9 ms | 2.0x |
| Chat, 8 sessions in parallel × 3 turns: turn p50 | 201 ms | 49 ms | 4.1x |
| Chat, 8 × 3 throughput | 28 turns/s | 64 turns/s | 2.3x |
| Server CPU for the chat phase | 1.42 s | 0.54 s | 2.6x less CPU |

Every run had 0 failed and 0 non-2xx responses. Response sizes were identical
between v2 and v3.

Compared with the previous report, v3's cold start went from ~22 ms to
27–38 ms and idle RSS from 17 MB to 21 MB. That is the cost of the
subsystems ported since then: OTEL setup and retention, LSP manager, MCP
manager, plugins, file logging. It is still 26–35x faster than v2.

**JS plugin host footprint** (measured separately in the same sandbox env;
the table above predates the host). Median of 5 runs:

| | no plugin files | the 4 user plugins |
|---|---|---|
| Stripped binary | 29 MB before the host | 34.7 MB (oxc + rquickjs add ~5.7 MB); 43.1 MB with anydoc + trafilatura (+8.4 MB) |
| Handshake after spawn | 21 ms | 20 ms |
| Idle RSS | 19.1 MB | 19.1 MB (plugins load on first use) |
| First `GET /api/settings/providers` (loads the plugins) | 168 ms | 170 ms |
| RSS after that request | 27.9 MB | 33.5 MB (+5.6 MB for 4 runtimes and threads) |

Loading all four files in parallel takes about 10 ms: oxc transpile plus
QuickJS eval. Each plugin thread builds its HTTP client on first `fetch`.
Before that change, loading took 323 ms, because every thread loaded the
native TLS root store eagerly. One call across the JS boundary is a ~4 µs
JSON round trip. A `transformChunk` hook pays this once per stream chunk,
which is negligible next to network time.

The document and HTML converters (anydoc, trafilatura) leave start-up and
idle memory unchanged: 20 ms handshake, 18.8 MB idle RSS.

**Caveats:**

1. Post-load RSS is dominated by SQLite's 256 MiB `mmap_size`, which both
   versions set. Those are file-backed pages that the OS can reclaim, not
   heap. Idle RSS and after-chat RSS are the fairer memory comparison.
2. At ~69k req/s, `ab` (single-threaded, same machine) is probably the limit,
   not v3.
3. The chat numbers measure orchestration overhead only. The mock provider
   answers instantly. Each turn also spawns several `git` processes for
   workspace snapshots, in both versions. With a real LLM, a turn takes
   seconds of model time, so users will barely notice the chat speed-up.
   What they will notice is faster start-up, lower memory, and a UI that
   stays responsive (history and sessions endpoints) while agents run.
4. v2 runs as one worker, which is how it ships. Extra uvicorn workers would
   raise v2's throughput, not its latency or start-up time, and would
   multiply its memory. In-process state such as agent sessions and streams
   rules out multiple workers for v2 anyway.
5. `/api/skills` is the weakest result (4x). Its cost is dominated by
   `realpath` syscalls, which v2 pays too. Roots are now resolved once per
   request, but I did not optimise it further.

## 3. Remaining differences from v2

No v2 feature is left unported. Each item below is a deliberate, documented
deviation. The harnesses in §1 either did not reach it or normalised it
explicitly.

- **Performance changes to the wire format** (v3 only; v2 parity is no
  longer a goal):
  - *History pages* (`GET /api/agent/{sid}/history`,
    `api/src/routes/agent/chat.rs`). Member rows and the session-wide
    `estimated_cost_usd` / `completion_tokens` totals come only on the
    newest page and on `since` deltas. Older (`before`) pages return
    `members: []` and omit the lead's totals. v2 paged each member with
    the lead's `(seq, id)` cursor, but `seq` is per session, so every
    older page re-sent each member's newest rows, which the web client
    then prepended twice. Member pages run concurrently, and the totals
    for the lead and all members come from one grouped scan. Covered by
    `history_paging_flow` in `api/tests/http_api.rs`.
  - *JSON bytes* (`api/src/util.rs`, `db/src/codec.rs`). Responses and the
    DB's JSON columns (`extra`, `tool_calls`, tool-call `arguments`) are
    compact `serde_json`, with non-ASCII written as UTF-8. v2 used
    Python's `json.dumps` style (`", "`/`": "` separators, `\uXXXX`
    escapes), about 6× the bytes for non-ASCII text in rows and provider
    requests. Rows written in the old style still parse. History messages
    are serialized straight from the row (`db::api::MessageView`), so an
    old row's `tool_calls`/`extra` keep their stored spacing and escapes;
    JSON clients read both the same.
  - *History and session-list cursors.* `before` is `seq[|id]` (history)
    or `<created_at>|<uuid>` (sessions), and `since` is a uuid7 message
    id: the forms the server hands out. v2's bare-timestamp cursors now
    get 422. Covered by `history_paging_flow` and
    `session_pages_follow_their_cursor` (`db/tests/queries.rs`).
- **`ask_user` free text is unconditional.** The model-facing schema has no
  `custom` flag, and a `custom` arg from an older schema is ignored. The
  question payload still carries `custom: true`, because clients on an
  earlier web build only offer free text when it is set. The answer route
  takes one typed answer per question even for rows stored with
  `custom: false` (`tools/ask_user.rs`, `api/src/routes/agent/questions.rs`).
- **Queued messages ("steers") keep send order and their context.** Both
  change where rows sit in `session_messages`; old rows need no migration.
  - A new message promotes any rows still `kind='queued'` (left over from a
    failed turn) to the tail *before* it is saved, so they keep their place.
    Previously the new message was saved first and the older steers were
    promoted after it.
  - On promotion, a steer's attached rows (`extra.attachment_for_message_id`,
    its @-mention context saved at queue time) move right after it and are
    pinned, as an idle send's mention note is. Previously they stayed at the
    queue-time position, which could fall between a tool call and its
    result, and the steer was injected without them. Queued rows from older DBs
    get the same treatment. `queued_turn_start` still lists only the
    steers (`db::is_attached_row`). Covered by
    `agent/tests/queued_messages.rs`.
- **Desktop sidecar:** `desktop/src-tauri/src/sidecar.rs` launches
  `bin/openagentd server serve …`, the same subcommand as v2.
  `make -C desktop sidecar` builds it (`dist` profile) and
  `release-desktop.yml` builds it per target inside the signed app. The
  Python sidecar is gone. v3 also keeps a hidden `serve` alias of
  `server serve`, which v2 rejects. A v3 dev app bundle (macOS) is 67 MB
  against 241 MB for the v2 build. Checked against the bundled binary
  with the desktop's exact argv: handshake line in ~24 ms, generated and
  desktop-provided tokens (401 without), exit ~0.5 s after the parent
  dies (`--parent-pid`), clean SIGTERM with the WAL checkpointed, and the
  Windows handshake-file fallback. The desktop shell now restarts a
  crashed sidecar (`desktop/src-tauri/src/watchdog.rs`: backoff 1 s / 5 s
  / 15 s, at most 3 restarts per 10 minutes, same token) and reports
  `backend-error` once the budget is spent. The macOS entitlements no
  longer grant JIT, unsigned executable memory, DYLD variables or disabled
  library validation, which the Python runtime needed and the native binary
  does not.
- **Hardening beyond v2:** deliberate behaviour changes, each covered by
  tests in the named crate:
  - *Origin and Host guard* (`api/src/middleware.rs`, `core/src/auth.rs`).
    v2 defaults `CORS_ORIGINS` to `["*"]`. In v3, with `CORS_ORIGINS` unset,
    the Tauri and loopback origins are always allowed. If no access key is
    set (and no `API_ALLOW_INSECURE_LAN`), other origins are refused: a
    preflight gets 400, a request 403, and a WebSocket upgrade the WS
    reject. A `Host` header that is not a loopback name also gets 403, which
    blocks DNS rebinding. With a key, or with `API_ALLOW_INSECURE_LAN`, every
    origin is allowed as in v2, because the key is the boundary. An explicit
    `CORS_ORIGINS` list still includes the first-party origins, and
    `CORS_ORIGINS=["*"]` restores v2's behaviour.
  - *Secrets in child processes.* `server serve` reads the desktop token,
    the access key and the handshake-file path, then removes
    `core::auth::CHILD_ENV_SECRETS` from its own environment before the
    runtime starts. No child process can inherit them: shell tool,
    terminal, git, MCP servers, plugins. The shell tool's `LEAK_KEYS` is
    that same list; v2's Python/venv entries are dropped because v3 has no
    venv. Diagnostics still reports `desktop_session`.
  - *Shutdown.* v2's parent watch sends SIGTERM to its own process. v3 wakes
    the graceful-shutdown path directly, which also works on Windows. SSE
    streams close when shutdown starts, so a server with open streams exits
    in milliseconds instead of after the 5 s graceful timeout (measured:
    5.02 s → 8 ms). The registry refresh wait is capped at 1 s, and the DB
    pool is closed at exit.
  - *Panics.* A panic inside a turn becomes an ordinary turn error: the
    session moves to `error` and is free for the next turn instead of
    staying busy. A handler panic returns a plain
    `500 Internal Server Error`, as Starlette does.
  - *Message positions.* `save_message` allocates `seq` inside the INSERT,
    and releasing queued messages reads `MAX(seq)` under `BEGIN IMMEDIATE`.
    v2 reads and writes in separate statements, so concurrent saves could
    share a position.
  - *SSE contract.* `contract/sse_events.json` lists every event type per
    stream. The broadcaster and stream store check each event against it
    (debug builds panic, release builds log), and the web tests check their
    unions against the same file.
  - *Mode notes across compaction* (`agent/src/hooks/summarization.rs`).
    Compaction keeps the newest Plan/Code instruction note in context, as
    it keeps first skill loads. v2 summarises it away, and because a Plan
    note is only re-added when none exists in history, a compacted Plan
    session loses its Plan instructions until the next mode switch.
  - *Subagent modes* (`agent/src/interaction_mode.rs`). Each task sent to a
    member aligns the member with its lead's current Plan/Code mode and
    appends the same transition note. v2 copies the lead's mode only when
    the member is spawned, so a member spawned in Code mode keeps edit
    access after the lead enters Plan mode, where `delegate` is allowed.
  - *Terminals running a command* (`terminal/src/lib.rs`,
    `api/src/routes/terminal.rs`). `TerminalSession::busy` is true while
    the PTY's foreground process group is not the shell's own, that is,
    while a command runs. The idle reaper skips busy sessions, so a quiet
    dev server or build is not killed after 30 minutes. The terminal
    WebSocket sends a new `{"type": "busy", "busy": bool}` frame when this
    changes (checked every 500 ms). The web client then skips its own idle
    close and asks before the tab's close button closes the terminal.
    Windows has no foreground process group, so it never sends the frame.
    v2 has neither.
- **Version:** the workspace `Cargo.toml` version is the release version
  (from 3.0.0 on; `scripts/bump_version.sh` sets it and
  `scripts/check_version_consistency.sh` holds every other release-facing
  file to it). It shows in
  `openagentd --version`, the sidecar handshake, `/api/health/live` and
  `/api/health/ready`, the provider client headers (codex, copilot, grok),
  OTEL `telemetry.sdk.version`, and the JS plugin host's `version`.
- **Diagnostics fields:** `runtime.python="n/a"` and
  `implementation="Rust"`.
- **`.env` handling:** v3 loads `config_dir/.env` into its own process
  environment. Checks for whether a provider is configured ignore these
  injected values, the same way v2 does.
- **CLI:** since v3.1.0 the CLI is built on `clap` (`crates/cli/src/cli.rs`)
  and no longer reproduces v2's argparse help, usage and error texts. It
  keeps v2's command groups, flags, PID/log paths, exit 2 for usage errors,
  the `--version` string, and the `server serve` sidecar contract.
  Deliberate differences:
  - Errors print one `error: <message>` line on stderr and exit 1, instead
    of Python exception names or tracebacks.
  - Bare `openagentd` prints help (the name is kept for a future TUI); v2
    started the background server.
  - `server status` also runs v2's `server health` checks and exits 1 when
    the server is stopped or a check fails; `server health` is a hidden
    alias. The LAN check appears only when listening on all interfaces.
  - `server start` daemonises this binary's `server serve --host H --port P`
    with the binary's directory as cwd, and the child inherits `APP_ENV`
    (the CLI defaults it to `production`) instead of having it forced. The
    daemon keeps log records off stderr, since its stderr is appended to
    `app.log` next to the JSON sink. `--wait` exits 1 if the server dies or
    is not ready within 30 s.
  - `server logs` prints each JSON record's `text` field instead of the raw
    record, and follows the file in-process on every OS (no `tail`).
  - `run` adds `-C/--cd`, `-c/--continue`, `--session ID` and `--json`
    (one `{"event", "data"}` line per stream event, `session` first).
  - `auth list` and `auth logout <provider>` are new; `upgrade` has an
    `update` alias.
  - `doctor` loads the config `.env` before checking keys, checks the
    token file of an OAuth lead provider, and tests the configured port.
    The "Rust runtime" and "Alembic config bundled" checks are gone.
  - `cleanup` lists candidates (`--limit`, default 20), refuses `--vacuum`
    without `--apply`, and skips the pass without touching the database
    when there is no database or sessions table yet.
  - The start banner labels the URL `Server:` instead of `Open:`, because
    v3 is API-only.
  - `upgrade` runs `brew upgrade` for Homebrew installs and otherwise
    updates itself from the GitHub release archives (`cmd/self_update.rs`:
    sha256-verified, swapped by rename, `<exe>.old` on Windows). A binary
    inside the desktop app's `sidecar/bin` defers to the app updater.
  - `transfer export` writes GNU tar headers (no PAX mtime records or
    uname/gname). Member names, types, sizes and contents match v2's
    archives, and v2's `transfer import` reads them.
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
  - Plugin disconnect removes only that plugin's token dir.
- **Documents (`read`, `web_fetch`):** no deviation. v3 uses the `anydoc`
  crate that v2's `firecrawl-anydoc` wheel wraps, at the same version, with
  its PDF engine pinned to the wheel's (`pdf-inspector` 1.14.2). Output is
  byte-identical, and the encrypted / needs-OCR → vision fallback paths
  match. Error hints use anydoc's own texts, which are the Python exception
  strings.
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
- **HTTP error texts:** network-level failures carry reqwest's wording
  instead of httpx's. OAuth-flow requests send reqwest's `accept: */*`.
- **MCP:** v3 does not hold the auth lock across the whole
  body read of concurrent requests. A loopback-callback timeout followed by
  a second wait returns an immediate timeout (v2 waits another 300 s).
- **Validation texts:** pydantic `ValidationError` messages are approximated.
- **Multimodal:** API keys are read from the environment at call time (v2
  captures settings at startup).
- **LSP:** full port (`crates/tools/src/lsp/`: client, manager, managed
  Bun/TypeScript + PyPI ruff/ty installs, `lsp_install_required` event,
  `LspHook`, `/api/settings/lsp*`, `openagentd lsp status|install`).
  `diff_lsp.py` (fake stdio servers + mock PyPI/Bun host): 218/218
  identical. Deviations: "packaged" ruff/ty are looked up beside the v3
  executable (and `../bin`) instead of beside the Python interpreter; musl
  is detected at compile time; malformed server payloads (non-object
  `params`, non-list `diagnostics`) are tolerated where v2's read loop would
  die; the `lsp` navigation tool is ported but, exactly like v2, is not in
  any runtime registry. Python runs one type checker, not every installed
  one: the first of ty, pyright and pylsp that starts, with ruff (lint)
  beside it (`start_servers` in `tools/src/lsp/manager.rs`). v2 starts all
  of them, so ty and pyright both reported the same type errors.
- **OTEL:** full port without the opentelemetry crates
  (`crates/core/src/otel.rs`). It covers task-local span context, the JSONL
  span/metric writers and their export filter, retention, and
  histogram/counter repr with exemplars. The span producers are the agent
  hook, summarization, title, generate_image/video and `MCP send …` (with
  `_meta.traceparent`). `/api/observability/*` is a port of
  `observability_service` including its 5 s cache. Verified by
  `diff_observability.py` (33/33) and by span/metric structure checks in
  `diff_chat.py` (plain, `/compact` and title runs), `diff_mcp_oauth.py` and
  `diff_multimodal.py`. Deviations:
  - The `resource` block reads `telemetry.sdk.language: rust` /
    `telemetry.sdk.name: openagentd-v3`.
  - Exception events carry no `exception.stacktrace`.
  - Spans reach the file within ~1 s. v2's BatchSpanProcessor takes ~5 s.
  - Float formatting in the JSONL may differ from orjson, but the values
    are the same.
  - The counter exemplar reservoir uses its own RNG.
  - The observability endpoints skip malformed span rows (non-object lines,
    non-numeric `end_time`, non-dict `attributes`). v2 answers 500 on them.
  - `agent_run` spans carry `openagentd.workspace` (the turn's workspace
    root). `/api/observability/summary` and `/traces` accept `workspace`,
    `model` (`provider:model`), and `session` filters, applied per turn, and
    `/traces` accepts `status=error`. The summary adds `by_workspace`,
    `by_session` (top 100 by spend, labelled with the session title from the
    database), whole-window filter `facets`, and
    `daily_turns[].estimated_cost_usd`. Trace rows add `workspace`. v2 has
    none of these.
  - `chat` spans carry `gen_ai.response.time_to_first_chunk` (GenAI semconv,
    seconds to the first chunk with text, reasoning or a tool-call delta)
    and `openagentd.response.output_tokens_per_second` (output tokens over
    the first-to-last output chunk window, when it is at least 100 ms), and
    feed the `gen_ai.client.operation.time_to_first_chunk` histogram
    (`agent/src/streaming.rs` `StreamTiming`, `agent/src/hooks/otel.rs`).
    The summary adds `latency_ms.ttft_p50`/`ttft_p95`, `output_tps`
    (`p50`, `p5`), and `by_model[].ttft_p50_ms`/`output_tps_p50`. v2
    records neither.
  - The v3 MCP client now numbers JSON-RPC ids from 1 like the v2 SDK. It
    previously started at 0.
- **Alembic migrations:** v3 replays v2's chain 00000001…00000022 from
  statements captured off v2's Alembic (into
  `crates/db/resources/migrations/*.sql`; the capture script is deleted, see
  the `migrations.rs` header for how to capture a new revision). Only the
  parts v2 does in Python are code: the 00000013 slug backfill and the
  resume checks in 00000013 and
  00000019. Like v2, the replay runs with `foreign_keys=OFF` under the
  `.migrate.lock` file lock and runs `PRAGMA optimize` afterwards. Fresh
  databases are created the same way. `diff_migrations.py` starts from an
  empty DB and from every revision 1…21 with seeded rows, and compares
  schema and data: 22/22 identical. Deviations:
  - Each revision is applied in one transaction.
  - `DROP INDEX` of an index that is already gone is skipped instead of
    failing.
  - The `sqlite_master` row order of indexes that Alembic batch copies
    recreate can differ. v2 recreates them in Python set (object-id) order,
    so its own order is not stable either. The index set is the same.
  - After the replay, v3 adds `ix_session_messages_usage` on
    `session_messages (session_id, kind, json_extract(extra,
    '$.usage.cost.estimated_usd'), json_extract(extra, '$.usage.output'))`
    (`migrations::V3_INDEXES`, `CREATE INDEX IF NOT EXISTS` on every open).
    It is outside the Alembic chain: the stamp stays at `00000022`, so a v2
    build still opens the file and only sees an extra index. History loads
    sum usage from it instead of parsing every row's `extra` (249 → 19 ms on
    a 16,000-row session), and the per-model-call queued-message probe seeks
    on `(session_id, kind)` instead of scanning the session (1.8 ms → 15 µs).
  - On an open that changes no schema, `PRAGMA optimize` and the WAL
    checkpoint run in the background instead of before the server binds, so
    a WAL left by a crash no longer delays the handshake (213 MB WAL:
    381 → 71 ms to handshake). Opens that create or upgrade still run them
    inline, and shutdown runs them as before.
- **YAML dumping:** `crates/core/src/pyyaml/dump.rs` ports PyYAML's
  SafeRepresenter, Serializer and Emitter. Every YAML file v3 writes is
  byte-identical to v2's `yaml.safe_dump(..., sort_keys=False)`, including
  folding long scalars at 80 columns, `"\xE9"` escapes, `!!binary`/`!!set`
  and `...` end markers: settings/server/denied_paths/multimodal files, the
  legacy `server:` migration, the tools-prune rewrite, `transfer migrate`
  frontmatter and the redacted `server.yaml` in `transfer export`.
  `diff_yaml.py` byte-compares every loaded corpus document plus random
  trees (22,303 values in this run): 0 diffs.
- **Unknown agent tools** are pruned from the agent file on build, as
  `_prune_unknown_tools_from_file` does (`loader::prune_unknown_tools_from_file`).
  `diff_prune.py` runs 2,017 generated agent files (CRLF, comments, dates,
  int keys, invalid YAML, non-list `tools`): all identical to v2. One more
  check was added to `diff_chat.py`: an unknown tool added to `code.md`
  before the first turn is pruned identically.
  Deviation: v2 re-emits shared objects with `&id001` anchors, but v3's
  trees have no aliases, so an agent file that uses YAML anchors is
  rewritten with the aliased values expanded.
- **YAML loading:** `crates/core/src/pyyaml/load.rs` is a line-by-line port
  of PyYAML 6.0.3's pure-Python `SafeLoader`, which is what v2's
  `yaml.safe_load` runs: reader, scanner, parser, composer, resolver and
  SafeConstructor. It covers YAML 1.1 scalars (`yes`/`on`, `012` octal,
  `1:30` sexagesimal, timestamps), anchors/aliases, `<<` merge, `!!set`,
  `!!omap`, `!!binary`, Python dict-key equality (`1`/`true`/`1.0` merge),
  and the exact `MarkedYAMLError` texts with snippets. Exceptions that
  PyYAML lets escape (`ValueError` from `2024-13-01`, `KeyError` from
  `!!bool maybe`, …) keep their class, so callers reproduce v2's
  `except yaml.YAMLError` / `except ValueError` / HTTP 500 split.
  serde_yaml is gone from the workspace. Every v2 `safe_load` site uses the
  port: settings/server/denied_paths/multimodal/model_registry files, agent
  and skill frontmatter, memory pages and lint, commands/snippets.
  `diff_yaml.py` covers PyYAML's own test corpus, every YAML file and
  frontmatter in the repo, 200+ edge cases and 30k seeded fuzz/mutation
  documents. It compares typed values plus the exception class and full
  message: 0 diffs. `yaml_cases.json` covers 115 HTTP cases: agent and
  skill frontmatter, command files, and raw `denied_paths.yaml` /
  `multimodal.yaml` files. It is 115/115 identical on a fresh sandbox and
  on a reused one.
  Behaviour now matched along the way:
  - The denied-paths 422 renders pydantic's full `ValidationError` text,
    including `input_value`/`input_type`, `invalid_key` and the docs URL.
  - Malformed command/snippet frontmatter makes `/api/commands` and
    `/api/snippets` answer 500. v2 has no `except` there.
  - While `denied_paths.yaml` makes v2's default `DeniedPathsConfig`
    constructor raise, skill discovery falls back to the process cwd as
    the project root, as v2's `_project_root()` does.
  Deviations:
  - Lone surrogates from `"\uD800"` escapes become U+FFFD, because Rust
    strings cannot hold them.
  - A self-referential alias (`&a [*a]`) fails with `ValueError: Circular
    reference detected`. v2 builds a recursive list, which only breaks
    later when it is serialised.
  - Nesting beyond 494 levels raises `RecursionError`. For flow nesting
    this matches CPython's limit; for block nesting CPython stops a few
    levels earlier.
  - Integers beyond i128 become ±inf floats (Python has bignums).
  - JSON-facing callers see dates as ISO strings. Pydantic `str` fields
    therefore accept `description: 2024-01-01`, where v2 rejects it.
    Callers that type-check (memory frontmatter, model registry, denied
    paths) use the typed `Py` tree and match v2.
  - `!!set` order is insertion order. v2's order depends on string hashing,
    which varies from run to run.
- **Thinking time on assistant rows:** v3 adds `thinking_duration_ms` to
  an assistant message's `extra` when the model streamed reasoning: the
  time from its first reasoning delta to its first content or tool-call
  delta (`agent/src/hooks/publisher.rs`, tested in
  `agent/tests/thinking_duration.rs`). It is an extra key in the existing
  JSON column, not a schema change. v2 never writes it, and the web client
  shows "Thought" without a duration when it is absent.
- **Thinking level on assistant rows:** v3 adds `thinking_level` to an
  assistant message's `extra`, and to the `metadata` of its live `message`
  and `thinking` deltas: the level the turn's provider was built with (the
  session's level, else the agent's own; a session model override drops the
  agent's level, so none is recorded). Set in `agent/src/session.rs`, stamped
  in `agent/src/agent.rs` and `agent/src/hooks/publisher.rs`, tested in
  `agent/tests/turn_thinking_level.rs`. v2 never writes it, and the web
  footer then names the model alone.
- **Agent thinking level in `GET /api/agent/agents`:** v3 adds
  `thinking_level` (the agent file's level, or `null`) to each agent entry
  (`api/src/routes/agent/chat.rs`, `serialize_agent`). The web footer shows
  it next to the agent's model until the session sets its own level or model.
  v2 omits the key, and the footer then names the model alone.
- **Session plan and plan review** (`agent/src/plan.rs`,
  `agent/src/tools/plan.rs`; tested there, in `agent/tests/plan_review.rs`,
  the summarization hook and `api/tests/http_api.rs`). v2 has none of this.
  - **Tools.** The lead gets two session-injected tools, defined in
    `contract/tool_definitions.json`: `plan` (`write`, or `edit` with 1–20
    exact-match replacements; works in both modes) and `submit_plan`
    (works in both modes; in Code mode its description limits it to when
    the user asks for a review). Agent files cannot claim either name. The
    `<proposed_plan>` tag is no longer captured, detected or acted on; old
    transcripts still render it as a read-only card.
  - **Where the plan lives.** In a project (`coding`) workspace the first
    write creates `<workspace>/.openagentd/plans/<slug>-<id8>.md` (slug from
    the first `# ` heading, `id8` the last 8 hex digits of the session id,
    `-2`, `-3`, … when taken). Creating that folder also writes
    `.openagentd/plans/.gitignore` containing `*`, so plans stay out of git
    status, snapshots and commits; the file is never recreated for an
    existing folder. The target is resolved with symlinks followed and must
    stay inside the workspace and outside denied paths. Chat sessions keep
    `<data_dir>/sessions/<sid>/plan.md`, v2's location.
  - **State and edit detection.** `<data_dir>/sessions/<sid>/plan.state.json`
    pins the path and holds `revision`, the file's `sha256`,
    `agent_revision` and `approved_revision`. Every read compares the hash,
    so edits from the Plan tab, another editor or git bump the revision.
    The agent is told once: the next lead turn saves a hidden `note` row
    (`extra.plan_edit_note`) with the new plan, and a `write` over unseen
    edits is refused once. A session with only a v2 `plan.md` reads as
    revision 1; its first write in a project workspace moves it.
  - **Routes.** `GET /api/agent/sessions/{id}/plan` adds `revision`,
    `approved_revision`, `path` and `workspace_path`. New `PUT` on the same
    path saves the user's edit (`{content, base_revision}`; 409 when the plan
    moved on). `DELETE` returns 409 while a review is open and otherwise
    detaches: it removes the state file and any data-folder `plan.md` but
    keeps a workspace plan file.
  - **Review.** `submit_plan` opens a `pending_questions` row whose payload
    adds `kind: "plan_review"` and `plan_revision` (extra JSON keys, no
    schema change), and `question_asked` plus the pending-question response
    carry both fields. The answer route takes one string of at most 8,000
    characters for these rows (2,000 stays the `ask_user` limit): `Approve`
    switches a Plan-mode session to Code mode in the runtime (dropping a
    mode switch queued during the review) and emits `interaction_mode`; in
    Code mode a queued switch still applies when the resumed turn ends.
    Approval records `approved_revision` and resumes the turn with the
    approval as the tool result; anything else resumes in the active mode
    with the feedback. Edits made during the review are included in that
    result.
  - **Mode notes.** The Plan-mode note is versioned (`version 2`); a session
    whose last Plan-mode note is older gets the new instructions once, with
    a line saying they replace the `<proposed_plan>` ones.
  - **Compaction.** Compaction inserts a pinned, hidden `note` row
    (`extra.session_plan`) restating the plan before the summary unless one
    is still in context.
  - **v2 compatibility.** v2 ignores the state file, the workspace plan
    files, the extra payload and `extra` keys; the web client treats the v2
    404 as "no plan".
- **Runtime protocol and proactive memory** (`agent/src/hooks/basic.rs`,
  `memory/src/lib.rs`; tested there and in `agent/tests/runtime_protocol.rs`).
  v2 keeps its memory and git-safety rules inside the built-in `code` prompt,
  so an agent file with its own prompt loses them, and delegated agents get
  the memory block with no rules.
  - **Protocol.** `RuntimeProtocolHook` appends `runtime_protocol`
    (instruction sources, interaction mode, secrets, workspace and destructive
    git rules) to every agent's prompt, and `MemoryContextHook` puts
    `memory_protocol_lead` or `memory_protocol_member` just before
    `<openagentd_memory>`. The texts are new keys in
    `contract/builtin_prompts.json`; `coding_prompt` drops its memory,
    interaction-mode and git-safety sections and one duplicated rule. The
    member rules are prompt-level only: the `patch` tool does not refuse
    memory writes from delegated agents.
  - **Proactive saving.** The lead is told to save preferences, corrections
    and durable facts the user states, in the same turn and without asking,
    using its normal file tools; no extra model call is made. v2 allows
    `preferences.md` edits only on explicit request.
  - **Limits.** `preferences.md` is pinned up to 1,500 characters (v2: 400)
    and the memory block up to 3,000 (v2: 1,500). The "more pages" marker now
    counts against the budget, which v2 overshoots by its length.
- **Transport retries** (`agent/src/retry.rs`, `agent/src/streaming.rs`):
  a dropped connection, DNS failure or timeout retries on a flat, jittered
  3–5 s interval. The turn's model call retries without limit until the
  network is back or the user stops (its `provider_status` frames carry
  `max_attempts: null`); summarization, which cannot be stopped mid-call,
  gives up after 10 attempts. v2 backs off exponentially (up to 27 s) for 5
  attempts and then resumes the turn at most 3 times before failing with
  `ProviderConnectionError`; that resume layer is gone. HTTP errors keep
  v2's exponential backoff.
- **Cancelled tool calls** (`agent/src/agent.rs`): a call still running when
  the user stops the turn records the output it had streamed (its last
  16 KiB) followed by `Cancelled by user after N seconds.`, stores
  `duration_ms`, and ends with a `tool_end` frame carrying that text. v2
  records a bare `Cancelled by user.` and sends no `tool_end`. A call that
  never started keeps v2's text. The shell tool also flushes pending live
  output and stops its streaming timer when its call is dropped.
- **`todo_manage` clear:** `clear` without a status removes every task
  (`tools/src/todo.rs`; the `status` description in
  `contract/tool_definitions.json` says so). v2 defaults to `finished`, so
  agents resetting the board for a new plan left the old plan's pending and
  in-progress tasks behind.
- **Notifications** (`agent/src/notification.rs`, `agent/src/session.rs`):
  `desktop_notification` titles are a short status and the workspace
  directory name (`Done · openagentd`, `Failed · …`, `Needs input · …`,
  `Plan ready · …`), and each body is one line of at most 100 characters,
  cut with `…`. v2 sends `Session completed - …` / `Needs your input - …`
  and the full question or session title, newlines included. The event
  shape is unchanged. v3 also changes when a lead turn notifies: a failed
  turn sends `Failed` (kind `assistant_done`), while v2 sends nothing. A turn
  the user stopped or ended by dismissing a question sends nothing, where v2
  sends `Session completed`. A turn that ends while its subagents still run
  also sends nothing: their reports start another lead turn, and the last
  one notifies.
- **Active sessions filter:** `GET /api/agent/sessions?active=true` returns
  every top-level session that is running or waiting on a question, as one
  page (`next_cursor: null`, `has_more: false`), newest first. `limit` and
  `before` are ignored and `workspace` still narrows it
  (`api/src/routes/agent/chat.rs`, tested in `api/tests/http_api.rs`). The
  sidebar's **Needs you** list uses it, whatever page the sessions are on. v2
  ignores the parameter and returns a normal page, which the web client
  filters to the same rows.
- **Session title search:** `GET /api/agent/sessions?q=…` keeps sessions
  whose title contains the text, ignoring ASCII case, with `%` and `_`
  matched literally. It pages like the normal list
  (`db/src/queries/sessions.rs`, tested in `api/tests/http_api.rs`) and
  backs the sidebar's session search. v2 ignores `q`, and the web client then
  filters the page it gets.
- **Multi-workspace session list:** `GET /api/agent/sessions?workspaces=…`
  (repeatable) keeps sessions in any of the listed paths, newest first, and
  pages like the normal list; a `workspace` value joins the same list, and
  `active=true` is narrowed the same way (`api/src/routes/agent/chat.rs`,
  `db/src/queries/sessions.rs`, tested in `api/tests/http_api.rs`). The
  sidebar uses it to list a repository and its worktrees as one list. v2
  ignores `workspaces`, and the web client then filters the page it gets.
- **Bundled skills:** v3 bundles one skill, `self-healing`
  (`contract/builtin_skills/self-healing`). Its `SKILL.md` is an index of
  `references/*.md` files, plus the plugin typings (`jsplugin/openagentd.d.ts`).
  They describe v3 behavior: the `patch` tool, global MCP servers, the
  `multimodal.yaml` schema, and no skill discovery cache. v2's `skill-installer`
  became `references/skills.md`. Materialisation deletes files that are no
  longer bundled, so an old copy is not discovered. The files live in the
  denied cache dir, so `DeniedPaths::read_only_roots` lets `read`/`grep`/`glob`
  open them. Write tools and `shell` still refuse them, and the denied patterns
  still apply. v2 kept bundled skills in the source tree, where they were
  readable. Tests: `agent/src/skills.rs`, `tools/src/denied.rs`,
  `agent/tests/bundled_skill_references.rs`.
- **Cross-workspace messages (v3 only):** lead sessions get an injected
  `send_to_workspace` tool (`agent/src/tools/send_to_workspace.rs`,
  `agent/src/workspace_messages.rs`). It sends a user prompt to a new or
  existing top-level session in another visible registered workspace (or
  Chat), and optionally delivers that session's final answer back. The
  formats it adds:
  - The request row in the target stores `extra.sent_from`: `session_id`,
    `workspace`, `workspace_name`, `session_title`, `reply`, `hops`, and later
    `replied_at` / `error_notified_at`.
  - The reply is a queued user row in the sender with `from_agent` (the target
    workspace name) plus `extra.reply_from`: `session_id`, `workspace`,
    `workspace_name`, `status`.
  - `history.rs` adds a model-only header to both kinds of row.
  - `settings.yaml` gains `workspace_messages: {enabled}` (default `true`,
    written only when `false`), served by `GET/PUT
    /api/settings/workspace-messages`.
  - `UserMessage`/`Dispatch` take an `extra` map for the request row.

  Replies are decided when a top-level turn closes. They wait for working
  subagents. Failures send one interim notice and keep the request pending.
  A delivered answer replaces the target's own "Done" notification. Tests:
  `agent/tests/workspace_messages.rs`, unit tests in the two modules and
  `history.rs`, `db/src/queries/messages.rs`, `core/src/runtime_settings.rs`,
  and `api/tests/http_api.rs`. v2 has no equivalent.

## 4. Layout

- Workspace crates: `core`, `db`, `tools`, `terminal`, `providers`, `agent`,
  `memory`, `mcp`, `api`, `cli`, `jsplugin`. The obsolete `scheduler`, `lsp`
  and `bench` crates were removed; the scheduler lives in `agent`.
- `contract/`: v2 data v3 embeds (command/prompt catalogues, provider
  catalogue, tool definitions, mimetypes).
- The v2-vs-v3 differential harnesses and probe examples were removed after
  verification (§1).

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
    `tokenPath`. Plugins are trusted code, as in v2: `fs` and `subprocess`
    are not sandboxed. Isolation is between plugins, not from the host.
  - `credentialStore`, the error classes (`AuthError`, `HttpError`, …),
    which map onto the Rust `ProviderError`, and Python-compatible helpers
    (`pyJsonDumps`, `pyRepr`, `url.parseQuery`, ISO parsing). These keep
    output byte-identical to v2.
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

## 6. Platforms and native engines

v3 targets macOS, Linux and Windows from one code base. Per-OS behaviour is
chosen at compile time (`cfg`) or at runtime. Snapshots and grep use the same
engine on every OS; only tuning differs.

### How each OS is tested

| OS | Where | What runs |
|---|---|---|
| macOS (arm64) | local, CI `macos-26` | fmt, clippy `-D warnings`, all tests, release build, smoke test |
| Linux | local docker `rust:1.95-bookworm` (aarch64), CI `ubuntu-22.04` (x86_64) | clippy `-D warnings`, all tests; CI adds release build + smoke test |
| Windows | local: MinGW cross-compile + Wine 9 under Rosetta amd64 docker; CI `windows-2025` | clippy `-D warnings` (cross); tests as real `.exe`s under Wine; CI runs the full suite natively |

CI: `.github/workflows/appv3.yml` (fmt on Linux only; clippy, test, release
build and a smoke test of `--version`, the sidecar handshake and
`/api/health/ready` on all three).

Wine is a stand-in, not the real thing. Under Wine every test passes except
for these known Wine limits:
- Its `powershell.exe` is a stub. v3 detects Wine
  (`core::platform::under_wine`, via `ntdll!wine_get_version`) and uses
  `cmd.exe` there.
- Its `ReadDirectoryChangesW` ignores subtree watching: only top-level
  changes arrive. Under Wine the watcher uses per-directory watches.
- Its ConPTY starts the shell but passes no shell I/O, so the terminal
  round-trip test skips itself under Wine.
- The `http_api` test, and occasionally other test binaries, crash the
  emulator (`rosetta error: invalid gdt selector index`), not the code.

Native Windows results come from the CI runner only.

### Cross-platform plumbing (`crates/core`)

- `which`: PATH lookup with `PATHEXT` and the platform PATH separator. It
  replaces six hand-rolled copies (snapshot, shell, upgrade, MCP, LSP, JS
  host).
- `home`: `home_dir`/`expanduser` with Python semantics (`USERPROFILE` on
  Windows).
- `dunce::canonicalize` everywhere, so Windows paths never carry the `\\?\`
  prefix into prompts, the DB or path comparisons.
- `proctree`: kill a child together with its descendants. On Unix it uses a
  process group (SIGTERM, then SIGKILL). On Windows it uses a Job Object with
  `KILL_ON_JOB_CLOSE`. MCP stdio servers use it.
- `proctree::hide_window`: `CREATE_NO_WINDOW` on every background spawn (git,
  shell tool, LSP, MCP, JS `subprocess`, browser openers). The desktop sidecar
  has no console, so without it each spawn would open a console window.
- CLI on Windows: `pid_alive` (OpenProcess), `hostname`
  (GetComputerNameExW), a no-echo password prompt (CONIN$ console mode),
  detached `server start` (`CREATE_NEW_PROCESS_GROUP|CREATE_NO_WINDOW`),
  `server stop` via `taskkill /T /F`, and a native `logs -f` tail.
- MCP stdio on Windows inherits the MCP SDK's `DEFAULT_INHERITED_ENV_VARS`
  list and skips the login-shell PATH probe.

### Deliberate Windows deviations from v2

- **Terminal:** v2 refuses to open terminals on Windows. v3 opens them through
  ConPTY with `pwsh`/`powershell` (`-NoLogo`) or `cmd`.
- **Denied paths:** v2 matches `**/.env` against `str(path)`, which contains
  backslashes on Windows, so the default `.env` rules never matched there. v3
  matches the `/`-separated path, case-insensitively, on Windows.
- **Shell command screening:** v2 tokenises with POSIX `shlex`, which reads
  the `\` in `C:\data\x` as an escape. On Windows v3 splits on whitespace and
  quotes and keeps backslashes, so absolute denied paths are caught.
- **JS plugins:** the module resolver accepts absolute Windows paths
  (`C:\…`, `\\server\…`) and `.\`/`..\` imports.

### Snapshots: in-process `gix`

`crates/agent/src/snapshot_gix.rs` ports v2's `git add -A` / `write-tree` /
`update-ref` / `checkout` sequence to `gix` 0.87, so no `git` binary is
needed. The repo format is byte-compatible with v2:
- same `{STATE_DIR}/snapshot/<sid>` layout and config keys;
- the index is written without the TREE extension;
- `init` probes `core.ignorecase`, sets `precomposeunicode` on macOS and
  `filemode` from `cfg!(unix)`, and honours `init.defaultBranch`.

Seeding writes the same `alternates` file that points at the workspace
repo's objects. If gix fails and `git` is installed, v3 falls back to the git
CLI. `SNAPSHOT_ENGINE=git` forces the CLI.

`gix_engine_matches_git_cli` runs five mutation rounds covering CRLF
attributes, gitignore, a large file, the exec bit, symlinks, file↔dir swaps,
stat-only changes and a nested repo (gitlink). In every round the tree gix
writes equals `git write-tree` on the same index, and restore is faithful.

Benchmark on this repo (1,773 files):

| | gix | git CLI |
|---|---|---|
| cold (first snapshot) | 67 ms | 140 ms |
| nothing changed | 15 ms | 23 ms |
| one file changed | 15 ms | 89 ms |

### Grep: linear-time and parallel

`crates/tools/src/grep.rs` compiles the pattern with the linear-time `regex`
crate. It falls back to `fancy_regex`, which has a bounded backtracking step
limit, only for lookaround and backreferences, so `(a+)+$` can no longer
stall the tool. Newlines are normalised like Python's universal newlines, so
`$` and CRLF behave as in v2. Files are walked in sorted order, then scanned
in parallel (rayon) in ordered chunks with deadline checks, so the output and
the `max_results` cut-off are deterministic on every OS. This is a small
deviation: v2 follows `os.walk`'s unsorted order.

Release build on this repo, old v3 grep vs new:

| query | old | new |
|---|---|---|
| rare literal (full scan) | 60 ms | 41 ms |
| common literal, max 100 | 45 ms | 27 ms |
| regex, max 1000 | 101 ms | 46 ms |

### Git index locks

The git panels run `git status` and `git diff` after every agent tool call.
v2 runs them plainly, so they take `.git/index.lock` to save a refreshed
index. The agent's own `git add`/`commit` then collides with them, and a
killed call (timeout, or a client abort dropping the request) strands the
lock until someone deletes it. v3 changes three things:

- The panels' read-only git calls pass `--no-optional-locks -c
  diff.autoRefreshIndex=false` (`routes/agent/files.rs`), so they never take
  the lock. `git diff` ignores `--no-optional-locks`.
- `run_git_timeout` runs git in its own task, so a dropped request never
  kills it. A timed-out git gets SIGTERM, then SIGKILL after 2 s
  (`proctree`). git removes its locks on SIGTERM.
- A cancelled `shell` call (the user stopped the turn) gets the same
  SIGTERM-then-SIGKILL, where v2 SIGKILLs the group at once.

### Live workspace refresh (`notify`)

v2 refreshes the file tree, git status and diff only after the agent's own
file tools, or on window focus. v3 also watches the workspaces the UI is
showing (`crates/api/src/watch.rs`). Watching starts on
`/workspace/files/list`, `/workspace/status`, `/workspace/git-diff/view` and
`/{sid}/files`. The watcher publishes a debounced
`workspace_files_changed` global SSE event (300 ms, at most one per 2 s
burst), and `use-global-event-stream.ts` invalidates the matching coding and
session queries. The event carries the resolved path plus every spelling the
UI used. It is an accelerator only: every endpoint still reads the disk.

| OS | Backend |
|---|---|
| macOS | one recursive FSEvents stream; kernel drops (`Rescan`) trigger a full refresh |
| Windows | one recursive `ReadDirectoryChangesW`. notify 8 drops buffer overflows silently, but an overflow only happens inside a burst whose other events already refresh the whole workspace |
| Linux / other | one non-recursive inotify watch per *non-ignored* directory, new directories followed, capped at 20,000; stops with one warning at `fs.inotify.max_user_watches` |
| NFS/SMB/9p/WSL drvfs/sshfs (Linux), or `OPENAGENTD_FS_WATCH=poll` | the same per-directory layout on notify's poll backend (3 s, ≤2,000 dirs) |

Events are filtered by `NOISE_DIR_NAMES` and the root `.gitignore`. From
`.git/` only `HEAD`, `packed-refs` and `refs/**` count. `.git/index` is
ignored because the status endpoint's own `git status` rewrites it. Up to
16 workspaces are watched. A watcher is dropped after 2 minutes idle with no
SSE client, or after 30 minutes idle regardless; the next read restarts it.
`OPENAGENTD_FS_WATCH=off` disables watching.

Not done on purpose: provider plugins still load once per process (v2
parity; hot reload would need a JS runtime lifecycle). Instruction, agent
and skill files are already re-validated by mtime on every turn.

### Web preview (`crates/preview`)

v3 only; v2 has no counterpart. `POST /api/preview` starts (or reuses) one
listener per workspace and target on `127.0.0.1:<port>`. The listener proxies
a loopback dev server (HTTP, SSE and `ws://` hot reload) or serves the
workspace as static files under the file tools' denied-path rules, and adds
`/__openagentd/inspector.js` to HTML pages for the dock's element picker and
console capture. It refuses foreign `Host` headers, never proxies to the API
port or another preview, removes the target's `X-Frame-Options` and
`frame-ancestors`, and sets its own `frame-ancestors` (loopback pages and
Tauri webviews). Listeners are capped at 8 and close after 30 minutes idle.
The app CSP gains `frame-src 'self' http://127.0.0.1:*`. The lead's
`preview` tool opens pages, reads the captured console, and drives the open
page: the inspector long-polls `/__openagentd/agent` on the preview origin
for commands (snapshot, click, fill, press, scroll, navigate, wait, inspect)
and posts results back there, so commands fail fast when no Preview tab has
the page open. `action: "chain"` runs up to 20 such commands from `steps`
in order in one call, stopping at the first failure. A virtual cursor in
the inspector's overlay glides to each acted-on element and labels the
action. Its definition lives in `crates/agent/src/tools/preview.rs`, not in
the v2 tool contract; `GET /agents` lists it for coding workspaces. Design
feedback travels inside the user message as a `<design-feedback>` block
that the web UI renders as a card; the wire format is unchanged.
Not done: `wss://` relays, LAN or mobile access, and headless capture.
