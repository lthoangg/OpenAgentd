---
title: Mobile Layout
description: Phone-first responsive design — breakpoints, safe areas, master/detail patterns, and per-component mobile behaviour.
status: stable
updated: 2026-07-15
---

# Mobile layout

The web UI targets phones at 360–430 px as the primary baseline. All layout decisions are mobile-first; desktop enhancements are additive.

---

## Breakpoint & hook

`useIsMobile()` (`web/src/hooks/use-mobile.ts`) returns `true` when `window.innerWidth < 768px` (Tailwind `md:`) or when the viewport height is `< 580px` (e.g. landscape phones). This ensures landscape-oriented phones stay locked to the single-pane mobile layout instead of breaking into the desktop/split layout. Use this hook — never raw CSS breakpoints — for JS-driven layout branches.

The hook initialises synchronously from `window.matchMedia` so the first render already knows the correct value, preventing a one-frame flash of the desktop layout on mobile devices. The shared media-query string is exported as `MOBILE_QUERY` from `use-mobile.ts` and reused by `useMobileViewportGuards` so both the layout branch and the `--app-vh` / `--app-vt` CSS-variable binding always activate and deactivate together — no split-brain on large-screen tablets that cross the 768 px threshold during an orientation change.

---

## Viewport & safe areas

`index.html` sets `viewport-fit=cover`. `index.css` provides plain CSS utility classes (not Tailwind utilities):

| Class | Property |
|-------|----------|
| `.pb-safe` | `padding-bottom: max(env(safe-area-inset-bottom), 8px)` |
| `.pt-safe` | `padding-top: env(safe-area-inset-top)` |
| `.pl-safe` | `padding-left: env(safe-area-inset-left)` |
| `.pr-safe` | `padding-right: env(safe-area-inset-right)` |

`pb-safe` enforces a minimum of 8 px so footers are never flush on non-notched devices.

Use `h-dvh` everywhere instead of `h-screen` (iOS Safari dynamic toolbar).

---

## Component behaviour

### Edge-swipe drawers (Sidebar, CodingSidebar, chat actions/coding-panel)

One controller (`useEdgeSwipe`, `web/src/hooks/use-edge-swipe.ts`) owns every
mobile drawer so only one is open at a time and swipe-to-close works from
anywhere on screen, not just the edge. Any overlay that can render on top of
an open drawer (confirmation dialogs, action-sheets, lightbox, Settings, full
screen MCP apps) **must** opt out with `data-swipe-ignore` or a drag on it is
misread as a swipe-to-close for the drawer underneath. See *Mobile touch
gestures* in [`web/src/AGENTS.md`](../../../web/src/AGENTS.md) for the full
exclusion list and rule.

### Sidebar (`Sidebar.tsx`)
- Desktop: inline flex column, animates width between 56 px (icon-only) and 256 px.
- Mobile: `position: fixed`, slides in/out via `x` transform (`w-[272px]`, `z-40`). Backdrop overlay closes it on tap.
- Mobile drawer/backdrop start below the 40 px app header so desktop window controls remain usable in small Tauri windows.
- Prop: `mobileOpen / onMobileClose` (owner: `TeamChatView`).
- `showIconOnly = !isMobile && collapsed` — icon-only mode is desktop-only.
- Command palette button hidden on mobile (`onCommandPalette` prop omitted).
- Row edit/delete actions are always visible on coarse pointers and use larger hit areas; desktop keeps hover-only compact actions.
- Pull down from the top of the recent-session list to refresh sessions; the app uses an explicit pull affordance because native overscroll refresh is disabled for cockpit stability.
- Loading rows use two-line skeletons matching the final session row shape.

### CodingSidebar (`CodingSidebar.tsx`)
Mirrors the `Sidebar` pattern for `/coding` mode:
- Desktop: inline flex column, animates width between 0 (collapsed) and 256 px via the `desktopCollapsed` prop.
- Mobile: `position: fixed`, slides in/out via `x` transform (`w-[272px]`, `z-40`). Backdrop overlay closes it on tap.
- Mobile animation sets width explicitly, so a desktop-collapsed sidebar cannot resize to an invisible drawer after crossing the breakpoint.
- Props: `desktopCollapsed`, `mobileOpen`, `onMobileClose` (owner: `TeamChatView`).
- Always mounted once — branching happens internally based on `useIsMobile()` to avoid an unmount/remount race when the hook resolves after first paint.
- Coding session restore and workspace list behavior is shared with desktop; see [Coding sessions UI](./coding-sessions.md).
- `handleSessionSelect` calls `onMobileClose()` so picking a session auto-dismisses the drawer.
- `TeamChatView`'s hamburger routes to `setMobileSidebarOpen` on coding+mobile (shares state with the regular `Sidebar` drawer).
- Workspace/session row actions grow under coarse pointers so new-session, worktree, edit, and remove buttons are finger-sized on phones.

