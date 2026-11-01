/**
 * Desktop keys for the focused item of a list: Shift+F10 / the ContextMenu
 * key open its menu, Delete (or ⌘⌫ / Ctrl+Backspace) deletes it, F2 renames
 * it. These are the keyboard paths for row actions that only show on hover.
 */
import { getPlatform } from '@/hooks/use-platform'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>

export function isMenuKey(event: KeyLike): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey)
}

export function isDeleteKey(event: KeyLike): boolean {
  if (event.altKey || event.shiftKey) return false
  if (event.key === 'Delete') return !event.ctrlKey && !event.metaKey
  if (event.key !== 'Backspace') return false
  return isPrimaryModifierOS(getPlatform().os) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export function isRenameKey(event: KeyLike): boolean {
  return event.key === 'F2' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/** Where a keyboard-opened menu appears: under the item's start. */
export function menuPointFor(element: Element): { clientX: number; clientY: number } {
  const rect = element.getBoundingClientRect()
  return { clientX: rect.left + 8, clientY: rect.bottom }
}
