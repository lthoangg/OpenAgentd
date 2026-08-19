# web/src/ — Agent Instructions

Frontend application source: routes, API client, streaming stores, UI components, hooks, and tests.

## Where to look first

```
api/          Backend client, auth token injection, SSE parser
routes/       TanStack Router pages
components/   Reusable UI and feature components
stores/       Zustand stores for team/session/UI state
queries/      TanStack Query hooks and mutations
hooks/        Shared React hooks
utils/        Markdown, formatting, block/event helpers
__tests__/    Bun/Happy DOM tests mirroring app areas
router.ts     Route tree setup
index.css     Tailwind v4 theme/global styles
```

`hooks/use-global-event-stream.ts` owns the shared app-lifetime SSE feed
for cross-session lifecycle and metadata events. Keep chat tokens/tools in the
per-session store stream; global events should only refresh metadata, request
native notifications, request backend-owned LSP component consent through
`LspInstallPrompt`, or tell the active session to attach its chat stream.

## Common feature checks

- Backend API shape changed: update `api/client.ts`, query hooks, stores, and tests.
- SSE event changed: update `api/sse*`, block helpers in `utils/blocks.ts`, and `stores/useTeamStore*`.
- New page/route: update TanStack route setup and add focused route/component tests.
- Settings form change: check zod/client validation and matching backend schema.
- Tool rendering change: inspect `components/ToolCall*` and copy/formatting tests.

## Summarization / compaction

Context-window compaction is streamed via three SSE events (`summarization_start` → `summarization_content` → `summarization_end`) handled in `stores/useTeamStore/sse-reducer.ts`. The block utilities live in `utils/blocks.ts` (`startCompaction`, `appendCompactionContent`, `endCompaction`).

**`CompactionDivider`** (`components/CompactionDivider.tsx`) renders the inline marker and streams the summary body via `LazyMarkdownBlock`. Key rules:

- `isStreaming` defaults to `state === 'compacting'` — do **not** hardcode `false` or omit it.
- Both `AgentView` and `AgentPane` `BlockRenderer` functions forward the `isStreaming` prop they receive into `<CompactionDivider>`. Keep those in sync.
- Tests: `__tests__/components/CompactionDivider.test.tsx` (unit) and `__tests__/components/AgentView.compaction.test.tsx` (integration — `AgentView` + `AgentPane` prop forwarding).

## Commands

```bash
bun run lint
bun run typecheck
bunx tsc -p tsconfig.test.json --noEmit
bun run test
```

## Mobile touch gestures

Touch/swipe behaviour is centralised so drawers can never conflict:

- `hooks/use-edge-swipe.ts` — single controller for all mobile drawers
  (left = sidebar, right = chat-actions / coding-workspace panel).
  Guarantees **one drawer open at a time**, supports swipe-to-close,
  emits a live `drag` descriptor for finger-tracking, and commits on a
  fast fling (velocity) or fixed distance. Active only on Tauri
  iOS/Android shells.
- Opt an element out of edge swipe with `data-swipe-ignore` (e.g.
  toasts, carousels) so its own drag wins. **Every overlay primitive that
  can render on top of an open drawer must carry this** — `useEdgeSwipe`
  only knows about the sidebar/actions/coding-panel drawer trio via
  `activeDrawer`; it has no idea a dialog, action-sheet, or lightbox is
  stacked visually on top, and its close-gesture arms on *any* touch
  (not just edge-start) while a drawer is open. Already covered:
  `AppOverlay`, `components/ui/dialog.tsx`, `components/ui/sheet.tsx`,
  `SettingsModal`, `FileLightbox`, `WorkspaceFilesPanel` (mobile sheet),
  `TodosPopover` (mobile). When adding a new full-screen/overlay
  component, add `data-swipe-ignore` to its backdrop **and** panel.
- `lib/haptics.ts` — `softHapticFeedback` / `mediumHapticFeedback`, plus
  the semantic `haptic('tick'|'select'|'commit')` wrapper. No-ops off a
  touch shell; never make UX depend on haptics succeeding.
- Drag-follow drawers (`Sidebar`, `CodingSidebar`, `MobileChatActions`,
  `CodingWorkspacePanel`) accept a `mobileDragOffset`/`dragOffset` prop:
  apply it as the `x` transform with `transition: { duration: 0 }` while
  dragging, and fall back to the spring when it's `null`.
