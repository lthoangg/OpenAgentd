/**
 * The terminal surface's menu in its two forms: the long-press action sheet
 * on touch and the right-click menu with a pointer.
 *
 * Touch gets Select Text, Paste, Find and Clear (``TOUCH_MENU_ITEMS``). xterm
 * cannot select by touch, so Copy and Add to chat would almost always be
 * greyed out, and Select All would take 5000 lines to copy in a second trip:
 * Select Text shows the output as plain text with its own Copy and Add to
 * chat instead. A pointer gets the full menu with the keys spelled on each
 * row (``terminalMenuItems``).
 */
import { CheckSquare, ClipboardPaste, Copy, Eraser, MessageSquarePlus, Search, TextSelect, type LucideIcon } from 'lucide-react'

import type { OS } from '@/hooks/use-platform'
import { formatChord } from '@/lib/keyboard/chord'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import { addToChatShortcutLabel } from './terminal-keys'

export type TerminalMenuAction = 'select-text' | 'copy' | 'paste' | 'select-all' | 'find' | 'add-to-chat' | 'clear'

export interface TerminalMenuItem {
  action: TerminalMenuAction
  label: string
  icon: LucideIcon
  disabled?: boolean
  separatorBefore?: boolean
  /** The key that does the same, spelled for the pointer menu. */
  keys?: string
}

/** A terminal chord: ⌘ + key on macOS, Ctrl+Shift + key elsewhere (plain Ctrl is the shell's). */
function terminalChord(key: string, os: OS): string {
  return formatChord(isPrimaryModifierOS(os) ? { key, mod: true } : { key, ctrl: true, shift: true }, os)
}

export const TOUCH_MENU_ITEMS: readonly TerminalMenuItem[] = [
  { action: 'select-text', label: 'Select Text', icon: TextSelect },
  { action: 'paste', label: 'Paste', icon: ClipboardPaste },
  { action: 'find', label: 'Find', icon: Search, separatorBefore: true },
  { action: 'clear', label: 'Clear', icon: Eraser, separatorBefore: true },
]

/** The pointer menu, with each row's keys. */
export function terminalMenuItems({ hasSelection, os }: { hasSelection: boolean; os: OS }): TerminalMenuItem[] {
  const keys = (key: string) => terminalChord(key, os)
  return [
    { action: 'copy', label: 'Copy', icon: Copy, disabled: !hasSelection, keys: keys('c') },
    { action: 'paste', label: 'Paste', icon: ClipboardPaste, keys: keys('v') },
    { action: 'select-all', label: 'Select All', icon: CheckSquare },
    { action: 'find', label: 'Find', icon: Search, separatorBefore: true, keys: keys('f') },
    { action: 'add-to-chat', label: 'Add to chat', icon: MessageSquarePlus, disabled: !hasSelection, keys: addToChatShortcutLabel(os) },
    { action: 'clear', label: 'Clear', icon: Eraser, separatorBefore: true },
  ]
}
