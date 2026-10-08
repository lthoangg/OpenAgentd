/**
 * Shared floating-menu geometry (DESIGN.md → Floating Menus & Context Menus).
 *
 * Dropdowns, context menus and hand-built listboxes (model combobox, composer
 * suggestions) all read from here so their panels and rows line up: a
 * ``rounded-sm`` card panel with ``p-1`` and the depth shadow, and 28px
 * ``rounded-xs`` rows in ``text-xs``.
 */

/** Floating panel surface. Callers add position, z-index and width. */
export const MENU_PANEL_CLASS =
  'rounded-sm border border-(--color-border) bg-(--bg-card) p-1 shadow-(--shadow-depth)'

/** Row geometry (28px). Callers add tone and state. */
export const MENU_ITEM_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-left text-xs'

/** Hairline between menu groups. */
export const MENU_SEPARATOR_CLASS = 'my-1 border-t border-(--color-border-subtle)'
