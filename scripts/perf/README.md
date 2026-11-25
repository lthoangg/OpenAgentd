# Performance benchmarks

Before/after measurements. Each script runs the same scenario against an
older checkout and the current one, so the numbers compare like with like.

```bash
scripts/perf/run-all.sh            # the latest release tag against this checkout
scripts/perf/run-all.sh <ref>      # any other baseline
scripts/perf/run-browser.sh .=a .=b                      # the browser part alone; the same build twice shows the noise
scripts/perf/run-browser.sh /tmp/oadperf/base=base .=head
```

`run-all.sh` keeps a detached worktree of the baseline in `/tmp/oadperf/base`
(`OAD_PERF_DIR` moves it and the results). Remove it with
`git worktree remove /tmp/oadperf/base`. A baseline must be from 18 Nov 2026
or later, when the agent crate's tests became one binary.

| Script | Measures |
|---|---|
| `appv3/crates/agent/tests/perf_bench.rs` (`run-backend.sh`) | Stream-store fan-out, `save_message`, turn-start heal, request-body build, OpenAI/Anthropic stream parsing, Codex provider build. Release mode; copied into the baseline tree for its run. |
| `appv3/crates/agent/tests/perf_seed_reopen.rs` + `reopen.py` | Opening a long plan-mode session the way the web client does (history page walk): requests, bytes, server time, repeated member rows. Also 60 s of idle server CPU. |
| `web_store.bench.ts` | Replaying one long streamed turn into the agent store: time and Immer drafts. |
| `web_render.bench.tsx` | Rendering 80 finished turns, then 300 streaming flushes, under happy-dom. Use the ratio, not the absolute time. |
| `run-browser.sh` → `browser_measure.mjs` | The production web bundle in Chromium against a release backend: cold opens of the home page and of a long session, the same open in a profile that visited before, switching sessions, typing, and a reply streaming at 50 words a second. Desktop (1440×900) and phone (402×874, touch, CPU slowed 4×); session opens also with every API response delayed 150 and 400 ms. |

## The browser measurement

`run-browser.sh` starts everything on its own ports and folder (the `oad/drive`
sandbox in `/tmp/oad-perf-drive` with a release backend and the model stub),
seeds it through the API (`browser_seed.mjs`: 300 short sessions, and two
104-turn sessions with Markdown, code, tables and shell output), builds and
serves each checkout's `web/dist`, and puts `browser_proxy.mjs` between the
pages and the backend. The proxy delays every API request by the same amount,
so a response takes one delay longer and requests still queue on the
browser's own connection limit: what a phone or a second computer sees, which
loopback hides.

What keeps the numbers honest:

- Every cold open is a new browser profile. A *return* case visits once, then
  measures the second load in that profile (an app relaunch: its saved
  settings and event-feed position are there).
- With two checkouts the runs alternate, so a machine that warms up or gets
  busy moves both sides the same way. The same build twice (`.=a .=b`) is
  the check that the setup itself makes no difference.
- Times are taken inside the page: a `MutationObserver` sees each landmark
  (the composer, the newest turn, a sidebar row) enter the document and
  stamps it right after the frame that drew it, ahead of the app's queued
  work. Nothing polls the page while the clock runs. Each landmark is then
  checked once for being visible.
- A delayed run fails unless every API response took at least the delay and
  the proxy forwarded at least as many requests as the page finished.
- The interaction scenario sends messages to a session of its own, so the
  session the opens read is the same in every run.
- Each figure prints as median/min/max. A `DIFF` line marks a change *within
  spread* unless every run of one side beat every run of the other.
- The raw samples and each case's first request timeline (when each request
  was issued, how long it queued, how long the server took) go to
  `/tmp/oadperf/browser-<time>.json`.

It does not show the native shells (a phone-width Chromium with a slowed CPU
is not WebKit on an iPhone), the relay, or real model latency.

Run on an idle machine; every step runs one at a time.

## 24 Nov 2026 baseline

`run-all.sh bb9c02b2e` with head at `9a732caaf`, on an Apple M6 (12 cores)
with Chromium 156 headless; exit 0. Medians, base → head; `phone-4x` is
402×874 with touch and a 4× slower CPU.

- Backend and web benches: equal within noise (no backend change). Reopen:
  3 requests, 201,621 bytes, 0 ms idle CPU in 60 s, on both sides.

| Case | Newest turn drawn | History done | Blocked | Requests |
|---|---|---|---|---|
| desktop session, 0 ms | 188 → 187 | 118 → 79 | 3 → 4 | 37 → 36 |
| desktop session, 150 ms | 786 → 313 | 726 → 232 | 4 → 4 | 36 → 38 |
| desktop session, 400 ms | 1790 → 594 | 1729 → 485 | 5 → 11 | 36 → 37 |
| desktop return, 150 ms | 814 → 292 | 720 → 209 | 34 → 4 | 36 → 30 |
| desktop return, 400 ms | 1818 → 577 | 1726 → 465 | 33 → 9 | 36 → 31 |
| phone-4x session, 0 ms | 637 → 487 | 318 → 172 | 270 → 141 | 32 → 31 |
| phone-4x session, 400 ms | 1660 → 786 | 1403 → 572 | 264 → 147 | 32 → 33 |
| phone-4x return, 150 ms | 906 → 535 | 646 → 315 | 268 → 144 | 32 → 27 |

Times in ms. The home screen and desktop typing and streaming are unchanged
within spread. On phone-4x, the streaming long tasks go from 524 ms to 0,
the slowest typing frame from 158 to 62 ms, and the transcript draws 2,511
nodes instead of 7,007. A first open with no saved event position sends one
or two more requests (backlog), but every landmark is faster.
