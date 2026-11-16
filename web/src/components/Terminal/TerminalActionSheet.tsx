/**
 * TerminalActionSheet — the long-press menu of the terminal surface on touch.
 *
 * Touch has no context menu, and xterm's own touch handling takes taps and
 * drags (a drag scrolls), so a long press opens the shared phone action
 * sheet with the terminal's menu (``terminal-menu.ts``): Select Text first,
 * then Copy, Paste, Select All, Find, Add to chat and Clear. Fed a callback,
 * so it has no xterm import and is testable without the renderer.
 */
import { ActionSheet } from '@/components/ui/action-sheet'
import type { OS } from '@/hooks/use-platform'
import { terminalMenuItems, type TerminalMenuAction } from './terminal-menu'

interface TerminalActionSheetProps {
  open: boolean
  onClose: () => void
  hasSelection: boolean
  os: OS
  onAction: (action: TerminalMenuAction) => void
}

export function TerminalActionSheet({ open, onClose, hasSelection, os, onAction }: TerminalActionSheetProps) {
  const items = terminalMenuItems({ touch: true, hasSelection, os }).map((item) => ({
    id: item.action,
    label: item.label,
    icon: item.icon,
    disabled: item.disabled,
    separatorBefore: item.separatorBefore,
    run: () => onAction(item.action),
  }))
  return <ActionSheet open={open} onClose={onClose} title="Terminal" items={items} />
}
