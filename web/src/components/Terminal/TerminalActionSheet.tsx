/**
 * TerminalActionSheet — the long-press menu of the terminal surface on touch.
 *
 * Touch has no context menu, so a long press (``use-terminal-touch.ts``)
 * opens the shared phone action sheet with the terminal's touch menu
 * (``terminal-menu.ts``): Select Text, Paste, Find and Clear. Fed a
 * callback, so it has no xterm import and is testable without the renderer.
 */
import { ActionSheet } from '@/components/ui/action-sheet'
import { TOUCH_MENU_ITEMS, type TerminalMenuAction } from './terminal-menu'

interface TerminalActionSheetProps {
  open: boolean
  onClose: () => void
  onAction: (action: TerminalMenuAction) => void
}

export function TerminalActionSheet({ open, onClose, onAction }: TerminalActionSheetProps) {
  const items = TOUCH_MENU_ITEMS.map((item) => ({
    id: item.action,
    label: item.label,
    icon: item.icon,
    separatorBefore: item.separatorBefore,
    run: () => onAction(item.action),
  }))
  return <ActionSheet open={open} onClose={onClose} title="Terminal" items={items} />
}
