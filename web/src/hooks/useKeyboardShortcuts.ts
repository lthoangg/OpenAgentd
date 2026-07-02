/**
 * useKeyboardShortcuts — registers window-level primary-modifier shortcuts.
 *
 * Cross-platform note: the primary modifier is ``⌘`` (Meta) on macOS and
 * ``Ctrl`` everywhere else — see ``lib/keyboard-shortcut.ts`` for the
 * rationale and ``isPrimaryShortcut`` helper this hook is built on. The
 * *other* platform's modifier is explicitly excluded so OS-level shortcuts
 * (⌘W, ⌘Q, etc. on mac; Ctrl+W on Windows/Linux) keep working, and so a
 * stray Ctrl+Meta combo never double-fires.
 *
 * Shortcuts map: key (lowercase) → handler function, or ``{ handler, shift }``
 * for entries that additionally require Shift (used to dodge a real OS/
 * webview conflict, e.g. Session Settings uses ⌘⇧A because bare ⌘A is
 * "Select All").
 *
 * Usage:
 *   useKeyboardShortcuts({
 *     b: () => sidebar.toggle(),
 *     a: { handler: () => setShowAgentInfo(v => !v), shift: true },
 *   })
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { getPlatform } from '@/hooks/use-platform'
import { isPrimaryShortcut } from '@/lib/keyboard-shortcut'

type ShortcutHandler = () => void
type ShortcutEntry = ShortcutHandler | { handler: ShortcutHandler; shift?: boolean }
type ShortcutMap = Partial<Record<string, ShortcutEntry>>

export function useKeyboardShortcuts(shortcuts: ShortcutMap): void {
  // Keep ref in sync with the latest shortcuts map without re-registering
  // the event listener. useLayoutEffect runs synchronously after DOM mutations
  // so the ref is always current before any user interaction.
  const ref = useRef(shortcuts)
  useLayoutEffect(() => {
    ref.current = shortcuts
  })

  useEffect(() => {
    const { os } = getPlatform()

    const handler = (e: KeyboardEvent) => {
      const entry = ref.current[e.key.toLowerCase()]
      if (!entry) return
      const { handler: fn, shift } = typeof entry === 'function' ? { handler: entry, shift: false } : entry
      if (!isPrimaryShortcut(e, os, { shift })) return
      e.preventDefault()
      fn()
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, []) // runs once — ref always has latest shortcuts
}
