/**
 * Settings layout tokens. The type and icon scale and row padding are shared
 * app-wide from `ui/panel-tokens`; only the page column is Settings-specific.
 */
export { COMPACT_ROW, ICON_SIZE, ICON_SIZE_INLINE, ROW_PAD, TEXT } from '@/components/ui/panel-tokens'

/**
 * Page body column: one reading width and one horizontal inset for every
 * settings page, so headers, sections and the save bar line up.
 */
export const PAGE_BODY = 'mx-auto w-full max-w-3xl px-4 md:px-8'

/**
 * Body of a page that needs more than `PAGE_BODY`'s reading width (Memory's
 * list and editor). It starts at the same left edge as `PAGE_BODY` (the
 * centred column's, or the inset on a narrow window) and takes the rest of
 * the width, so a wide page only ever extends to the right.
 */
export const PAGE_BODY_WIDE = 'ml-[max(0px,calc((100%_-_48rem)/2))] w-auto px-4 md:px-8'

/** Body column for editor pages, which sit under their own sub-header. */
export const EDITOR_BODY = `${PAGE_BODY} py-6 md:py-8`
