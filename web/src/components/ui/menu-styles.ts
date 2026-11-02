/**
 * Shared floating-menu geometry (DESIGN.md → Floating Menus & Context Menus).
 *
 * Dropdowns, context menus and hand-built listboxes (model combobox, composer
 * suggestions) all read from here so their panels and rows line up: a
 * ``rounded-md`` card panel with one subtle hairline, ``p-1`` and the depth
 * shadow, and 28px ``rounded-xs`` rows in ``text-xs``. A row under the
 * pointer or the keyboard takes the highlight wash and every word in it takes
 * the wash's text tone, like an OS menu (``.oa-menu-item`` in index.css).
 */

/** Floating panel surface. Callers add position, z-index and width. */
export const MENU_PANEL_CLASS =
  'rounded-md border border-(--color-border-subtle) bg-(--bg-card) p-1 shadow-(--shadow-depth)'

/** Row geometry (28px, 36px on touch) and the accent highlight. Callers add tone and state. */
export const MENU_ITEM_CLASS =
  'oa-menu-item flex w-full cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-left text-xs pointer-coarse:min-h-9'

/** A destructive row: error text at rest, a solid error fill when highlighted. */
export const MENU_ITEM_DANGER = 'oa-menu-item-danger'

/** Hairline between menu groups. */
export const MENU_SEPARATOR_CLASS = 'my-1 border-t border-(--color-border-subtle)'
