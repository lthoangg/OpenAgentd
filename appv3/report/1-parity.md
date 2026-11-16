# REPORT §1

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

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
`agentd server serve --host 127.0.0.1 --port 0 --handshake --parent-pid <pid>`
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
