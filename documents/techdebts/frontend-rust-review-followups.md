# Frontend + Rust shell review follow-ups

Deferred items from the full frontend/Rust-shell review (2026-07, see
`documents/adrs/0001-permissive-webview-csp-and-macos-entitlements.md` for the
security-posture decisions made at the same time). Each entry records the
evidence and the trigger for revisiting so the analysis doesn't have to be
re-done. Items the review **investigated and killed** are listed at the bottom
so they don't get re-proposed.

## Open

### CodingFileViewerPanel large-file guard

**Where:** `web/src/components/CodingFileViewerPanel.tsx` — `highlightFile()`
(~line 130) and the per-line render loop (~line 239).

**Problem:** `highlightFile` is correctly memoized on content, but runs
synchronously on the main thread over the whole file, and the text preview
renders one DOM row + gutter button per line with no virtualization. A
10k-line file means a blocking hljs pass plus ~10k DOM nodes. Functional
coverage is good (`CodingWorkspacePanel.filepreview.test.tsx`); what's missing
is a guard, not tests of existing behavior.

**Fix shape:** cap highlighted lines (e.g. first 2 000 lines highlighted,
rest plain, with a "large file" notice) or virtualize the row list; add a
large-file regression test either way.

**Revisit when:** a user reports the coding panel freezing on a big file, or
when the panel is next touched for features.

### SSE parser over-trimming

**Where:** `web/src/api/sse.ts:63` — `line.slice(5).trim()` on `data:` lines.

**Problem:** the SSE spec says strip at most one leading space after the
colon; `trim()` removes all leading/trailing whitespace. Harmless today
because every payload is JSON, but a future whitespace-significant payload
would be silently corrupted.

**Fix shape:** replace `.trim()` with a single-leading-space strip
(`chunk.startsWith(' ') ? chunk.slice(1) : chunk`) + a parser unit test with
a leading-whitespace payload.

**Revisit when:** any non-JSON SSE payload is introduced, or on the next
`sse.ts` change.

### Sidecar dylib signing (drop `disable-library-validation`)

**Where:** `desktop/src-tauri/entitlements.plist`.

**Problem:** library validation is disabled so the bundled
python-build-standalone interpreter can load third-party native extensions not
signed with our Team ID. Signing the entire sidecar tree per release would let
us drop the entitlement — the single biggest attack-surface reduction
available — but is a high recurring release cost and fragile across dependency
updates. Full analysis in ADR-0001 (rejected alternative #3).

**Revisit when:** Apple notarization requirements tighten, or the release
pipeline gains automated deep-signing anyway.

### Desktop `script-src` tightening experiment

**Where:** `desktop/src-tauri/tauri.conf.json` CSP.

**Problem/opportunity:** review evidence says dropping `http: https:` from
`script-src` is *likely* safe in production (webview loads via
`WebviewUrl::App`, i.e. asset protocol covered by `'self'`; MCP apps run in
`srcdoc` iframes with their own narrower CSP; no remote-script loads found in
`web/src`). Needs a packaged-build runtime test before shipping: production
launch, MCP app render, updater flow, external-backend windows. Dev configs
must keep `http:` for `devUrl`.

**Revisit when:** someone has a packaged-build test session available.
Sanctioned as the follow-up in ADR-0001.

## Investigated and rejected — do not re-propose without new evidence

- **TanStack Query `select` projections** for `useTeamStatusQuery` /
  `useWorkspaceFilesQuery`: no polling, tracked-property access already limits
  notifications, consumers project via `useMemo`. Not a re-render hot spot.
- **Listener-ack protocol for `window.rs` command emits**: the retry is a
  bounded `for _ in 0..5` / 100ms best-effort, and the frontend dedupes
  repeats within 450ms (`web/src/lib/desktop-commands.ts`). Complete design.
- **Shared Rust crate for mobile/desktop shells**: the apparent duplication
  has deliberately diverged (config filenames, `/api` stripping, `activate`
  semantics, iOS share sheet vs desktop opener). Truly identical code is ~4
  lines. Extraction cost exceeds the win; revisit only after a real
  divergence bug.
- **CodingFileViewerPanel "under-tested" claim**: 400+ lines of direct
  behavioral tests exist; the residual risk is the large-file guard above,
  not missing coverage.
