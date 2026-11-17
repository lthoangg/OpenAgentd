# Frontend Source Guide

This file adds source-level guidance to `web/AGENTS.md`.

## Change map

- Backend wire change: update `api/`, the owning `queries/` hook or `stores/`
  reducer, and focused tests.
- SSE change: inspect `api/sse*`, `utils/blocks.ts`, and
  `stores/useAgentStore/`; keep session content on per-session streams and
  lifecycle/metadata invalidation on the app-global stream.
- New page: add it under `routes/`, register it in `router.ts`, validate search
  state with the existing schemas, and add a route/component test.
- Settings change: keep zod/client validation aligned with the backend schema.
- Tool result change: update the relevant `ToolCall*` renderer and
  copy/formatting tests.

## Interaction and layout

- `hooks/use-edge-swipe.ts` arbitrates mobile drawers. New mobile panels must
  integrate with it rather than owning competing `onTouch*` gestures.
  A drawer follows the finger through `lib/drawer-motion` (DOM writes, no React
  state per touchmove): mark the panel `data-edge-drawer="<id>"` (and a scrim
  `data-edge-drawer-scrim="<id>"`) and bind it with `hooks/use-drawer-motion`.
- Overlay backdrops and panels that should win over an open drawer carry
  `data-swipe-ignore`; follow `AppOverlay`, dialog, and sheet patterns.
- Haptics are optional enhancement through `lib/haptics.ts`; UX must not depend
  on them succeeding.
- Reuse `components/ui/` primitives. In `AppOverlay`, do not use CSS transform
  for centering because motion owns that property, and do not add backdrop blur
  to streaming/repainting surfaces on iOS WebKit.
- Management surfaces (Settings, Scheduled tasks, Session settings, Keyboard
  shortcuts, the Server dialog) compose `ui/panel-section`, `ui/panel-row`,
  `ui/field`, `ui/callout` and `ui/panel-tokens` (DESIGN.md → Panels and
  management surfaces). Do not hand-roll caps strips, nested cards or ad-hoc
  notice boxes there; dense data surfaces such as Telemetry keep
  `ui/section-card`.
- Call hooks such as `useDeferredUnmount` before conditional returns.
- Tab follows DOM order; there is no roving focus across areas. Hover-revealed
  row actions must also show on `focus-within` and keep a keyboard path (F2,
  Shift+F10 via `lib/focus/item-keys.ts`, or a shortcut). Exception: sidebar
  rows deliberately take no row keys; their actions are reached by Tab to the
  focus-revealed buttons or by right-click. Use
  `focusQuietly` (`lib/focus/quiet.ts`) for focus a script hands back.

Keep the detailed scroll, compaction, gesture, suggestion-positioning, and file
tree invariants beside their implementations and regression tests rather than
duplicating them in this guide. Relevant tests live under
`__tests__/components/`, `__tests__/stores/`, and `__tests__/utils/`.

## Model-authored content

- `utils/markdown.tsx` owns streamed Markdown composition; syntax highlighting
  stays in `utils/code-highlight.ts` so it is memoized outside the parse path.
- Render model-authored code as React text/tokens. Keep the existing controlled
  KaTeX renderer path; do not pass untrusted arbitrary HTML to
  `dangerouslySetInnerHTML`. The one SVG exception is `utils/MermaidBlock.tsx`:
  Pele draws closed `mermaid` fences with links and images off, and every SVG
  goes through `utils/diagram-svg.ts` (`sanitizeDiagramSvg`) before insertion.
  Keep Pele lazy (`pele/lazy`) so the startup bundle does not grow.
- Keep table overflow on the `.oa-table-wrap` wrapper rather than applying
  block/overflow styles directly to `<table>`.
- When adding a syntax grammar, update the shared highlighter tests and any
  file-extension/text-file mappings used by the file viewer.

## State and tests

- TanStack Query owns server state; wrap query consumers in a test
  `QueryClientProvider`. Zustand store tests seed with `setState`, drive the
  public action/SSE path, and assert with `getState`.
- Tests rely on per-file module isolation; use the package scripts instead of
  broad ad-hoc Bun discovery. Shared browser/module stubs live in
  `__tests__/setup.ts`.
- Preserve auth/base-URL behavior across browser, desktop, and remote mobile
  connections when touching `api/` or platform bridges.

## State machines

A lifecycle (a run, a connection, a question card, an update, a pairing
flow) is a state machine, written out rather than spread over flags.

- **Shape.** A discriminated union of states (`kind`, with each state's data
  inside it), a union of events (`type`), and a table made with
  `defineMachine` (`lib/machine.ts`): for each state kind, the events it
  takes and the pure function that makes the next state. Name the file
  `<name>-state.ts` next to the store or hook that holds it.
- **One field.** The store (or hook) keeps the state in one field and
  changes it only as `field = machine.transition(field, event)`. Flags such
  as "working", "connected" or "show the chip" are selectors over it, never
  stored beside it. Timers and requests are effects the caller runs after a
  transition, keyed to the state they were started for.
- **Illegal moves.** An event the table does not list is a bug: under test
  it throws, in the app it is logged as `illegal_transition` and the state
  stays. A stale event that is fine to drop is listed as a move that
  returns the state unchanged, with a comment saying why. Use `can()` where
  a refusal is an ordinary outcome.
- **Register it.** Add the machine to `MACHINES` in
  `__tests__/state-writes.test.ts` (its file, its fields, where the first
  value is set). That test fails on an unregistered `defineMachine` and on a
  write that is not a transition; its `LEGACY` counts only shrink. Data a
  machine reads that any value may follow (an agent's status, mirrored from
  the server) gets one writer function instead, listed in `SINGLE_WRITER`.
- **Examples.** `stores/useAgentStore/run-state.ts` (the session run, with
  `reconcileSnapshot` as a pure verdict for a history page) and
  `question-state.ts` (the question card) show the shape, the store field,
  the selectors (`isRunLive`, `openQuestion`) and the tests beside them.
- **Test it** with a table test of its moves, one test per illegal move that
  matters, and a test that drives the real store or hook through the events.
  The session states the backend sends are listed in
  `appv3/crates/agent/data/session_states.json`; the web run state is held to
  it by `__tests__/api/session-states-contract.test.ts`.

## Checks

Run the commands in `web/AGENTS.md` (Development), then `make verify-web` from
the repository root.