- `ImageLightbox` supports an optional `images[]` + `index` gallery with
  horizontal swipe, ←/→ keys, and chevrons; single-image callers are
  unaffected. Axis-lock keeps horizontal (navigate) and vertical
  (swipe-to-close) gestures from fighting.

When adding a new mobile panel, route it through `use-edge-swipe` rather
than hand-rolling `onTouch*` handlers.

## UI primitives (`components/ui/`)

All UI primitives are **zero external-dependency** implementations — no shadcn, no
`@base-ui/react`, no `class-variance-authority`, no `clsx`, no `tailwind-merge`.

| File | What it provides |
|---|---|
| `app-overlay.tsx` | **Unified overlay primitive** — `modal` (centred card) and `palette` (top-aligned) variants. Handles backdrop, Escape/click-outside, focus trap, safe-area insets, iOS keyboard tracking. No `sheet` variant — edge panels are component-level concerns (see `WorkspaceFilesPanel`, `CodingWorkspacePanel`). |
| `button.tsx` | Variants via plain record maps; `buttonVariants()` helper |
| `dialog.tsx` | React portal + backdrop; Escape/click-outside; focus trap; `animate-in`/`animate-out` |
| `sheet.tsx` | Same as dialog but slides in from an edge |
| `popover.tsx` | Portal-anchored via `getBoundingClientRect`; `--anchor-width` CSS var set |
| `dropdown.tsx` | Portal panel; select or action-menu mode; flip-up logic |
| `tooltip.tsx` | Absolute-positioned within `relative` wrapper; directional `slide-in-from-*` |
| `switch.tsx` | `<input type=checkbox role=switch>` in a styled label |
| `tabs.tsx` | Plain record maps for variant classes |
| `_use-deferred-unmount.ts` | `useDeferredUnmount(open, ms)` — plays exit animation before unmount |
| `lib/utils.ts` | `cn()` — 20-line inline class concatenator; no external deps |

### AppOverlay rules
- **Never** use `transform` for centering — framer-motion owns `transform`. Use `left:0; right:0; margin:auto`.
- **No `mobile-viewport` class** — overlays are `position:fixed` and track the visual viewport naturally.
- **No blur** on the AppOverlay backdrop — hard edge is the visual boundary.
  Elsewhere, subtle blur (`backdrop-blur-[1px]` / `supports-backdrop-filter:backdrop-blur-xs`)
  is allowed on static backdrops (dialog, sheet, SettingsModal), but never on
  surfaces that repaint while content changes beneath them — on iOS WebKit a
  translucent+blurred layer re-rasterises its whole backdrop on any content
  change and flickers (see the comment in `FloatingInputComposer.tsx`).
- `maxWidth` prop sets `--overlay-max-width` CSS variable (modal only); palette ignores it.
- Settings modal is the visual reference for geometry and behaviour.

**Animations** come from `tw-animate-css` (`animate-in`, `animate-out`, `fade-in-0`,
`zoom-in-95`, `slide-in-from-*`, `slide-out-to-*`). Do **not** remove it.

**Hook order rule:** `useDeferredUnmount` must always be called *before* any
conditional `return null` — place it at the top of the component, above all
`useEffect` calls, to avoid Rules-of-Hooks violations.

## Markdown rendering (`utils/markdown.tsx`)

`MarkdownBlock` renders GFM markdown via `@tanstack/markdown` (`/react` entry),
with `streamingMarkdownExtension` enabled and `frontmatter`/`headingIds` off —
see the comment on `_EXTENSIONS` for why each is set that way.
Custom component overrides live in the `components` map (memoised on `sessionId`):

| Override | Purpose |
|---|---|
| `pre` | Reads the fence language off `data-lang` and the source off the `<code>` string child, then routes to `MermaidBlock`, `MathBlock`, or `HighlightedCode` |
| `math-block` | Renders block LaTeX mathematics via `MathBlock` (KaTeX) |
| `code` | Renders inline code and intercepts math sentinels to render `MathSpan` or `MathBlock` |
| `table` | Wraps `<table>` in a `<div class="oa-table-wrap">` for bidirectional scroll on mobile |
| `a` | Forces `target="_blank"` on all links |
| `img` | Routes through `MarkdownImage` for lightbox and workspace-file proxy |

