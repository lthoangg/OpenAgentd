# REPORT §2

Part of the compatibility log. [`REPORT.md`](../REPORT.md) is its index and keeps the section numbers.

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

**Module kernel and plugin folders** (v3.44.0). Measured on a different,
busier machine than the table above, so compare the two columns with each
other only. Release builds of v3.43.0 and of this change ran alternately,
each start in fresh sandbox dirs with no plugin folders; median of 21 runs:

| | v3.43.0 | kernel and plugin folders |
|---|---|---|
| Cold start, spawn → `/api/health/ready` 200 (fresh DB) | 65.3 ms | 66.5 ms |
| Idle RSS 3 s after ready | 25.6 MB | 26.2 MB |

Without plugin folders the extra start-up work is the module bookkeeping
and one scan of the plugin dirs.

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
