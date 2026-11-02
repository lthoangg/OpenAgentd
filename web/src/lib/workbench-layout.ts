/**
 * Workbench layout geometry for the desktop app.
 *
 * Pure functions only — the persisted values live in ``useLayoutStore`` and
 * the measured widths come from the shell. Keeping the math here lets the
 * sidebar and the review dock agree on one budget instead of each querying
 * the other's DOM node while rendering.
 *
 *   ┌ sidebar ┬──────────── center ────────────┐
 *   │  264px  │  chat (≥ CHAT_MIN) │ dock (≥ DOCK_MIN) │
 *
 * The dock stores a *ratio* of the center rather than pixels (Zed's
 * "flexible" docks), so it scales with the window instead of pinning a
 * width chosen on a smaller screen.
 */

export const SIDEBAR_DEFAULT_WIDTH = 264
export const SIDEBAR_MIN_WIDTH = 220
export const SIDEBAR_MAX_WIDTH = 440
/** Viewports at least this wide open with the sidebar expanded on first run. */
export const SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT = 1280
/**
 * Touch tablets: below this width the sidebar is a drawer over the content
 * (closed by a tap outside or Escape), as iPadOS sidebars are in portrait.
 * Desktop windows push the content while it fits (``sidebarIsDrawer``).
 */
export const SIDEBAR_DRAWER_MAX_VIEWPORT = 1180

/**
 * Narrowest chat column kept beside an open dock in a desktop window, so the
 * split starts at 740px of center (layout.html). Like any desktop app, the
 * panel and the sidebar sit beside the chat while they fit.
 */
export const CHAT_MIN_WIDTH = 400
/**
 * The same on a touch tablet: the width under which the run deck stacks onto
 * two lines (`RunChip`, `@max-[520px]`). Narrower, the dock covers the
 * transcript and the composer keeps the full width, so an 820px tablet in
 * portrait gets the overlay and a 1024px one the split (layout.html).
 */
export const TOUCH_CHAT_MIN_WIDTH = 520
export const DOCK_MIN_WIDTH = 340
export const DOCK_DEFAULT_RATIO = 0.45

/** Whether the window is driven by touch (a tablet) rather than a pointer. */
export interface InputKind {
  touch?: boolean
}

export function chatMinWidth({ touch = false }: InputKind = {}): number {
  return touch ? TOUCH_CHAT_MIN_WIDTH : CHAT_MIN_WIDTH
}

/** Keyboard resize steps for panel separators. */
export const RESIZE_KEY_STEP = 16
export const RESIZE_KEY_STEP_LARGE = 64

/** Narrowest a Review panel pane gets: a tab and the strip's buttons. */
export const DOCK_PANE_MIN_WIDTH = 160
/** Shortest a Review panel pane gets: a tab strip and a few rows. */
export const DOCK_PANE_MIN_HEIGHT = 120

export type DockMode = 'side' | 'overlay'

export interface DockLayout {
  mode: DockMode
  width: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * First-run default: expanded on wide windows (at least
 * ``SIDEBAR_AUTO_EXPAND_MIN_VIEWPORT``), collapsed otherwise.
 */
export function resolveSidebarCollapsed(stored: boolean | null | undefined, wideViewport: boolean): boolean {
  if (typeof stored === 'boolean') return stored
  return !wideViewport
}

/** What the open sidebar leaves the center: the chat, plus the Review panel beside it. */
export interface SidebarContext extends InputKind {
  /** The Review panel is open (desktop): the center must fit it beside the chat. */
  dockOpen?: boolean
}

function centerReserve({ dockOpen = false, touch = false }: SidebarContext): number {
  return chatMinWidth({ touch }) + (dockOpen ? DOCK_MIN_WIDTH : 0)
}

/**
 * Whether the sidebar is a drawer over the content instead of a column that
 * pushes it. A desktop window pushes while the sidebar, at its narrowest,
 * still leaves the chat (and an open Review panel) their minimum widths, as
 * desktop sidebars do; only a window too narrow for that gets the drawer. A
 * touch tablet follows iPadOS: a drawer below ``SIDEBAR_DRAWER_MAX_VIEWPORT``.
 */
export function sidebarIsDrawer(viewportWidth: number, context: SidebarContext = {}): boolean {
  if (context.touch) return viewportWidth < SIDEBAR_DRAWER_MAX_VIEWPORT
  return viewportWidth - SIDEBAR_MIN_WIDTH < centerReserve(context)
}

/**
 * Largest sidebar that still leaves room for the chat and, unless told the
 * Review panel is closed, a side dock.
 */
export function sidebarMaxWidth(viewportWidth: number, { dockOpen = true, touch = false }: SidebarContext = {}): number {
  return clamp(viewportWidth - centerReserve({ dockOpen, touch }), SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
}

export function clampSidebarWidth(width: number, viewportWidth: number, context?: SidebarContext): number {
  const safe = Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH
  return Math.round(clamp(safe, SIDEBAR_MIN_WIDTH, sidebarMaxWidth(viewportWidth, context)))
}

/** Desktop center widths below this cannot fit the chat and the dock side by side. */
export const DOCK_SIDE_BY_SIDE_MIN_CENTER = CHAT_MIN_WIDTH + DOCK_MIN_WIDTH

export function dockMaxWidth(centerWidth: number, input: InputKind = {}): number {
  return Math.max(DOCK_MIN_WIDTH, centerWidth - chatMinWidth(input))
}

/**
 * Whether the dock covers the chat instead of sitting beside it. The shell
 * reads this alone (to make the chat inert) so it can skip re-rendering on
 * every center-width change; the dock resolves the full geometry itself.
 */
export function dockOverlaysChat(centerWidth: number, maximized: boolean, input: InputKind = {}): boolean {
  return maximized || Math.max(0, Math.round(centerWidth)) < chatMinWidth(input) + DOCK_MIN_WIDTH
}

/**
 * Resolve the dock's geometry. ``overlay`` covers the chat column — used for
 * the explicit maximize toggle and as the fallback when the window is too
 * narrow for a usable side-by-side split.
 */
export function resolveDockLayout({
  centerWidth,
  ratio,
  maximized,
  touch = false,
}: {
  centerWidth: number
  ratio: number
  maximized: boolean
} & InputKind): DockLayout {
  const center = Math.max(0, Math.round(centerWidth))
  if (dockOverlaysChat(center, maximized, { touch })) {
    return { mode: 'overlay', width: center }
  }
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : DOCK_DEFAULT_RATIO
  return {
    mode: 'side',
    width: Math.round(clamp(safeRatio * center, DOCK_MIN_WIDTH, dockMaxWidth(center, { touch }))),
  }
}

export function ratioFromWidth(width: number, centerWidth: number): number {
  if (!(centerWidth > 0) || !Number.isFinite(width)) return DOCK_DEFAULT_RATIO
  return clamp(width / centerWidth, 0.05, 0.95)
}