**Syntax highlighting is not part of the parse.** No `highlighter` option is
passed, so the renderer hands `pre` the raw fence text and `HighlightedCode`
(memoised on the code string) tokenises it via `utils/code-highlight.ts`. The
renderer re-parses the whole accumulated response on every streamed delta, so a
parser-level highlighter would re-highlight *every* code block on *every*
token. Keep highlighting behind that memo.

**`utils/code-highlight.ts` is the app's only highlighter.** Chat fences,
`CodingFileViewerPanel` and the `ToolCall` shell command all resolve grammars
there, so a language added to `LANGUAGES` lights up in all three at once.
Tokens carry `.th-*` classes mapped onto the `--color-syn-*` variables in
`index.css`. An unknown language is escaped and returned unstyled rather than
throwing, so callers never need a try/catch.

Two entry points: `tokenizeCode` returns tokens for rendering as React
elements (chat fences, shell commands — short input, no `innerHTML`), and
`highlightLines` returns one escaped HTML string per source line for the file
viewer, where a 512 kB file would otherwise become tens of thousands of React
elements. `highlightLines` always returns `content.split('\n').length` entries
so the gutter matches the file's own line numbers.

Adding a grammar: a bundled one costs ~100 bytes gzipped, a hand-written one a
pattern table plus tests in `__tests__/utils/code-highlight.test.ts`. Extend
`EXT_TO_LANG` in `CodingFileViewerPanel` too if a file extension should map to
it, and `TEXT_EXTENSIONS` if the viewer should treat it as text at all.

Two constraints bind every hand-written pattern table, both documented on
`patternLanguage`: patterns are ordered and first-match-wins (comments and
strings must come first, or a keyword inside a string gets classified), and
**no lookbehind** — it is a parse-time syntax error on Safari below 16.4, which
would take out the whole chat renderer rather than one fence. Use a leading
guard group instead, as the Ruby symbol pattern does for `Foo::Bar`.

Tokens are rendered as React elements, never `dangerouslySetInnerHTML` — code
arriving from a model is escaped by React. Keep it that way.

**Table scroll pattern** — `.oa-table-wrap` (defined in `index.css`) sets
`overflow-x: auto` with `-webkit-overflow-scrolling: touch` on the wrapper div,
while the `<table>` itself uses `min-width: max-content` so columns never
compress. Do not add `display: block` or `overflow` directly to `table` —
browsers treat table layout specially and it breaks column alignment.

## Chat stream scroll / attach-to-stream

`AgentView` and `AgentPane` both implement an **attach-to-stream** pattern via
`attachedRef` (a `useRef<boolean>`). Rules:

| Event | Effect on `attachedRef` |
|---|---|
| User sends a message (new `user` block) | → `true` |
| Click chevron-down button | → `true`, smooth scroll with instant fallback (see below) |
| Session id changes (`useTeamStore.sessionId`) | → `true`, instant scroll to bottom — a detach belongs to one conversation and must not leak into the next |
| Scroll event reaches `dist ≤ 40px` from bottom | → `true` — unless a wheel/touch scroll-up gesture fired within the last 250ms (`userScrollIntentUntilRef`), so small trackpad deltas can escape the auto-follow snap |
| Scroll event with `dist > 40px` AND no `data-keyboard-open` | → `false` (only if scroll direction is UP), show button |
| `wheel` with `deltaY < 0`, or `touchmove` with the finger moving down (content scrollable) | → `false` immediately, show button. Required: during heavy stream growth the ResizeObserver rewrites `scrollTop` to the bottom *before* the scroll listener runs, so scroll events never observe the upward movement — input events are the only reliable detach signal |
| Virtual keyboard opens (`data-keyboard-open` on `<html>`) | scroll event ignored — viewport shrink is not user scroll |

When `attachedRef.current === true`, a **`ResizeObserver`** on the content
element runs `el.scrollTop = el.scrollHeight` on every layout change (streaming
text, markdown reflow, image load). This is the sole auto-follow mechanism.
In `AgentPane` the content div only renders once blocks exist, so the observer
effect keys on empty ↔ populated — mount-only deps left panes that mounted
empty permanently unobserved.

