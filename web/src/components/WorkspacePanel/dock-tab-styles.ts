/**
 * Shared class strings for the review dock's editor-tab strip.
 *
 * Fewer borders (DESIGN.md → Editor tabs): tabs are borderless pills on the
 * chrome tone the sidebar, header and status bar share (the page in light,
 * the recessed rail in dark). The open tab is marked the way the sidebar
 * marks the open session (``listRowSurface``): a keycap wash, medium weight,
 * the main text colour, no coloured edge. The strip draws the one hairline
 * between it and the content. With several panes, the open tab of a pane
 * that does not have focus steps back (a lighter wash, the secondary text
 * colour), so the focused pane (the one ⌘W, ⌘1–9 and new files act on)
 * reads at a glance. Nothing fades by opacity: a strip at 50% left its
 * labels at 2.1–2.3:1.
 */
import { listRowSurface } from '@/components/ui/list-row'

/** The strip: one tab-bar row on the chrome tone. */
export const DOCK_TAB_STRIP_CLASS =
  'flex h-(--spacing-tab-bar) min-w-0 shrink-0 border-b border-(--color-border-subtle) bg-(--bg-page) dark:bg-(--bg-sidebar)'

/** Tab wrapper. Holds the activate button and, when closable, a close button. */
export function dockTabClass(active: boolean): string {
  return [
    'group/tab relative flex h-full max-w-48 shrink-0 items-center rounded-sm text-xs transition-colors duration-(--motion-instant)',
    listRowSurface(active),
    active
      ? 'font-medium text-(--color-text) [[data-pane-unfocused]_&]:bg-(--bg-key)/35 [[data-pane-unfocused]_&]:text-(--color-text-2)'
      : 'text-(--color-text-muted) hover:text-(--color-text-2)',
  ].join(' ')
}

/** Activate button filling the tab. ``closable`` tabs leave room for the ×. */
export function dockTabButtonClass(closable: boolean): string {
  return [
    'flex h-full min-w-0 items-center gap-1.5 rounded-sm outline-none focus-key:bg-(--bg-key)/60',
    closable ? 'pl-2.5 pr-1' : 'px-2.5',
  ].join(' ')
}

/**
 * A tab picked up by a drag: an opaque raised sheet over the tabs it
 * passes (a true floating layer for the drag, so it may cast the shadow).
 */
export const DOCK_TAB_LIFTED_CLASS = 'shadow-(--shadow-depth) bg-(--bg-card) text-(--color-text) cursor-grabbing'

/** A tab carried out of its strip: a floating copy under the pointer (placed inline). */
export const DOCK_TAB_GHOST_CLASS = 'rounded-sm opacity-95 shadow-(--shadow-depth) bg-(--bg-card) text-(--color-text)'

/**
 * Where a carried tab would land: a tint over the pane (its
 * middle), over the half a split would take (an edge), or a caret between
 * two tabs of a strip.
 */
export const DOCK_DROP_ZONE_CLASS = 'pointer-events-none fixed z-9998 rounded-sm border border-(--color-border-strong) bg-(--color-text-muted)/15'
export const DOCK_DROP_CARET_CLASS = 'pointer-events-none fixed z-9998 w-0.5 rounded-full bg-(--color-text-2)'

/**
 * Inline close control, always shown: muted on the open tab, a step lower
 * (subtle) on the others, ink on hover (never hidden, so a touch screen and a
 * keyboard find it). 24px, 36px on touch.
 */
export function dockTabCloseClass(active: boolean): string {
  return [
    'mr-1 flex size-6 shrink-0 items-center justify-center rounded-xs transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:mr-0 pointer-coarse:size-9',
    active ? 'text-(--color-text-muted)' : 'text-(--color-text-subtle) group-hover/tab:text-(--color-text-muted)',
  ].join(' ')
}

/**
 * Icon-only action in the tab bar or a view toolbar. On touch it stays 28px
 * so it fits the 32px toolbar; ``touch-hit`` grows its hit area to 36px. The
 * tab bar (39px on touch) adds ``pointer-coarse:size-9`` back.
 */
export const DOCK_ACTION_BUTTON_CLASS =
  'relative touch-hit flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40 md:h-7 md:w-7 pointer-coarse:size-7'

/** Hover-revealed row action inside a list row (28px, 44px on touch). */
export const DOCK_ROW_ACTION_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) hover:bg-(--bg-card) hover:text-(--color-text) pointer-coarse:size-9'
