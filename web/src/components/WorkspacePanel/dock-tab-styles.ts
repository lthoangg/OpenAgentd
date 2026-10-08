/**
 * Shared class strings for the review dock's editor-tab strip.
 *
 * The strip sits on the recessed ``bg-sidebar`` rail; the active tab lifts
 * to ``bg-page`` with a 2px Bark top edge so it reads as the open sheet the
 * content below belongs to. The bar draws no bottom border of its own: each
 * inactive tab, the trailing filler, and the action cluster draw theirs, so
 * the active tab can open onto the content (an ``-mb-px`` overlap would be
 * clipped by the strip's horizontal scroller).
 */

/** Tab wrapper. Holds the activate button and, when closable, a close button. */
export function dockTabClass(active: boolean): string {
  return [
    'group/tab relative flex h-full max-w-48 shrink-0 items-center border-t-2 border-r border-b border-r-(--color-border-subtle) text-xs transition-colors duration-(--motion-instant)',
    active
      ? 'border-t-(--color-accent) border-b-transparent bg-(--bg-page) text-(--color-text)'
      : 'border-t-transparent border-b-(--color-border) text-(--color-text-muted) hover:bg-(--bg-key)/50 hover:text-(--color-text-2)',
  ].join(' ')
}

/** Activate button filling the tab. ``closable`` tabs leave room for the ×. */
export function dockTabButtonClass(closable: boolean): string {
  return [
    'flex h-full min-w-0 items-center gap-1.5 outline-none focus-visible:bg-(--bg-key)/60',
    closable ? 'pl-3 pr-1' : 'px-3',
  ].join(' ')
}

/**
 * A tab picked up by a drag: an opaque raised sheet over the tabs it
 * passes (a true floating layer for the drag, so it may cast the shadow).
 */
export const DOCK_TAB_LIFTED_CLASS = 'shadow-(--shadow-depth) bg-(--bg-card) text-(--color-text) cursor-grabbing'

/** Inline close control; always shown on the active tab and on touch. */
export function dockTabCloseClass(active: boolean): string {
  return [
    'mr-1.5 flex size-5 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) transition-opacity hover:bg-(--bg-key) hover:text-(--color-text) focus-visible:opacity-100 pointer-coarse:size-8',
    active ? 'opacity-100' : 'opacity-70 md:opacity-0 md:group-hover/tab:opacity-100 md:group-focus-within/tab:opacity-100',
  ].join(' ')
}

/** Icon-only action in the tab bar or a view toolbar. */
export const DOCK_ACTION_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) disabled:cursor-not-allowed disabled:opacity-40 md:h-7 md:w-7'

/** Hover-revealed row action inside a list row (28px, 44px on touch). */
export const DOCK_ROW_ACTION_CLASS =
  'flex size-6 shrink-0 items-center justify-center rounded-xs text-(--color-text-subtle) hover:bg-(--bg-card) hover:text-(--color-text) pointer-coarse:size-9'
