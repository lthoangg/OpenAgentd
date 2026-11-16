/**
 * The terminal surface's menu, one list for both forms: the long-press
 * action sheet on touch and the right-click menu with a pointer. Touch adds
 * Select Text first (xterm cannot select part of its output by touch); a
 * pointer gets the keys spelled on each row.
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

export function terminalMenuItems({ touch, hasSelection, os }: { touch: boolean; hasSelection: boolean; os: OS }): TerminalMenuItem[] {
  const keys = (key: string) => (touch ? undefined : terminalChord(key, os))
  const items: TerminalMenuItem[] = []
  if (touch) items.push({ action: 'select-text', label: 'Select Text', icon: TextSelect })
  items.push(
    { action: 'copy', label: 'Copy', icon: Copy, disabled: !hasSelection, keys: keys('c') },
    { action: 'paste', label: 'Paste', icon: ClipboardPaste, keys: keys('v') },
    { action: 'select-all', label: 'Select All', icon: CheckSquare },
    { action: 'find', label: 'Find', icon: Search, separatorBefore: true, keys: keys('f') },
    {
      action: 'add-to-chat',
      label: 'Add to chat',
      icon: MessageSquarePlus,
      disabled: !hasSelection,
      keys: touch ? undefined : addToChatShortcutLabel(os),
    },
    { action: 'clear', label: 'Clear', icon: Eraser, separatorBefore: true },
  )
  return items
}
