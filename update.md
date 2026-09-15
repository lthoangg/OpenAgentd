# OpenAgentd improvement plan and progress

Last updated: 2026-09-14

## Goal and scope

Implement the repository-wide audit without replacing working architecture or
silently changing existing autonomy defaults.

**DX means the experience of a developer using OpenAgentd to build software.**
The priorities are starting useful work, supplying context, steering the agent,
finding sessions that need intervention, reviewing changes, and recovering
without losing work. Repository tooling improvements support those outcomes;
they are not a substitute for product DX.

The original audit contains 37 recommendations. They are tracked below so that
partial implementations are not mistaken for completion. Work is not released
or committed merely because it appears as implemented here.

## Status definitions

- **Implemented:** source changes exist and focused verification has passed.
- **Partial:** a useful part is implemented; named work remains.
- **In progress:** actively implementing or verifying.
- **Pending:** not implemented yet.
- **Research first:** requires measurement or a concrete design before changes.

## Current work

The initial safety/UX implementation batch has passed final verification.
All-branch pagination, nested-dialog keyboard focus, and direct mobile settings
navigation now pass their new regressions.

This continuation bounds tracked Git-diff process output to the response
budget and terminates the subprocess once that budget is exceeded. A truncated
tracked diff skips the untracked-file scan and diff synthesis, so it cannot add
unbounded follow-up work after the response is already full.

Workspace status now reuses porcelain-v2 upstream divergence when Git provides
it, avoiding three common follow-up processes. Its fallback combines ahead and
behind counts into one traversal while preserving the existing candidate
upstream lookup.

Workspace file, diff, status, history, and commit-diff reads now forward
TanStack Query cancellation signals into `fetch`, so a closed panel or replaced
workspace does not leave those requests in flight.

Next implementation priorities after this batch:

1. Developer workflow: useful starting tasks, visible context and review actions,
   richer attention/recovery flows, and tap-accessible file details.
2. Performance: bounded tracked Git output, fewer status probes, wider query
   cancellation, and measured telemetry/transcript scaling.
3. Safety: remaining native origin/CSP isolation and explicit runtime-enforced
   permission/budget controls.
4. Recovery: storage inspection and a complete, verified backup/restore workflow.
5. Supporting contracts, platform verification, and regression budgets.

## Safety, correctness, and reliability

| ID | Plan | Status | Progress and remaining work |
| --- | --- | --- | --- |
| 1 | Prevent tool-result artifact path traversal | Implemented | Tool-call IDs are hashed into local filenames; owner-only atomic replacement avoids following a preexisting destination symlink. Added containment tests and isolated old offload tests from stale runtime artifacts. Files: `app/agent/hooks/tool_result_offload.py`, `tests/agent/hooks/test_offload_containment.py`. |
| 2 | Prevent untracked diffs from reading outside the workspace | Implemented | Untracked file reads use `_safe_resolve`; escaping symlinks are not dereferenced. Regression covers outside content. File: `app/api/routes/agent/files.py`. |
| 3 | Correct terminal termination and input backpressure | Implemented | Child polling no longer depends on client-facing closed state; kill escalation/reaping is exercised. Writes retry partial output and wait for writable descriptors; closing preserves/drains a full output queue. Real PTY and focused backpressure tests pass. File: `app/services/terminal_service.py`. |
| 4 | Reduce native WebView trust | Pending | Native origin grants retain their existing broad local-network and HTTPS scope. Remaining: define and verify a navigation and MCP-isolation design before tightening the parent-document CSP or origin access. |
| 5 | Preserve settings drafts | Partial | Remote refreshes and save responses preserve local edits. Shared draft/editor guards ask before internal navigation or closing and warn on browser unload. Focused and built-browser nested-dialog tests pass. Remaining: explicit remote-conflict presentation, native window-close/backend-switch coverage, and any settings forms outside the shared contracts. |
| 6 | Make shared tabs keyboard-operable | Implemented | Arrow keys, Home/End, disabled-tab skipping, focus movement, and tab/panel IDs added. Behavioral keyboard regression passes. File: `web/src/components/ui/tabs.tsx`. |
| 7 | Correct Git history and graph pagination | Implemented | Linear pages use the last included SHA; all-branch pages use an explicit traversal offset so `--all` does not replay the first page. Graphs follow the same cursor. Both regression modes pass. Concurrent ref changes during all-branch pagination can still shift an offset-based view; snapshot-stable multi-ref cursors are future hardening. |
| 8 | Repair cold-cache commit loading | Implemented | Observer registration follows data/sentinel availability; explicit Load more commits action provides a fallback. Commit failures offer Retry. Focused component coverage passes. |
| 9 | Unify modal focus behavior | Implemented | Settings and Dialog use shared focus handling; only the innermost marked modal handles Tab/Escape. Disabled/hidden initial targets are skipped. Nested discard-dialog regressions pass in desktop Chromium and mobile WebKit. |
| 10 | Reliably terminate saturated stream subscribers | Implemented | Completion, replacement, and shutdown deliver a termination sentinel even when a subscriber queue is full. Added completion/shutdown regressions. File: `app/services/memory_stream_store.py`. |

