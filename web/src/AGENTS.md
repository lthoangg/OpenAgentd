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
- Overlay backdrops and panels that should win over an open drawer carry
  `data-swipe-ignore`; follow `AppOverlay`, dialog, and sheet patterns.
- Haptics are optional enhancement through `lib/haptics.ts`; UX must not depend
  on them succeeding.
- Reuse `components/ui/` primitives. In `AppOverlay`, do not use CSS transform
  for centering because motion owns that property, and do not add backdrop blur
  to streaming/repainting surfaces on iOS WebKit.
- Management surfaces (Settings, Scheduled tasks, Session settings, Keyboard
  shortcuts, Backend connection) compose `ui/panel-section`, `ui/panel-row`,
  `ui/field`, `ui/callout` and `ui/panel-tokens` (DESIGN.md → Panels and
  management surfaces). Do not hand-roll caps strips, nested cards or ad-hoc
  notice boxes there; dense data surfaces such as Telemetry keep
  `ui/section-card`.
- Call hooks such as `useDeferredUnmount` before conditional returns.
- Tab follows DOM order; there is no roving focus across areas. Hover-revealed
  row actions must also show on `focus-within` and keep a keyboard path (F2,
  Delete, Shift+F10 via `lib/focus/item-keys.ts`, or a shortcut). Use
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

## Checks

From `web/`:

```bash
bun run lint
bun run typecheck
bunx tsc -p tsconfig.test.json --noEmit
bun test --parallel
bun run build
```

Always run `bun test` with `--parallel` (`bun test --parallel <path>`) for
per-file module isolation, then run `make verify-web` from the repository root.
