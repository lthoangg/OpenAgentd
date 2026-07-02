---
title: App Chrome (Header, Sidebar, Tauri Drag)
description: Shared header, platform detection, and window-drag plumbing across browser and Tauri desktop.
status: stable
updated: 2026-06-28
---

# App chrome

**Sources:** `web/src/components/AppHeader.tsx`, `web/src/routes/telemetry/chrome.tsx`, `web/src/components/MacTitleBar.tsx`, `web/src/hooks/use-platform.ts`, `web/src/hooks/use-tauri-drag.ts`, `desktop/src-tauri/src/main.rs`

---

## Layout

A 40 px header sits above every route. Settings and Telemetry use `AppHeader` directly; `TeamChatView` renders its own header that follows the same conventions.

```
[traffic-lights]  [🏠] [☰]  Title              ● local
```

Two CSS tokens (`web/src/index.css`):

- `--spacing-app-header: 2.5rem` — header height.
- `--spacing-mac-traffic-inset: 70px` — left inset reserved for the macOS traffic-light overlay (x=12 origin + ~58 button group).

## Platform detection

`usePlatform()` returns `{ isTauri, os, isMacOverlay }`. Detection is recomputed on every call so tests can patch `navigator` / `window` without busting the module cache. `isMacOverlay` is the only combination that needs special chrome — Windows and Linux Tauri keep their native title bars.

## Route transitions

Top-level page and layout route components are imported eagerly in `web/src/router.ts`. Do not wrap primary pages in route-level `React.lazy()` unless the route provides an in-place skeleton that preserves the surrounding shell. OpenAgentd prioritizes instant in-app navigation, especially in the Tauri desktop shell where blank Suspense transitions feel unlike native page switches.

Keep lazy loading for secondary heavy widgets instead, such as markdown rendering, optional panels, charts, or developer tools.

## Window dragging on macOS overlay

`titleBarStyle: "Overlay"` removes the native title bar but keeps the traffic-light buttons. The React app provides drag manually via `useTauriDrag`:

- Returns `{ onMouseDown }` only when running inside Tauri.
- On `mousedown`, walks `event.target.closest('button, a, input, select, textarea, [role="button"], [data-no-drag]')` to skip interactive elements; bare wrappers still drag.
- Double-click (`event.detail === 2`) calls `toggleMaximize()` for the standard macOS zoom gesture.

Why not `data-tauri-drag-region`? It steals `mousedown` from interactive descendants when applied to a parent wrapper. The manual handler restores normal click flow. See the [Tauri docs](https://v2.tauri.app/learn/window-customization/#manual-implementation-of-data-tauri-drag-region).

`MacTitleBar` adds a passive 70 × 40 corner pad over the empty traffic-light inset so users can also drag from there. It is **not** a full-width strip — that would catch every top-edge `mousedown` and pre-empt route header buttons.

Routes that don't render an `AppHeader` (notably the home splash, `web/src/routes/index.tsx`) must add their own invisible drag strip starting at `--spacing-mac-traffic-inset` so the rest of the top edge stays draggable. Gate it behind `isMacOverlay` so other platforms (native title bar) don't paint over their own chrome.

## Tauri permissions

The window's capability (`desktop/src-tauri/capabilities/default.json`) must include:

```
core:window:allow-start-dragging          ← startDragging()
core:window:allow-toggle-maximize         ← toggleMaximize() (double-click)
core:window:allow-internal-toggle-maximize
```

`core:window:default` excludes both — calls fail silently without the explicit grants.

## Traffic-light alignment

The position is set programmatically in `configure_window_chrome` (`desktop/src-tauri/src/main.rs`) because Tauri ignores `tauri.conf.json` values when the window is built from Rust. `y` is a *bottom* inset — wry's `WryWebViewParent::drawRect` resizes the native title-bar container to `button_height + y` on every redraw. For our 40 px header, **`y = 22`** centres the buttons.

**Do not call `NSWindow.setTitle` after the window is shown.** Under Tauri 2 / wry 0.55, `setTitle` triggers an AppKit titlebar relayout that resets the `_titlebarContainerView` frame, undoing the custom `y` inset and pushing the traffic lights off-centre. `syncDesktopWindowTitle` therefore only updates `document.title` (the browser tab); the native window title stays as "OpenAgentd" and is invisible inside the app.

## Sidebar and command palette

Both `Sidebar` and `CodingSidebar` draw `border-r border-(--color-border)` so the boundary between sidebar and content is unambiguous on dark themes.

On narrow desktop windows, mobile drawers and their backdrops start below the 40 px header. This keeps macOS overlay traffic-light buttons accessible while preserving the mobile drawer UX.

Session titles can be renamed directly in the sidebar by double-clicking a session row or using its pencil action. The save path is shared by normal and coding sidebars.

Cockpit and coding sidebars intentionally do not share one mixed session-list cache anymore: cockpit fetches only normal sessions, while coding fetches coding-only pages under separate query keys. This prevents the cockpit recent-session list from briefly rendering `No sessions yet` when prior conversations exist but the active cache was last populated from coding-mode navigation.

In coding mode, the desktop topbar shows `<workspace-name> · <session-title>` (workspace name bold, session title muted). On mobile the same format appears in the centre title area; the agent name sub-line previously shown there has been removed. The command palette intentionally excludes custom slash commands, Focus Chat Input, and the lead self-switch command; slash commands stay in the composer picker, `⌘I`/`Ctrl+I` still focuses the composer, and worker-agent view commands remain available.

## Chat usage meter

`TeamChatView` uses `AgentTopbar` / `TokenMeter` to show context growth in the header before the action buttons on desktop and mobile. The meter is an icon-sized SVG progress ring: current input tokens divided by the summarization trigger returned by `/api/team/agents` for the lead model. That backend value is calculated with the same model-aware threshold used by `SummarizationHook`, so models with smaller context windows no longer display the generic fallback trigger. It intentionally has no number inside the circle; hover, focus, or tap/click reveals input, trigger, percent used, output, and cache details. Mobile uses the same placement order as desktop (`usage → actions`) and does not duplicate token usage in the More drawer.
