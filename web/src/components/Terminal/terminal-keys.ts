/**
 * Keys a focused terminal gives back to the app.
 *
 * App shortcuts listen on ``window`` and skip keys a focused widget handled.
 * xterm handles (and stops) every key it sends to the shell, but it ignores
 * ⌘ chords, so on macOS every app shortcut already works from a terminal:
 * ⌘K opens the palette. Clearing the scrollback is in the terminal tab's
 * menu instead.
 *
 * Elsewhere the app's primary modifier is Ctrl, which is also the shell's.
 * Ctrl chords stay with the shell (Ctrl+C, Ctrl+D, Ctrl+W, Ctrl+R…), except
 * Ctrl+K and Ctrl+P: like VS Code, they open the command palette and quick
 * open rather than kill-line and previous-command, and Ctrl+1–9, which pick
 * a dock tab (shells give digits no Ctrl meaning).
 *
 * On every OS, Ctrl+Tab and Ctrl+Shift+Tab step through the dock tabs, as
 * in editors: a shell has no use for them. So does Control+Alt with an
 * arrow, which sends the tab to a side. Control with the backquote key
 * stays with the shell: the app has no terminal key.
 *
 * The terminal also owns a few chords of its own (``terminalShortcut``): find
 * (⌘F, or Ctrl+Shift+F elsewhere, so plain Ctrl+F still reaches the shell),
 * add the selection to the chat (⌘L / Ctrl+L, only while text is selected, so
 * Ctrl+L still clears the screen otherwise), and on Windows/Linux the
 * terminal convention Ctrl+Shift+C / Ctrl+Shift+V for copy and paste. macOS
 * ⌘C / ⌘V are the browser's copy and paste events, which xterm handles.
 */
import type { OS } from '@/hooks/use-platform'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'

/** Ctrl chords that skip the shell on Windows/Linux. */
const APP_KEYS_OVER_SHELL = new Set(['k', 'p', '1', '2', '3', '4', '5', '6', '7', '8', '9'])

const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

export type TerminalShortcut = 'find' | 'copy' | 'paste' | 'add-to-chat'

/** The add-to-chat chord as shown in a tooltip. */
export function addToChatShortcutLabel(os: OS): string {
  return isPrimaryModifierOS(os) ? '⌘L' : 'Ctrl+L'
}

/**
 * The terminal action a key chord stands for, or ``null`` for every key that
 * goes to the shell or the app. ``hasSelection`` gates add-to-chat, which
 * would otherwise take Ctrl+L (clear screen) and ⌘L (workspace switcher).
 */
export function terminalShortcut(event: KeyboardEvent, os: OS, hasSelection = false): TerminalShortcut | null {
  if (event.type !== 'keydown' || event.altKey) return null
  const key = event.key.toLowerCase()
  if (isPrimaryModifierOS(os)) {
    if (!event.metaKey || event.ctrlKey || event.shiftKey) return null
    if (key === 'f') return 'find'
    if (key === 'l' && hasSelection) return 'add-to-chat'
    return null
  }
  if (!event.ctrlKey || event.metaKey) return null
  if (event.shiftKey) {
    if (key === 'f') return 'find'
    if (key === 'c') return 'copy'
    if (key === 'v') return 'paste'
    return null
  }
  return key === 'l' && hasSelection ? 'add-to-chat' : null
}

/**
 * xterm custom key handler body: returns ``false`` when xterm must not
 * process the key. The event is left unclaimed so the app shortcut runs.
 * A terminal shortcut returns ``false`` too, and the caller runs its action.
 */
export function routeTerminalKey(event: KeyboardEvent, os: OS, hasSelection = false): boolean {
  if (event.type !== 'keydown') return true
  if (terminalShortcut(event, os, hasSelection)) return false
  if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) return false
  if (ARROWS.has(event.key) && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) return false
  if (isPrimaryModifierOS(os)) return true
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return true
  const digit = /^Digit[1-9]$/.test(event.code) ? event.code.slice(5) : null
  return !APP_KEYS_OVER_SHELL.has(digit ?? event.key.toLowerCase())
}
