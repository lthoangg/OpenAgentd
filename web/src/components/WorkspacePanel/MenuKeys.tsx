/**
 * The key spelled at the end of a dock menu row ("⌘W", "⌃⌥→", "F2"). Hidden
 * on touch, which has no keyboard to press it with, and from assistive tech
 * (the row's name is its label). Drawn like the sidebar menus' shortcut
 * (``Sidebar/MenuShortcut``): muted, because a menu sits on a card. Spell it
 * from ``APP_SHORTCUTS`` or a dock chord, never by hand, so the menu and the
 * key cannot disagree.
 */
export function MenuKeys({ children }: { children: string }) {
  return (
    <kbd aria-hidden="true" className="ml-auto shrink-0 pl-4 font-sans text-meta font-normal text-(--color-text-muted) pointer-coarse:hidden">
      {children}
    </kbd>
  )
}
