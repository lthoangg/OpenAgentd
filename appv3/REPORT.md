# OpenAgentd v3 (Rust): wire and on-disk compatibility log, and v2 vs v3 benchmark

Status as of this run: every v2 surface is ported. That covers the HTTP API,
SSE, WebSockets, the desktop sidecar contract, the full `openagentd` CLI,
providers (including codex/copilot/grok/bedrock/vertexai), user plugins
through an embedded QuickJS host for TypeScript/JavaScript plugin files
(§5), provider and MCP OAuth, multimodal tools, LSP, OTEL spans, file
logging, Alembic migrations and PyYAML-exact YAML. v3 contains no plugin code
and reads no Python files. v3 is now the shipped backend: the CLI release
binaries and the desktop sidecar are built from `appv3/`, and `make run` /
`make dev` start it. The Python v2 backend is end-of-life (its source is no
longer in this tree) and remains the reference for wire and on-disk formats.
v3 shares v2's DB and config files. What still behaves differently is
listed in §3. macOS/Linux/Windows support, the in-process `gix` snapshot
engine, the new grep and live workspace refresh are in §6.

## Where to record a change

Add a wire or on-disk change as a note at the top of [`report/changes.md`](report/changes.md), under
a heading that names the change and the release it ships in. This page is the
index: it keeps the section numbers that code cites, as in `REPORT.md §3`, and
`make verify-docs` fails on a citation of a number this page lacks.

## 1. How parity was verified

In [`report/1-parity.md`](report/1-parity.md).

## 2. Benchmark

In [`report/2-benchmark.md`](report/2-benchmark.md).

## 3. Remaining differences from v2

No v2 feature is left unported. Each item below is a deliberate, documented
deviation. The harnesses in §1 either did not reach it or normalised it
explicitly.

| File | What it covers |
|---|---|
| [`report/3-api-and-history.md`](report/3-api-and-history.md) | Routes, query parameters, response fields, the event streams, history payloads, error texts |
| [`report/3-agent-runtime.md`](report/3-agent-runtime.md) | Goals, plans and plan review, side questions, queued messages, retries, compaction, notifications, messages between agents |
| [`report/3-tools-and-extensions.md`](report/3-tools-and-extensions.md) | Built-in tools, providers, plugins, skills, MCP, LSP, modules |
| [`report/3-platform-and-storage.md`](report/3-platform-and-storage.md) | The CLI, the desktop sidecar, hardening, telemetry, migrations, YAML, the update API, the cloud account |

## 4. Layout

- Workspace crates: `core`, `db`, `kernel`, `tools`, `terminal`, `providers`,
  `agent`, `memory`, `mcp`, `api`, `cli`, `jsplugin`, `plugins`. The obsolete
  `scheduler`, `lsp` and `bench` crates were removed; the scheduler lives in
  `agent`.
- Embedded data (command/prompt catalogues, provider catalogue, tool
  definitions, mimetypes, SSE event names) lives in each crate's `data/`
  folder, next to the code that compiles it in.
- The v2-vs-v3 differential harnesses and probe examples were removed after
  verification (§1).

## 5. Plugins (embedded QuickJS)

In [`report/5-plugins.md`](report/5-plugins.md).

## 6. Platforms and native engines

In [`report/6-platforms.md`](report/6-platforms.md).
