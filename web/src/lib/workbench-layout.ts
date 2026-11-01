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
 * Below this window width the desktop sidebar is a drawer over the content
 * (closed by a click outside or Escape) instead of a column that pushes it.
 */
export const SIDEBAR_DRAWER_MAX_VIEWPORT = 1180

/**
 * Narrowest chat column kept beside an open dock: the width under which the
 * run deck stacks onto two lines (`RunChip`, `@max-[520px]`). Narrower, the
 * dock covers the transcript instead and the composer keeps the full width,
 * so the split starts at 860px of center: an 820px tablet in portrait gets
 * the overlay, a 1024px window keeps the chat beside the panel (layout.html).
 */
export const CHAT_MIN_WIDTH = 520
export const DOCK_MIN_WIDTH = 340
export const DOCK_DEFAULT_RATIO = 0.45

/** Keyboard resize steps for panel separators. */
export const RESIZE_KEY_STEP = 16
export const RESIZE_KEY_STEP_LARGE = 64

/** The Review panel's two groups (top/bottom): default share of the upper one. */
export const DOCK_SPLIT_DEFAULT_RATIO = 0.55
/** Shortest a Review panel group gets: a tab strip and a few rows. */
export const DOCK_GROUP_MIN_HEIGHT = 120

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

/** Whether the desktop sidebar is a drawer at this window width. */
export function sidebarIsDrawer(viewportWidth: number): boolean {
  return viewportWidth < SIDEBAR_DRAWER_MAX_VIEWPORT
}

/**
 * The upper group's share of a split Review panel ``height`` px tall, kept
 * so neither group drops below ``DOCK_GROUP_MIN_HEIGHT``. A panel too short
 * for that splits evenly.
 */
export function clampSplitRatio(ratio: number, height: number): number {
  const safe = Number.isFinite(ratio) && ratio > 0 && ratio < 1 ? ratio : DOCK_SPLIT_DEFAULT_RATIO
  if (!(height > DOCK_GROUP_MIN_HEIGHT * 2)) return 0.5
  const min = DOCK_GROUP_MIN_HEIGHT / height
  return clamp(safe, min, 1 - min)
}

/** Largest sidebar that still leaves room for the chat and a side dock. */
export function sidebarMaxWidth(viewportWidth: number): number {
  return clamp(viewportWidth - CHAT_MIN_WIDTH - DOCK_MIN_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const safe = Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH
  return Math.round(clamp(safe, SIDEBAR_MIN_WIDTH, sidebarMaxWidth(viewportWidth)))
}

/** Center widths below this cannot fit the chat and the dock side by side. */
export const DOCK_SIDE_BY_SIDE_MIN_CENTER = CHAT_MIN_WIDTH + DOCK_MIN_WIDTH

export function dockMaxWidth(centerWidth: number): number {
  return Math.max(DOCK_MIN_WIDTH, centerWidth - CHAT_MIN_WIDTH)
}

/**
 * Whether the dock covers the chat instead of sitting beside it. The shell
 * reads this alone (to make the chat inert) so it can skip re-rendering on
 * every center-width change; the dock resolves the full geometry itself.
 */
export function dockOverlaysChat(centerWidth: number, maximized: boolean): boolean {
  return maximized || Math.max(0, Math.round(centerWidth)) < DOCK_SIDE_BY_SIDE_MIN_CENTER
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
}: {
  centerWidth: number
  ratio: number
  maximized: boolean
}): DockLayout {
  const center = Math.max(0, Math.round(centerWidth))
  if (dockOverlaysChat(center, maximized)) {
    return { mode: 'overlay', width: center }
  }
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : DOCK_DEFAULT_RATIO
  return {
    mode: 'side',
    width: Math.round(clamp(safeRatio * center, DOCK_MIN_WIDTH, dockMaxWidth(center))),
  }
}

export function ratioFromWidth(width: number, centerWidth: number): number {
  if (!(centerWidth > 0) || !Number.isFinite(width)) return DOCK_DEFAULT_RATIO
  return clamp(width / centerWidth, 0.05, 0.95)
}
