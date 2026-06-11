# App-wide optimization backlog

Status: draft
Created: 2026-06-11
Scope: frontend rendering, streaming state, API payloads, desktop/mobile runtime, and test workflow.

## Priority 1 — Chat timeline and streaming render path

### 1. Memoize stable message rows and assistant turns

**Problem**

`AgentView` rebuilds render closures and derives turn structures on every stream update. Streaming content changes the tail block, but historical user blocks, tool cards, MCP app cards, and finalized assistant turns should not re-render at token cadence.

**Candidate changes**

- Wrap stable row components with `React.memo`:
  - user `BlockRenderer` rows
  - finalized `AssistantTurn`
  - tool cards whose `block.id` and status are unchanged
- Move inline `renderBlock` callbacks into memoized callbacks where possible.
- Keep the trailing live turn separate from finalized turns so token updates only touch the live tail.

**Success criteria**

- During a long stream, React Profiler shows only the live trailing turn and scroll affordances updating.
- Historical markdown/tool rows do not re-render on every text delta.

### 2. Replace turn-count windowing with real virtualization

**Problem**

`AgentView` currently limits initial rendering by turn count (`INITIAL_RENDERED_TURNS` / `TURN_RENDER_STEP`). This helps first load but still renders all visible rows in the window, and rows can be very heavy: markdown, code, images, tool output, MCP apps.

**Candidate changes**

- Introduce a virtual list for conversation rows/turns.
- Keep variable-height support and scroll-position restoration for older-history prepends.
- Treat active streaming tail as sticky/pinned at the bottom when the user is already pinned.

**Success criteria**

- 1k-message sessions remain responsive on desktop and mobile.
- Loading older history preserves scroll position.
- Streaming at bottom does not fight user scroll when unpinned.

### 3. Cache markdown rendering by block identity/content

**Problem**

Markdown blocks can be expensive due to GFM, math, syntax highlighting, image handling, and custom link/image logic. Historical markdown should be effectively immutable.

**Candidate changes**

- Cache parsed/rendered markdown by `block.id + content hash`.
- Lazy-render collapsed or offscreen code-heavy blocks.
- Avoid reprocessing finalized blocks when only streaming tail changes.

**Success criteria**

- Profiler shows markdown work only for changed blocks.
- Large histories with code fences scroll without repeated parse spikes.

## Priority 2 — Store and SSE update efficiency

### 4. Normalize message and block state

**Problem**

Large arrays encourage broad invalidation. A single streaming delta can cause subscribers to receive new top-level arrays even when most rows are unchanged.

**Candidate changes**

- Store blocks keyed by id with ordered id arrays.
- Keep live streaming blocks in a separate volatile slice.
- Use narrow Zustand selectors and shallow equality for UI subscriptions.

**Success criteria**

- SSE deltas update only the affected block id and live-turn selectors.
- Session list, sidebars, settings, and inactive panes do not re-render during token streams.

### 5. Batch high-frequency SSE events

**Problem**

Token/tool streaming can produce many events per second. Rendering per event wastes work and can cause scroll/layout churn.

**Candidate changes**

- Buffer stream deltas and flush at `requestAnimationFrame` cadence.
- Coalesce adjacent text deltas before store writes.
- Keep tool status events immediate only when they affect visible control state.

**Success criteria**

- Streaming remains visually smooth while reducing store writes/render commits.
- Stop/cancel/status controls still update promptly.

## Priority 3 — Payload and persistence efficiency

### 6. Lazy-load large tool results and artifacts

**Problem**

Shell spills, file reads, and MCP resources can be large. Loading them with normal session history increases memory and slows first render.

**Candidate changes**

- Keep history entries as metadata plus result references for large outputs.
- Fetch large result bodies on expand/open.
- Add cache invalidation by session id and artifact id.

**Success criteria**

- Session history API responses stay bounded even after large tool runs.
- Opening a large tool result is explicit and shows loading/progress.

### 7. Paginate session history by default

**Problem**

Very long sessions should not require loading all history before the user can continue.

**Candidate changes**

- Load the newest page first.
- Fetch older pages when the user scrolls near the top.
- Preserve current `loadOlderMessages` behavior while making the initial payload smaller.

**Success criteria**

- Opening a long session is dominated by the newest page, not total history size.

## Priority 4 — Startup and bundle size

### 8. Reduce initial API fan-out

**Candidate changes**

- Audit first-load requests in the browser network panel.
- Defer settings/provider/model/MCP details until panels open.
- Reuse cached stable metadata with explicit invalidation.

### 9. Code-split heavy UI surfaces

**Candidate changes**

- Lazy-load settings, MCP app viewer, provider setup, coding sidebar subpanels, and rarely used dialogs.
- Add bundle analysis to track chunk growth.

## Priority 5 — Mobile and desktop runtime polish

### 10. Mobile scroll/keyboard performance pass

**Candidate changes**

- Batch visual viewport updates.
- Verify safe-area and keyboard avoidance on iOS WKWebView and Android WebView.
- Avoid heavy timeline work during touch scroll.

### 11. Desktop sidecar startup audit

**Candidate changes**

- Cache PATH/environment discovery where safe.
- Reduce repeated readiness probes.
- Improve startup timing logs so regressions are measurable.

## Priority 6 — Test/developer workflow

### 12. Keep targeted frontend tests first-class

**Implemented**

Added `web` script:

```bash
bun run test:file src/__tests__/components/InputBar.test.tsx
bun run test:file src/__tests__/components/FloatingInputBar.test.tsx
```

Use this for surgical component changes instead of `bun run test -- <file>`, because the existing `test` script always includes `src/__tests__` before extra args and can unintentionally run the broad suite.

**Next candidate changes**

- Add documented `make check-web-target TEST=...` helper.
- Add performance regression tests for large timelines and high-frequency SSE streams.
