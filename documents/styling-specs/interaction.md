# OpenAgentd interaction model

_Last updated: 2026-07-02_

## Rest, hover, focus

OpenAgentd controls should feel calm at rest and precise in motion.

- Rest state uses muted text and a crisp 1px border.
- Hover should gently warm the surface (`bg-(--bg-key)/30` or `/40`) without changing border thickness or causing layout jumps.
- Focus uses `focus-visible:ring-2 focus-visible:ring-(--focus-ring)/30` or `/40`.
- Disabled controls use opacity and `cursor-not-allowed`; do not add extra muted wrappers.

## Buttons

Buttons are plain `<button>` elements styled by `buttonVariants`.

- `default`: paper/card action surface.
- `primary`: strongest positive action.
- `subtle`: low-emphasis toolbar/list action.
- `ghost`: icon or contextual action with transparent rest state.
- `danger` / `danger-subtle`: destructive flows.
- `link`: inline text action.

`LongPressButton` must not inject default button styling. Variant styling is opt-in so it can be used as a navigation row.

## Inputs and textareas

Inputs, textareas, and search fields use warm input surfaces, small type, and stable borders. Avoid hover border jumps. Validation should use `aria-invalid` plus error text, not color alone.

## Selection controls

- `Switch`: pill track, warm rest state, blue checked state, white circular thumb.
- `Tabs`: custom semantic tab buttons for segmented toggles; labels can collapse to icons on narrow screens.
- `SegmentedControl`: use for binary or short enum choices in settings forms.
- `Checkbox`, `RadioGroup`, and `NumberInput`: plain semantic inputs styled with Tailwind tokens.

## Search and filtering

Use `SearchBar` for list filtering. It supports a leading icon, clear button, optional result count, loading state, and submit callback. Filter chips should be stable: clicking an active chip returns to the all/default state, and counts should not disappear mid-filter.

## Settings navigation

- Primary desktop navigation lives in the settings sidebar.
- Mobile primary navigation lives in the bottom tab bar.
- Detail/new/editor screens are drill-downs and expose a back affordance.
- Breadcrumbs are desktop-only; they are hidden on mobile to preserve vertical space.

## Motion

Prefer short color/opacity transitions. Avoid transform-heavy effects in dense settings surfaces. Loading indicators should be small and local; for restart actions, rotate the restart icon while pending.

## Keyboard model

**Source:** `web/src/lib/keyboard-shortcut.ts`, `web/src/hooks/useKeyboardShortcuts.ts`

The primary modifier is platform-aware — `⌘` on macOS, `Ctrl` on Windows/Linux — computed by `isPrimaryShortcut()` / `formatShortcut()` and applied consistently across window-level shortcuts, the Command Palette, sidebar hints, and native Tauri menu accelerators (`desktop/src-tauri/src/menu.rs`, using `CmdOrCtrl`).

| Action | Mac | Win/Linux |
|---|---|---|
| New Team Chat | `⌘N` | `Ctrl+N` |
| Toggle Sidebar | `⌘B` | `Ctrl+B` |
| Task List | `⌘T` | `Ctrl+T` |
| Workspace Files | `⌘F` | `Ctrl+F` |
| Scheduled Tasks | `⌘S` | `Ctrl+S` |
| Command Palette | `⌘P` | `Ctrl+P` |
| Focus chat input | `⌘I` | `Ctrl+I` |
| Back / Forward (history) | `⌘[` / `⌘]` | `Ctrl+[` / `Ctrl+]` |
| Session Settings | `⌘⇧A` | `Ctrl+Shift+A` |
| Settings | `⌘,` | `Ctrl+,` |
| Select all (scoped) | `⌘A` | `Ctrl+A` |

Session Settings requires Shift on both platforms because bare `⌘A`/`Ctrl+A` is normally Select All. **Scoped Select All:** when focus is inside an element marked `data-select-container` (currently: the coding workspace file preview and the cockpit workspace file viewer), `⌘A`/`Ctrl+A` selects only the content of that container instead of the entire page. Implemented in `web/src/hooks/useContainerSelectAll.ts` (registered globally in `__root.tsx`); no-ops on `ios`/`android`. View-mode cycling and session-list refresh are intentionally **palette-only** (no dedicated shortcut) — both are low-frequency actions, and freeing their letters avoids clobbering native/webview bindings (e.g. `⌘V` paste). `Command Palette` no-ops on mobile — see [`web/mobile.md`](../docs/web/mobile.md#keyboard-shortcuts-on-mobile).

**Back / Forward** (`⌘[` / `⌘]`) step backward/forward through the app's own navigation history, mirroring the identical shortcut in Safari/Chrome/Edge. Drives `router.history.back()` / `.forward()` (TanStack Router's wrapper over the real `window.history`) directly, so it works anywhere in the app — settings, telemetry, cockpit and coding sessions — not just chat, and correctly walks back over previously-visited sessions in the order they were opened. Registered globally in `__root.tsx` via `useHistoryBackForwardShortcuts()`; programmatic navigations that use `replace` (e.g. session-resolve redirects) don't add history entries, so back/forward skip over those transparently.

**Backspace guard:** Chromium/WebView2/WKWebView treat a bare `Backspace` outside of an editable element as "navigate back" by default — which would otherwise fight with the dedicated `⌘[`/`⌘]` shortcut above. This app owns its own routing, so that default is swallowed globally by `usePreventBackspaceNavigation()` (registered in `__root.tsx`) — editable elements (inputs, textareas, the chat composer, contenteditable areas) are exempted so normal text editing is unaffected.