## Performance and responsiveness

| ID | Plan | Status | Progress and remaining work |
| --- | --- | --- | --- |
| 11 | Reduce startup JavaScript | Partial | Interactive MCP results are lazy-loaded. Main bundle changed from approximately 1,291 kB / 378 kB gzip to 1,230 kB / 361 kB gzip, despite added functionality. Remaining: profile other optional panels and first-use latency before further splitting. |
| 12 | Enforce production bundle budgets | Implemented | Build checks the complete static startup chunk graph and fails on byte-budget violations. Unit test distinguishes failures from warnings. PR CI now builds production output. Files: `web/scripts/check-bundle-budget.mjs`, `web/package.json`, `.github/workflows/web.yml`. |
| 13 | Avoid repeated full-window telemetry scans | Research first | Design an incremental partition/trace index and measure representative histories before replacing the current reader. Preserve retention, trace filtering, and corruption handling. |
| 14 | Bound Git diff work before response truncation | Partial | Untracked diff accumulation has an aggregate cap and preserves the truncation signal. Tracked `git diff` stdout is now capped at the response budget plus one byte, with pipe draining and subprocess termination on overflow; once tracked output is truncated, the route skips the untracked scan and synthesis. Regressions cover overflowing subprocess output and the route behavior. Remaining: measure representative large repositories, including Git's pre-output diff computation and untracked synthesis costs. |
| 15 | Reduce Git status subprocess round trips | Partial | Status reuses porcelain-v2 `branch.upstream` and `branch.ab` metadata, avoiding three follow-up processes on the normal tracking-branch path. The fallback uses one `rev-list --left-right --count` traversal for both counts. Regressions cover both metadata reuse and fallback behavior. Remaining: coalesce concurrent status requests without hiding Git errors and measure large-repository status latency. |
| 16 | Keep long-session rendering bounded | Research first | Benchmark repeated history browsing; select virtualization or a sliding window only if it preserves text selection, search, and scroll anchoring. |
| 17 | Cancel obsolete queries | Partial | Session list, attention, and coding-workspace file/Git reads propagate TanStack Query `AbortSignal` values into `fetch`. Regression verifies the workspace and Git client calls. Remaining: telemetry and settings read APIs, plus backend-switch coverage. |

## Developer-facing UX and UI

| ID | Plan | Status | Progress and remaining work |
| --- | --- | --- | --- |
| 18 | Make contrast requirements executable | Partial | Input/textarea placeholders no longer dilute muted text to 60%; a solid theme-aware keyboard outline supplements decorative focus rings. Remaining: browser-computed contrast assertions, both-theme inspection, and broader state coverage. |
| 19 | Enforce touch targets through primitives | Partial | Shared buttons have coarse-pointer minimum targets and the Settings close control is enlarged on narrow layouts. The transcript scroll-to-bottom control is intentionally compact (28px) at every breakpoint, so it no longer meets the coarse-pointer minimum. Remaining: dense raw-button call sites and visual/touch parity checks. |
| 20 | Remove essential tooltip-only information | Pending | Add tap-accessible full paths, titles, and state explanations; retain tooltips as supplementary information. |
| 21 | Guide developers to their first useful task | Pending | Connect workspace/provider/model readiness to useful investigation/review starting actions. Preserve drafts and require explicit submission; never auto-run a suggested task. |
| 22 | Surface sessions needing attention | Pending | Design a durable activity model before adding cross-workspace status views. It must cover input requests, failed runs, notifications, pagination, and restart behavior without changing the normal recent-session list. |
| 23 | Standardize contextual recovery | Partial | Commit and session-activity failures have retry actions. SSE handler errors are no longer mislabeled as JSON parse errors. Remaining: consistent reconnect/provider/settings recovery and last-known-good data on other surfaces. |
| 24 | Make every mobile settings section discoverable | Implemented | A native grouped section selector exposes every settings category on mobile, preserving section identifiers and draft guards. Verified in mobile WebKit and inspected in a narrow screenshot. |
| 25 | Add explicit execution budgets and permission modes | Research first | Design opt-in read-only/approval/trusted/autonomous modes and per-run time/cost/tool-call budgets. Must be enforced in runtime boundaries and visible in UI; prompt wording alone is not a permission system. Existing autonomy defaults stay unchanged until implementation and migration are verified. |
| 26 | Expose storage, cleanup, and recovery | Pending | Build on existing artifact cleanup/config transfer: storage breakdown, safe cleanup previews, full user-data backup, and verified restore. Never treat config export alone as a complete backup. |

## Supporting engineering and verification

