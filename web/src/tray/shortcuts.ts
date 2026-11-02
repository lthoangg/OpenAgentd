/**
 * Shortcut hints are written for the platform they are read on: ⌘ on macOS,
 * Ctrl elsewhere. The popup handles both modifiers, so the hint is true
 * wherever it is shown.
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
