# REPORT §3: the CLI, the desktop sidecar, security, storage and the cloud account

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

## Deviations, one per item

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
    v2 defaults `CORS_ORIGINS` to `["*"]`. In v3 (where the variable is
    `OPENAGENTD_CORS_ORIGINS` since v3.32.0), with it unset,
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
  - *Mode, variables and `.env`* (`core/src/settings.rs`, `core/src/env.rs`,
    v3.32.0). v2 took the mode from `APP_ENV` and read `.env` from the working
    directory and `~/.config/openagentd/`. v3 lets the build pick the mode
    (release: production, debug: development), overridable with
    `OPENAGENTD_ENV`; reads only the active config dir's `.env`, which cannot
    set the mode; and moves the settings variables to the `OPENAGENTD_`
    prefix (`settings::RENAMED_ENV`), still reading the old names with a
    note. The shell tool and terminal drop `APP_ENV` and every
    `OPENAGENTD_*` variable.
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
    share a position. The lead's `ask_lead` answer is saved the same way;
    v2 inserted it at `seq` 0, so it loaded first and was dropped as an
    orphan, and the member's request ended on its own assistant message.
  - *SSE contract.* `crates/agent/data/sse_events.json` lists every event type per
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
  - *Terminals that survive the socket* (`terminal/src/lib.rs`,
    `api/src/routes/terminal.rs`). Terminal protocol v2 (`/ws?proto=2`;
    tickets answer `"protocol": 2`) detaches a session when its WebSocket
    ends instead of killing the shell. A detached session is closed after
    10 minutes (`DETACHED_GRACE`) without a reattach; the 30-minute idle
    reap and the close on shutdown are unchanged, and an exited shell's
    session is removed at once. Each session keeps the last 2 MiB of raw
    PTY output with a byte-offset `seq`. `POST /api/terminal/ticket` takes
    optional `session_id` and `since` to reattach (404 if unknown or in
    another workspace); `GET /api/terminal/sessions?workspace=` lists live
    sessions and `DELETE /api/terminal/sessions/{id}` kills one. v2
    sockets send a text `attached` frame (`session_id`, first `seq`), then
    binary output frames (8-byte big-endian `seq` + at most 64 KiB of raw
    bytes; the client decodes), `busy` (also once at the start on Unix),
    `exit`, and `error` (then close 4429, or 4404 if the session is gone).
    Clients send `input`, `resize` and `ack` (`seq` just past what they
    processed); output pauses above 512 KiB unacknowledged and resumes at
    128 KiB. Malformed or unknown frames are ignored. While detached the
    reader never blocks and drops the oldest bytes (the client sees a
    `seq` gap); while attached nothing is dropped and the PTY is held back
    once 2 MiB is unsent. A second ticket for an attached session takes it
    over and closes the older socket with 4409 "attached elsewhere".
    Without `proto=2` the original protocol is unchanged, including
    killing the shell when the socket ends or sends a non-JSON frame. v2
    has no terminal sessions that outlive a connection.