| ID | Plan | Status | Progress and remaining work |
| --- | --- | --- | --- |
| 27 | Test the actual shipped frontend | Pending | Add production-browser coverage for streaming, backend switching, Git workflows, accessibility assertions, and narrow/wide layouts when a browser test harness is needed again. |
| 28 | Make terminal tests hermetic | Partial | Added deterministic mocked lifecycle/backpressure regressions; existing real PTY suite passes. Remaining: controlled-shell fixtures for broad tests plus a separate user-shell compatibility suite. |
| 29 | Generate/check cross-language contracts | Pending | Add HTTP type generation and SSE/native contract fixtures without exposing development schemas in production. |
| 30 | Refactor high-risk modules by responsibility | Research first | Prioritize sidebar/workspace-panel state ownership, provider assemblers, and service-to-route dependency inversion. Preserve behavior with tests; do not split files merely to lower line counts. |
| 31 | Ratchet architecture health in CI | Pending | Establish a baseline and prevent regressions in changed modules rather than blocking all preexisting hotspots. |
| 32 | Tighten asynchronous error/lint policy | Partial | SSE callback failures are surfaced accurately; stream readers release their locks. Remaining: selective warning/lint improvements and unhandled-promise coverage, without broad suppression or a repository-wide style rewrite. |
| 33 | Align CI with cross-surface behavior | Partial | Backend changes trigger web checks; CI adds production build, budgets, and browser tests with failure artifacts. Remaining: risk-based native platform matrix and actual mobile runtime coverage. |
| 34 | Pin toolchains and automate dependency security checks | Partial | Web CI pins Bun 1.4.0. Remaining: coordinated toolchain pins across workflows and dependency/license/SBOM security gates. |
| 35 | Make configuration writes atomic and corruption-aware | Partial | Python runtime/server settings use the existing owner-only atomic writer. Native backend configuration uses temporary-file replacement and serializes in-process mutations; corrupt input is preserved and reported rather than reset. Native URLs are canonicalized and reject credentials/query/fragment data. Remaining: cross-process read-modify-write coordination and fault-injection tests for native replacement failures. |
| 36 | Reduce authentication data in URLs | Partial | Fetch-based session/global SSE uses Authorization headers. Remaining URL helper rejects unrelated origins, deduplicates credentials, and preserves fragments. Tests pass. Remaining: short-lived download/navigation credentials and review of other unavoidable URL-token uses. |
| 37 | Correct documentation and contract drift | Partial | Added this progress ledger. Feature catalogue documents verified activity/settings/Git behavior and corrects Automation save semantics; design guidance now distinguishes solid keyboard outlines from decorative rings. Remaining: other stale implementation comments and historical catalogue claims identified in the audit. |

## Verification record

These are completed runs, not a claim that the entire 37-item programme is done.

| Check | Most recent completed result |
| --- | --- |
| `make verify` | Passed after the complete implementation batch: backend lint/format/types/tests, web lint/types/tests, docs, and release-version consistency. |
| `make verify-backend` | Passed in the final portable verification, including all-branch pagination. Latest focused Git route suite: 38 passed. |
| `make verify-backend` (2026-09-06) | Passed after bounded tracked Git-diff capture/truncation and Git-status subprocess regressions. |
| Full Bun component/unit suite | 2,979 passed, 0 failed across 214 files after sidebar-search and browser-test removal. |
| Web TypeScript and oxlint | Passed in the final portable verification. |
| Production build and chunk cycles | Passed; 138 production chunks, no static cycles. |
| Startup graph budgets | Passed: 1,875,339 raw bytes, 561,671 gzip bytes; largest JS chunk 1,229,895 bytes. |
| `make verify-native` | Passed on the macOS host: shared Rust formatting/clippy/tests, desktop check/tests/clippy, mobile host check. |
| Shared native unit tests | 28 passed. |
| Desktop native unit tests | 104 passed. |
| Documentation/version validation | Passed after feature-catalogue and design updates. All release-facing versions remain 2.10.0. |
| Workspace mention/path-safety scenarios | 30 passed, 0 failed. |
| Persistence query-count scenarios | 10/10 passed. |
| `git diff --check` | Passed. |
| `make verify` (2026-09-14) | Passed after the dependency batch: Python pins (ruff 0.16.7, ty 0.0.80; 4,597 passed, 8 skipped), pinned CI actions, the web toolchain subset (3,104 tests), and desktop/mobile `cargo update` (`make verify-desktop`, `make verify-mobile`). Web production budgets stayed green (1,901,136 raw / 567,295 gzip / 1,255,002 largest chunk). The web majors that exceed an eager or chunk budget (react 19.3, zod 4.6, lucide 1.44, ext-apps 2.0, mermaid 12) were held back pending freed startup headroom. |

### Batch outcome

Implemented and verified the core containment, terminal, stream, Git pagination,
keyboard navigation, nested-modal, and mobile settings fixes. Enforced startup
bundle budgets. The complete programme is **not finished**:
partial/pending/research rows above are the remaining implementation backlog.

Visual checks have not covered dark-theme, device, live-provider, or all-workflow
validation.

## Working rules

- Reproduce behavior defects before implementation; keep new regression tests.
- Update this file after each verified batch, including failures and remaining scope.
- Keep generated browser reports/screenshots out of git.
- Do not report host-side Cargo checks as iOS/Android device validation.
- Do not report API-mocked browser tests as live-provider end-to-end coverage.
- Do not change release versions, publish, or commit unless explicitly requested.
