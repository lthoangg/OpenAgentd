---
title: Mobile Layout
description: Phone-first responsive design — breakpoints, safe areas, master/detail patterns, and per-component mobile behaviour.
status: stable
updated: 2026-04-29
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
- Prop: `mobileOpen / onMobileClose` (owner: `TeamChatView`).
- `showIconOnly = !isMobile && collapsed` — icon-only mode is desktop-only.
- Command palette button hidden on mobile (`onCommandPalette` prop omitted).

### TeamChatView (`TeamChatView/index.tsx`)
- `effectiveViewMode = isMobile ? 'agent' : viewMode` — split/unified modes disabled on mobile.
- View-mode toggle, token count, split/unified controls are hidden on mobile.
- `Ctrl+P` (command palette) and `v` (cycle view mode) shortcuts no-op on mobile.
- `CommandPalette` is never rendered on mobile (`!isMobile && showPalette`).

### FloatingInputBar (`FloatingInputBar.tsx`)
- Mobile: static docked `<div>` at the bottom with `border-t`, `backdrop-blur`, `.pb-safe`. No drag, no localStorage position.
- Desktop: draggable floating bar (existing behaviour unchanged).
- Voice input: the mic button sits beside Send on mobile and desktop. When `voice.enabled` is false the button is shown disabled with a tooltip — it does not record. Recording starts and stops only from button taps/clicks; no mobile-specific silence auto-stop. Configure via **Settings → Voice** or edit `speech.yaml` directly.

### MemoryPanel, WorkspaceFilesPanel, SchedulerPanel
All three use **master/detail** on mobile — one pane at a time, never side-by-side:

| Panel | List pane | Detail pane | Back trigger |
|-------|-----------|-------------|--------------|
| `MemoryPanel` | File tree | Editor | `ArrowLeft` icon button in header |
| `WorkspaceFilesPanel` | Directory tree | File preview | `ArrowLeft` icon button in header |
| `SchedulerPanel` | Task list (+ `+` icon to create) | Detail / Create form | `ArrowLeft` icon button in header |

Desktop: fixed-width left column + flex-1 right column (unchanged).

`SchedulerPanel` previously used `lg:w-96` / `hidden lg:flex` (viewport breakpoints). These were replaced with explicit `isMobile` branches — the panel's own width (`min(960px, 90vw)`) is narrower than 1024 px on mobile so `lg:` never fired.

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

## File attachment remove button (`ImageAttachment`, `FileCard`)

The remove (×) button on pending attachments uses `group-hover` to appear on desktop. On mobile, hover never fires, so the button is always visible (`opacity-100 md:opacity-0 md:group-hover:opacity-100`).

Style: `h-4 w-4` rounded-full, `bg-(--color-surface-2)` with a `ring-(--color-border)` outline — neutral, not red. The image thumbnail itself has no hover opacity effect.

---

## Back-button conventions

All mobile back buttons are **icon-only** (`ArrowLeft`, `h-7 w-7`, `aria-label` set). No text label next to the icon.

---

## Keyboard shortcuts on mobile

| Shortcut | Mobile |
|----------|--------|
| `Ctrl+P` (command palette) | disabled |
| `v` (cycle view mode) | disabled |
| All others | unchanged |