- **Version:** the workspace `Cargo.toml` version is the release version
  (from 3.0.0 on; `scripts/bump_version.sh` sets it and
  `scripts/check_version_consistency.sh` holds every other release-facing
  file to it). It shows in
  `agentd --version`, the sidecar handshake, `/api/health/live` and
  `/api/health/ready`, the provider client headers (codex, copilot, grok),
  OTEL `telemetry.sdk.version`, and the JS plugin host's `version`.
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
    with the binary's directory as cwd, and passes it this process's mode as
    `OPENAGENTD_ENV` (a release build defaults to `production`). The
    daemon keeps log records off stderr, since its stderr is appended to
    `app.log` next to the JSON sink. It always waits for the server to
    answer `/api/health/ready` before printing the stop hint and the `--qr`
    code, and exits 1 if the server dies (it prints the end of the log) or
    is not ready within 30 s; a port something else holds is refused before
    anything starts. `--wait` is accepted and changes nothing.
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
  - Every agent run writes its `agent_run` span: failed runs end it with
    status ERROR (plus `error.type`), stopped runs (including a Stop that
    keeps the partial answer) with status OK plus
    `openagentd.run.cancelled=true`, and compaction-only runs (`/compact`,
    idle compaction) with status OK. Before v3.21 only runs that produced
    an answer wrote one. `chat`, `execute_tool`, `summarization` and
    `summarization_llm_call` spans also carry `openagentd.workspace`, and
    `summarization_llm_call` carries `gen_ai.conversation.id`. The
    observability endpoints resolve a span's workspace from its turn, its
    own attribute, its trace, then its session (from spans, else the
    `chat_sessions.workspace` column), so older spans are attributed too.
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
  - v3's own revision **00000023** (v3.17.0) follows the chain, so a
    database upgraded past 00000022 no longer opens in v2 (end-of-life).
    It replaces the indexes v3 used to create on every open outside the
    chain (`V3_INDEXES`, removed), with `IF NOT EXISTS` so databases that
    already have them upgrade cleanly:
    - `ix_session_messages_usage` on `session_messages (session_id, kind,
      json_extract(extra, '$.usage.cost.estimated_usd'),
      json_extract(extra, '$.usage.output'))`. History loads sum usage from
      it instead of parsing every row's `extra` (249 → 19 ms on a
      16,000-row session), and the per-model-call queued-message probe
      seeks on `(session_id, kind)` instead of scanning the session
      (1.8 ms → 15 µs).
    - `ix_session_messages_queued` on `session_messages (session_id, seq,
      id) WHERE kind = 'queued'`.
    - The `side_questions` table for `/btw` (above): `WITHOUT ROWID`,
      clustered on `(session_id, id)` with uuid7 ids, so every query is a
      primary-key range scan with no secondary index. No foreign key;
      session delete removes the rows in its transaction.
    `migrations.rs` tests check that the replay matches the head schema
    and that a v2 database at 00000022 upgrades to 00000023.
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
- **Telemetry retention setting (v3 only):** `settings.yaml` gains
  `telemetry: {retention_days}` (0–3650, default 90, 0 keeps telemetry
  forever; written only when it differs from the default), served by
  `GET/PUT /api/settings/telemetry`.
  The response carries `retention_days`, `default_retention_days` and
  `max_retention_days`; `retention_days: null` restores the default and a
  PUT runs a sweep at once. The span and metric sweeps read the setting on
  every pass. The setting is the only source: v2's
  `OTEL_SPAN_RETENTION_DAYS` / `OTEL_METRIC_RETENTION_DAYS` /
  `OTEL_RETENTION_ENABLED` (and their `OPENAGENTD_` names) are no longer
  read; set 0 instead of disabling retention. Only
  `OPENAGENTD_OTEL_RETENTION_SWEEP_INTERVAL_HOURS` remains. Tests:
  `core/src/runtime_settings.rs` and `api/tests/http_api.rs`.
- **Cloud pushes are retried (v3 only):** a push letter whose send fails on
  the network, a 429 or a 5xx is retried (5 s, doubling to 60 s, honouring
  `retry_after`) for up to 10 minutes; a newer push for the same device and
  session replaces a queued one. Other errors drop it, as before
  (`api/src/cloud/letters.rs`). v2 has no Cloud.
- **Removing a managed worktree keeps unmerged commits (v3 only):**
  `DELETE /api/agent/workspace/worktrees` deletes the worktree's branch only
  when OpenAgentd made it (`openagentd/`, `oad/`) and every commit on it is
  on another local or remote-tracking branch (`git rev-list --count <branch>
  --not --exclude=<branch> --branches --remotes` is 0). A branch with
  commits of its own is kept; v2 and earlier v3 force-deleted it. The answer
  is `{removed, branch, branch_deleted, unmerged_commits}`, and `dry_run:
  true` in the body reports the same without removing anything (the web
  dialog asks first). Tests: `agent/tests/worktree_remove.rs`.
- **Desktop network access (v3 only):** `GET`/`PUT /api/desktop/network-access`
  (`api/src/routes/desktop.rs`, `api/src/network_access.rs`) lets the desktop
  shell open and close a second listener on `0.0.0.0:<port>`. The listener
  serves the same router, prefers 4082, and falls back to `4083..=4099` and
  then to a port the OS picks. Its access key is accepted alongside the
  desktop token only while the listener is open (`Policy::network_key`).
  Closing the listener revokes the key and cancels every accepted socket,
  upgraded WebSockets and SSE included. The route exists only in desktop
  sessions (`server serve` with a desktop token) and answers 404 unless the
  request carries the desktop token and comes from a loopback peer on the
  private listener. v2 had no equivalent. Tests: `api/src/network_access.rs`,
  `cli/tests/serve_shutdown.rs`.