### CodingWorkspacePanel (`CodingWorkspacePanel.tsx`)
Right-side workspace explorer for `/coding` mode.
- Desktop (`sm:` and up): inline `relative w-[440px] shrink-0` flex sibling (unchanged).
- Mobile: fixed right sheet below the 40 px header, `w-full max-w-[440px]` with `shadow-xl` — slides over the chat instead of pushing it off-screen.
- Selecting a coding file on mobile switches from the file list to the full-width preview; desktop keeps list and preview side-by-side.

### TeamChatView (`TeamChatView/index.tsx`)
- `effectiveViewMode = isMobile ? 'agent' : viewMode` — split/unified modes disabled on mobile.
- View-mode toggle, token count, split/unified controls are hidden on mobile.
- Command Palette (`⌘P`/`Ctrl+P`) shortcut no-ops on mobile. View-mode cycling has no dedicated shortcut on any platform (palette-only) — see [`interaction.md#keyboard-model`](../../styling-specs/interaction.md#keyboard-model).
- `CommandPalette` is never rendered on mobile (`!isMobile && showPalette`).
- User and queued-message bubbles can use the full chat width on mobile; `md:` and wider viewports keep the narrower desktop caps.
- Long single-agent transcripts render the newest 80 turns first and expose **Show earlier messages** to reveal older turns in chunks, reducing initial mobile layout cost.
- The **Tasks** header button toggles the todos overlay (tap again to close). All header overlays (todos, files, capabilities, scheduler, palette) are mutually exclusive on both mobile and desktop via `closeOtherMobileOverlays`; sidebar/actions/coding-panel guards remain mobile-only.

### FloatingInputBar (`FloatingInputBar.tsx`) / InputBar (`InputBar.tsx`)
- Mobile: static docked `<div>` at the bottom with `border-t`, `.pb-safe`. No drag, no localStorage position.
- On Tauri iOS/Android, `useMobileViewportGuards()` listens to `window.visualViewport` and writes `--app-vh` / `--app-vt` CSS variables to `:root` so the entire app shell resizes to the visible region as one GPU-composited unit — the bottom-docked composer rides up on the keyboard via normal flexbox without per-frame React re-renders. Keyboard detection is measured against the shell's baseline layout height (not the live `window.innerHeight`), so WebViews that shrink both values still detect keyboard occlusion correctly. While the keyboard is open the shell stays pinned at `y=0` instead of following `visualViewport.offsetTop`, avoiding iOS chat-scroll flicker. The viewport guard and the layout breakpoint use the same shared `MOBILE_QUERY` constant, so they always activate and deactivate together (no split-brain on landscape iPads).
- Desktop: draggable floating bar (existing behaviour unchanged).
- **Height reset after submit**: after sending a message the textarea collapses back to a single row immediately — `isMultiLine` state is reset synchronously and `el.style.height` is set to `'auto'` in a `requestAnimationFrame` after React flushes the value clear, so the bar never stays expanded at the old multi-line height.
- **`onFocus` / `onBlur` / `onHasContentChange`**: all three callbacks are now wired on both the mobile and desktop `<InputBar>` paths in `FloatingInputBar`. Previously they were only passed in the desktop branch, meaning the blur-timer and `hasContent` state were never updated on mobile.
- **Snippet picker on blur**: both the `@mention` and `#snippet` pickers are now closed when the textarea loses focus. Previously only the mention picker was closed, leaving the snippet picker open after blur.
- Mobile keyboard: plain `Enter` inserts a newline; users submit with the Send button. Desktop keeps `Enter` to send and `Shift+Enter` for newline.
- No swipe-to-dismiss on the input bar: a swipe-down-to-dismiss-keyboard gesture previously lived on the mobile input bar container but was removed — it fought with textarea scrolling and keyboard retract timing and misfired too often. Dismiss the keyboard by tapping outside the composer; `dismissKeyboard()` (`hooks/use-mobile-viewport.ts`) remains available for programmatic use.
- `minimize()` is no longer called on submit when `isMobile` is true, preventing the `minimized` state flag from drifting to `true` on mobile sessions (which would cause the bar to snap collapsed if the viewport later crosses the breakpoint).
- Voice input: the mic button sits beside Send on mobile and desktop. It uses the current browser/WebView speech recognizer when available; unsupported runtimes show a disabled button with a tooltip. Listening starts and stops only from button taps/clicks; no mobile-specific silence auto-stop.

### MemoryPanel, WorkspaceFilesPanel, SchedulerPanel
All three use **master/detail** on mobile — one pane at a time, never side-by-side:

| Panel | List pane | Detail pane | Back trigger |
|-------|-----------|-------------|--------------|
| `MemoryPanel` | File tree | Editor | `ArrowLeft` icon button in header |
| `WorkspaceFilesPanel` | Directory tree | File preview | `ArrowLeft` icon button in header |
| `SchedulerPanel` | Task list (+ `+` icon to create) | Detail / Create form | `ArrowLeft` icon button in header |

Desktop: fixed-width left column + flex-1 right column (unchanged).

`SchedulerPanel` previously used `lg:w-96` / `hidden lg:flex` (viewport breakpoints). These were replaced with explicit `isMobile` branches — the panel's own width (`min(960px, 90vw)`) is narrower than 1024 px on mobile so `lg:` never fired.

### MCP app artifacts (`MCPAppResult.tsx`)

- Inline cards include a host-side fullscreen button; embedded apps can still request fullscreen through the bridge.
- Fullscreen mode is edge-to-edge on desktop/web. In Tauri mobile shells it applies `env(safe-area-inset-*)` padding so canvases avoid the notch/Dynamic Island and home indicator.
- Header/caption chrome is hidden in fullscreen so the iframe owns the available screen area.
- The bridge receives live theme updates when the shell theme changes.

### Full-screen sheet modals (`SchedulerPanel`, `CommandPalette`, `SessionSettingsPanel`)
Centered modal surfaces switch to a full-bleed sheet on mobile:
- Base: `fixed inset-0` covers the entire viewport, no rounded corners, no border.
- `sm:` and up: revert to centered modal — `sm:left-1/2 sm:top-1/2 sm:inset-auto sm:h-[min(90vh,860px)] sm:w-[min(90vw,1180px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border`.
- `CommandPalette` uses `px-3 pt-4 sm:px-0 sm:pt-[15vh]` to sit near the top of the viewport on mobile rather than floating in dead space.

### Settings (`settings.tsx`, `settings.sandbox.tsx`)
- Desktop: three-column (`CategoryRail` + `CategoryList` + `Outlet`).
- Mobile: single column — list OR detail route fills the screen; `CategoryRail` hidden.
- Every detail page provides its own back navigation:
  - Agent / Skill / MCP editors: `ArrowLeft` button in `EditorSubHeader` (links back to the list route).
  - Sandbox: `ArrowLeft` icon button added to the sticky header, links to `/settings` (mobile-only, `useIsMobile` guard).
  - Settings hub (`/settings`): `ArrowLeft` icon button links back to `/cockpit` (mobile-only).

---

## Telemetry page (`routes/telemetry/`)

- Outer shell uses `h-dvh`.
- Wide tables (`TracesTable`, `Table` primitive) are wrapped in `overflow-x-auto` with a `min-w-*` so they scroll horizontally rather than overflow.
- Waterfall: `overflow-x-auto` wrapper + `min-w-[480px]` inner div; span name column is `w-48` (mobile) / `sm:w-64` (wider).
- `SpanDetailPanel`: on desktop a fixed `w-96` flex sibling. On mobile it renders as an `absolute inset-0 z-10` overlay covering the waterfall, using the `fullWidth` prop.

---

## File preview lightbox

Generated and attached files (images, audio, video, PDF, text, and other generic attachments) open in a shared full-screen lightbox (`FileLightbox`). User-message attachments (`UserBubble`) also open through the same lightbox via `AttachmentStrip`.

- **Gestures**: Touch shells support swipe-down-to-dismiss, double-tap zoom, and two-finger pinch zoom (1×–4×) for images. Desktop supports double-click to zoom and mouse-drag to pan when zoomed.
- **Scroll & swipe isolation**: For scrollable previews (PDF, text), a directional gesture lock on the first touch resolves conflicts. Vertical-first → locks to scroll, stops gallery-swipe propagation. Horizontal-first → locks to gallery swipe, prevents content scroll.
- **Dismissal**: Click outside the active content card, or press Escape.
- **Download**: The download button calls `tauriDownload(url, filename)` (`lib/tauri-download.ts`):
  - **Tauri shell** — `blob:` URLs are read to base64 in JS (Rust cannot reach browser-only blob URLs) and sent via IPC. All other URLs (`http/https/data:`) are passed directly to Rust which fetches them via `reqwest` — no base64 overhead.
  - **Browser** — plain `<a download>` anchor.
  - Errors surface as an error toast; they never throw so the UI stays stable.

## IPC capability: private-network HTTP

`mobile/src-tauri/capabilities/default.json` (and desktop's equivalent) whitelist Tauri `invoke()` calls from all RFC-1918 private IP ranges over plain HTTP, and require HTTPS for public hosts:

| Range | Pattern |
|-------|---------|
| Loopback | `http://localhost:*`, `http://127.*:*` |
| Class A private | `http://10.*:*` |
| Class B private | `http://172.16.*:*` … `http://172.31.*:*` |
| Class C private | `http://192.168.*:*` |
| Public | `https://*:*` only |

This ensures users can connect the mobile shell to a server on any common LAN topology (`10.x`, `192.168.x`, etc.) without hitting a silent Tauri IPC block.

## File attachment remove button (`ImageAttachment`, `FileCard`)

The remove (×) button on pending attachments uses `group-hover` to appear on desktop. On mobile, hover never fires, so the button is always visible (`opacity-100 md:opacity-0 md:group-hover:opacity-100`).

Style: `h-4 w-4` rounded-full, `bg-(--color-surface-2)` with a `ring-(--color-border)` outline — neutral, not red. The image thumbnail itself has no hover opacity effect.

---

## Back-button conventions

All mobile back buttons are **icon-only** (`ArrowLeft`, `aria-label` set). No text label next to the icon. Size: `h-11 w-11` for sticky settings headers (meets 44 px touch target); legacy `h-7 w-7` is still used inside dialog headers where vertical space is tight.

---

## Status bars (`StatusBar`, `TeamStatusBar`)

Both footer status rows use `flex-wrap items-center justify-between gap-x-3 gap-y-1` so left/center/right clusters wrap onto a new line instead of overflowing on narrow viewports. The right cluster also wraps internally (`flex-wrap justify-end`) so agent pills stack neatly. `StatusBar` hides the `Ctrl+N new` shortcut hint on mobile (`hidden sm:inline`).

---

## Shared primitive guards

A few `components/ui/*` primitives have responsive guards so individual call sites don't have to:

- **`long-press-button`**: while a touch press is armed the button scales down slightly (`data-pressing:scale-[0.97]`, iOS context-menu "lift" cue); reaching the 520 ms hold threshold fires a native medium haptic plus `onLongPress`. Haptics route through `lib/haptics.ts` — `tauri-plugin-haptics` (`UIImpactFeedbackGenerator` on iOS, `VibrationEffect` on Android) with a `navigator.vibrate` fallback; all paths are best-effort and never block the press behavior. Mouse pointers are ignored so desktop keeps plain click semantics.
- **Tiny text utilities**: `.text-[9px]` and `.text-[10px]` are lifted to an 11 px floor under `html[data-mobile-shell]`; desktop density is unchanged.

- **`popover`**: `w-[min(18rem,calc(100vw-1rem))]` — never overflows the viewport when anchored near the edge.
- **`select`**: `max-w-[calc(100vw-1rem)]` on the content popup.
- **`tabs`**: `max-w-full overflow-x-auto scrollbar-none` on `TabsList` — many tabs scroll horizontally instead of breaking the row.
- **`view-toggle`**: buttons are `h-8 w-8` (32 px) to meet the touch-target threshold.

---

## Keyboard shortcuts on mobile

Command Palette (`⌘P`/`Ctrl+P`) no-ops on mobile; all other shortcuts are unchanged. The Scoped Select All hook (`useContainerSelectAll`) skips registration entirely on `ios`/`android` so it never interferes with native long-press/touch-selection. The paste-while-minimized handler in `FloatingInputBar` is also gated behind `if (isMobile) return` — the bar is always expanded on mobile and handles paste natively. Full shortcut reference: [`interaction.md#keyboard-model`](../../styling-specs/interaction.md#keyboard-model).
