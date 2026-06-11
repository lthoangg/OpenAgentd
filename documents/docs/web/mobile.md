---
title: Mobile Layout
description: Phone-first responsive design — breakpoints, safe areas, master/detail patterns, and per-component mobile behaviour.
status: stable
updated: 2026-06-10
---

# Mobile layout

The web UI targets phones at 360–430 px as the primary baseline. All layout decisions are mobile-first; desktop enhancements are additive.

---

## Breakpoint & hook

`useIsMobile()` (`web/src/hooks/use-mobile.ts`) returns `true` when `window.innerWidth < 768 px` (Tailwind `md:`). Use this hook — never raw CSS breakpoints — for JS-driven layout branches.

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
- `Ctrl+P` (command palette) and `v` (cycle view mode) shortcuts no-op on mobile.
- `CommandPalette` is never rendered on mobile (`!isMobile && showPalette`).
- User and queued-message bubbles can use the full chat width on mobile; `md:` and wider viewports keep the narrower desktop caps.
- Long single-agent transcripts render the newest 80 turns first and expose **Show earlier messages** to reveal older turns in chunks, reducing initial mobile layout cost.

### FloatingInputBar (`FloatingInputBar.tsx`) / InputBar (`InputBar.tsx`)
- Mobile: static docked `<div>` at the bottom with `border-t`, `backdrop-blur`, `.pb-safe`. No drag, no localStorage position.
- On Tauri iOS/Android, `useVisualKeyboardInset()` listens to `visualViewport` and adds keyboard occlusion to bottom padding so the composer stays above the soft keyboard.
- Desktop: draggable floating bar (existing behaviour unchanged).
- Mobile keyboard: plain `Enter` inserts a newline; users submit with the Send button. Desktop keeps `Enter` to send and `Shift+Enter` for newline.
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

### Full-screen sheet modals (`WikiPanel`, `SchedulerPanel`, `CommandPalette`)
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

## Image lightbox

Generated and attached images open in a shared full-screen lightbox. Touch shells support swipe-down-to-dismiss, double-tap zoom, and two-finger pinch zoom (1×–4×); desktop keeps backdrop click and Escape.

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

| Shortcut | Mobile |
|----------|--------|
| `Ctrl+P` (command palette) | disabled |
| `v` (cycle view mode) | disabled |
| All others | unchanged |