- **OpenAgentd Cloud account (v3 only, optional):** `GET /api/cloud/status`
  and `POST /api/cloud/{join,login,login/cancel,logout,reload}`
  (`api/src/cloud/`), separate from `/api/auth/*` (model-provider sign-in).
  Health advertises `api.cloud`. A guest server never contacts the cloud:
  with no stored identity, status is `{"state":"guest"}`. A signed-in
  server keeps a presence socket and serves relay streams in-process with
  its own router (`cloud/connector.rs`): the request has no `ConnectInfo`,
  carries a `RelayPeer` marker no header can produce, is authenticated as
  `AuthenticatedBy::RelayDevice` (the rights of the LAN access key), and
  loses `Authorization`, `Cookie`, `Origin`, `Forwarded`, `X-Forwarded-*`,
  `X-Real-IP`, `Via`, `Accept-Encoding` and the access-key query parameter
  before routing. A `Host` other than `localhost` gets 400; SSE `: ping`
  frames are not relayed. The `POST` routes answer only an unproxied,
  unrelayed loopback caller on the private listener (403 otherwise). Keys
  live in `<state>/cloud/identity.json`, mode 600. `/join` takes the
  invitation link the phone shows (`{ "link" }`, never logged); `/login` is
  the 6-digit fallback. `agentd cloud join|login|status|logout` manages the
  same identity (`join` reads the link without echo), and `agentd server status`
  adds a `Cloud:` line only when signed in. Protocol: `contract/tunnel.md`.
  Tests: `api/src/cloud/connector.rs`, `api/tests/cloud_routes.rs`,
  `api/tests/cloud_e2e.rs`, `native/cloud/tests/`.

## Server update API (v3 only)

- **`GET /api/server/update`** (new, capability `api.server_update`):
  `{current, latest, available, can_upgrade, method, reason, check_error,
  in_progress, release_url, log, last}`. `latest` is cached for an hour (five
  minutes after a failed check; `?refresh=true` skips the cache). `reason` is
  `desktop_sidecar`, `foreground` or `unsupported_platform` when
  `can_upgrade` is false: only a server `agentd server start` launched
  updates itself. `last` is the helper's `state/upgrade-status.json`.
- **`POST /api/server/update`** takes no input and answers 202 `{status:
  "started", from, target, started_at}`; 409 when an update runs or nothing
  is newer, 422 `{message, reason}` when this server cannot update itself,
  502 when the release feed fails. It starts `agentd upgrade --from-server`,
  which leaves the server's process tree (`setsid`; a new process group
  outside the job on Windows), stops the server, installs the release the
  same way `agentd upgrade` does, and starts it again. Its
  output goes to `state/logs/upgrade.log`. The feed is
  `OPENAGENTD_RELEASES_URL` on the server, never the client's
  (`cli/tests/server_update.rs` runs the whole flow against a fake feed).
- **The desktop app's server (v3.54.0):** a sidecar whose app sets
  `OPENAGENTD_DESKTOP_UPDATES=1` (macOS and Windows; not Linux, whose `.deb`
  has no updater) answers `can_upgrade: true`, `method: "desktop_app"` and
  `confirm_on_computer` (true on Windows, where the installer may wait for
  someone). `POST` then starts no helper: it records `{state: "running", by:
  "desktop_app", …}` and keeps the request for the app, and the 202 body
  gains `method`. The app collects it once with `GET
  /api/desktop/update-request` (`{request: {target, started_at} | null}`)
  and reports a failure with `PUT` `{ok, message}`; both answer 404 to
  anything but the desktop token on the private loopback listener, like
  `/api/desktop/network-access`. The app runs its own updater (signed
  release from its own feed; `target` is not passed to it). After an install
  the app restarts, and the next sidecar settles a run still `running`:
  `ok` when its version is newer than `from`, otherwise a failure. Without
  the variable a sidecar still answers `reason: "desktop_sidecar"`. An older
  client shows the button and follows the run as it does a CLI server's.

## Computer name (v3 only)

- **`GET /api/server/name`** (new in v3.54.0, capability `api.server_name`):
  `{name, default, custom}`. `default` is the host name without its domain
  (null when the system gives none) and `name` is the custom name, else the
  default.
- **`PUT /api/server/name`** `{name}` sets it for any client that may use
  the server, including a device of the account through the relay (how a
  computer signed in from the terminal is renamed). The name is kept in
  `settings.yaml` (`computer_name`) as one line of plain text: control
  characters and runs of whitespace become single spaces, text-direction
  characters (U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C) are dropped,
  and it is cut at 40
  characters. An empty name restores the default. 422 when `name` is not a
  string. The apps remember the name per computer; a signed-in computer also
  tells its account (v3.56.0), and it decides nothing (the device key does).
