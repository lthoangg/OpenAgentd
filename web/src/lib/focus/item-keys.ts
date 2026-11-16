/**
 * Desktop keys for the focused item of a list: Shift+F10 / the ContextMenu
 * key open its menu, F2 renames it. These are the keyboard paths for row
 * actions that only show on hover. Sidebar rows take neither.
 */
type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>

export function isMenuKey(event: KeyLike): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)
}

export function isRenameKey(event: KeyLike): boolean {
  return event.key === 'F2' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/** Where a keyboard-opened menu appears: under the item's start. */
export function menuPointFor(element: Element): { clientX: number; clientY: number } {
  const rect = element.getBoundingClientRect()
  return { clientX: rect.left + 8, clientY: rect.bottom }
}
