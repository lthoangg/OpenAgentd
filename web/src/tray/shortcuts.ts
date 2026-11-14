/**
 * Shortcut hints are written for the platform they are read on: ⌘ on macOS,
 * Ctrl elsewhere. The popup acts on that modifier alone, so Ctrl+Q is not
 * Quit on a Mac.
 */
import { getPlatform } from '@/hooks/use-platform'

/** "⌘" on macOS, "Ctrl+" elsewhere. */
export function modifierLabel(os: string = getPlatform().os): string {
  return os === 'macos' ? '⌘' : 'Ctrl+'
}

/** "⌘," / "Ctrl+," for the key `key`. */
export function shortcutLabel(key: string, os?: string): string {
  return `${modifierLabel(os)}${key.length === 1 ? key.toUpperCase() : key}`
}

/** Whether the key is held with the platform's shortcut modifier and no other. */
export function holdsShortcutModifier(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  os: string = getPlatform().os,
): boolean {
  if (event.altKey || event.shiftKey) return false
  return os === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

/** The `aria-keyshortcuts` value for the key `key`. */
export function ariaShortcut(key: string, os: string = getPlatform().os): string {
  return `${os === 'macos' ? 'Meta' : 'Control'}+${key.toUpperCase()}`
}
