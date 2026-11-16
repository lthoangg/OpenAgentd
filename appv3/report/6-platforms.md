# REPORT §6

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

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
`/workspace/files/list`, `/workspace/status`, `/workspace/git-diff/view`,
`/workspace/git-diff/files` and `/{sid}/files`. The watcher publishes a debounced
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

The inspector takes one more message from the dock (v3.56.0): `show-pin`
with a comment's number scrolls that comment's element into view and
outlines it for a moment. An inspector from before ignores it, and the web
client sends it only when a comment is clicked.

`GET /api/preview/{id}/tunnel?port=<n>` (v3.23.0) lets the mobile app and a
desktop app on another computer show previews. Their native relay listens
on the device's own `127.0.0.1:<n>` and opens one WebSocket per browser
connection; each carries raw TCP to that preview's listener only, in binary
frames (a text frame closes with 1003, messages are capped at 1 MiB, 32
tunnels per preview, then 1013). The route needs an access key (desktop
token or Network-access key; a keyless server answers 403), returns 404
for an unknown preview, 400 without an upgrade, and 422 for a `port` at or
below 1024. `port` becomes a `Host` alias on the listener (4 at most), so
pages on the relay origin pass the loopback `Host` guard; foreign names
are still refused. The listener itself still binds loopback only.

A device of the server's OpenAgentd Cloud account opens the same route
through the cloud connector (v3.55.0): its request carries no key and is
authenticated by its relay session (`AuthenticatedBy::RelayDevice`), so it
works on a keyless server too. On the device, the relay tunnels to the
computer's loopback bridge with the bridge's key. The connector's hyper
server runs with `keep_alive(false)`, so its 101 says
`connection: upgrade, close`; the bridge (`native/cloud/src/bridge.rs`)
answers its own client with a plain `connection: upgrade`, which WebSocket
clients that compare the whole value expect.

`wss://` upstreams are relayed (v3.55.0): an `https` dev server's WebSocket
goes over TLS with whatever certificate the server presents, as its page
requests already do. Targets are loopback only, so there is no network path
to impersonate one.

Not done: previews from a plain browser on another device, and headless
capture.