**Do not use `scrollTo({ behavior: 'smooth' })` directly** — it is unreliable on
WKWebView (macOS desktop and iOS; may be instant or silently no-op), which leaves
scroll events mid-flight that falsely detach the view, or leaves the view not
scrolled at all. For auto-scroll, target the exact maximum
`Math.max(0, el.scrollHeight - el.clientHeight)` and record the resulting
`el.scrollTop`; relying on browser clamping from `scrollHeight` leaves a stale
position after layout contractions. If smooth scrolling is required for user
actions (e.g. clicking the scroll-to-bottom button), wrap it using a programmatic
scroll ref to ignore intermediate scroll events, and when the programmatic window
closes (`scrollend` or the 500ms fallback) re-check the position and jump
instantly if the smooth scroll never arrived.

The `data-keyboard-open` attribute is set/cleared by `useMobileViewportGuards`
(`hooks/use-mobile-viewport.ts`) in sync with `window.visualViewport` resize events.

## InputComposer suggestion menus (`/`, `@`, `#`)

`InputComposer.suggestions.tsx` renders three picker menus (slash commands, `@`-mentions, snippets). Their filtering, keyboard navigation, and commit actions now live in `InputComposer.suggestionEngine.ts`; `InputComposer.tsx` should stay the coordinator/layout layer.

**Positioning** — menus use `position: fixed` (not `absolute`) so they escape the `overflow: hidden` on `<main>`. Coordinates are computed from `getBoundingClientRect()` of the input bar's wrapper and stored as `{ top | bottom, left, right }` in state. `bottom` is set when the menu opens above the input; `top` when it opens below.

**Viewport height** — always use `window.visualViewport?.height ?? window.innerHeight`. On mobile `window.innerHeight` stays at the full device height when the soft keyboard is open; only `visualViewport.height` reflects the actual visible area.

**Resize events** — the effect subscribes to both `window.resize` and `window.visualViewport?.resize`. The keyboard opening fires `visualViewport` resize without triggering `window` resize, so both are needed.

## WorkspaceFilesPanel — file tree

Desktop push-layout (flex sibling of `<main>`, animates `width 0→N`); mobile fixed overlay from right below header. The tree is a **recursive `TreeNode` structure** built by `buildTree()`:

- `TreeNode` = `{ kind: 'folder', children }` | `{ kind: 'file', file }`.
- Folders sort before files; siblings sort alphabetically within each level.
- All folders default open; individual folders are collapsible via `ChevronRight` header button.
- New folders that appear mid-session (agent writes into a new directory) are auto-opened.
- `ancestorPaths(selectedPath)` ensures selecting a deeply nested file reveals it even if an ancestor was manually collapsed.
- Indentation: `depth × 12px` left padding per level.
- **No hover background** on file/folder rows — selected file = accent text only.
- Material Icon Theme SVGs (`FileTypeIcon`) for files; `folder.svg`/`folder-open.svg` for folder headers.

## FileTypeIcon

`components/FileTypeIcon.tsx` maps filenames/extensions to Material Icon Theme SVGs.

- `resolveFileIcon(name)` is exported for unit tests (the component itself is mocked in `setup.ts` since `?url` SVG imports don't run under Bun).
- Filename overrides take precedence over extensions: `Makefile`, `Dockerfile`, `.gitignore`, `.env`, `.env.example`.
- Unknown extensions fall back to `file.svg`.

## Test setup (`__tests__/setup.ts`)

- All `material-icon-theme/icons/*.svg?url` imports are stubbed to `stub:<name>.svg` strings — predictable values that `FileTypeIcon.test.tsx` asserts on.
- `@/components/FileTypeIcon` is **not** separately mocked (the SVG stubs above make the real module loadable). Tests that need the component to render (WorkspaceFilesPanel) simply get the real `FileTypeIcon` which renders `<img src="stub:*.svg">`.

## Gotchas

- Use static ESM imports and `@/` aliases.
- Tests rely on isolated module state; keep using the package test script.
- Store tests usually seed with `useStore.setState(...)` and assert via `useStore.getState()`.
- Preserve desktop token injection rules: only same-origin `/api` requests receive auth.
- `WorkspaceFilesPanel` uses `useWorkspaceFilesQuery` (TanStack Query) — wrap in `QueryClientProvider` in tests.
- Large feature components should prefer colocated hooks/modules before growing further: see `TeamChatView/use*.ts`, `InputComposer.suggestionEngine.ts`, and `InputComposer.attachments.ts` for the current house pattern.
