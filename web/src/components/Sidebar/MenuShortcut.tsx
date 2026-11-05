import type { ReactNode } from 'react'

/**
 * The shortcut beside a menu entry, drawn in the sidebar's menus the way the
 * Review panel's menus draw theirs. Decorative (the entry carries
 * ``aria-keyshortcuts``) and hidden on touch, where there is no keyboard to
 * press it on. Muted, not subtle: a menu sits on a card, and subtle text
 * belongs on the page or sidebar background only.
 */
export function MenuShortcut({ children }: { children: ReactNode }) {
  return (
    <kbd
      aria-hidden="true"
      className="ml-auto shrink-0 pl-4 font-sans text-meta font-normal text-(--color-text-muted) pointer-coarse:hidden"
    >
      {children}
    </kbd>
  )
}
