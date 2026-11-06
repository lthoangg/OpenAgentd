/**
 * DockOpenMenu — the Review panel's "+" menu: every view and tool the dock
 * can open (``dockOpenItems``), as a context menu where the pointer or the
 * button is. The tab strip's "+" opens it, and on a phone the page's
 * navigation bar does, so the two never drift apart.
 */
import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { CONTEXT_MENU_ITEM_CLASS, ContextMenu, ContextMenuSeparator } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import type { DockOpenItem } from './DockLauncher'
import { MenuKeys } from './MenuKeys'

/** Width the menu is laid out for, so it opens right-aligned under its button. */
export const OPEN_MENU_WIDTH = 192

/** Where a menu of ``OPEN_MENU_WIDTH`` opens under ``button``: right-aligned with it. */
export function menuPointBelow(button: HTMLElement): { x: number; y: number } {
  const rect = button.getBoundingClientRect()
  return { x: rect.right - OPEN_MENU_WIDTH, y: rect.bottom + 2 }
}

export function DockOpenMenu({ at, items, onDismiss }: {
  at: { x: number; y: number }
  items: DockOpenItem[]
  onDismiss: () => void
}) {
  return (
    <ContextMenu at={at} label="Open in Review panel" onDismiss={onDismiss} className="w-48">
      {items.map((item, index) => (
        <Fragment key={item.id}>
          {index > 0 && items[index - 1].group !== item.group && <ContextMenuSeparator />}
          <button
            type="button"
            role="menuitem"
            aria-label={item.open ? `${item.label} (open)` : item.label}
            className={cn(CONTEXT_MENU_ITEM_CLASS, 'pointer-coarse:h-9 pointer-coarse:text-sm')}
            onClick={() => { onDismiss(); item.run() }}
          >
            {item.icon}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <MenuKeys>{item.shortcut}</MenuKeys>}
            {item.open && <Check size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />}
          </button>
        </Fragment>
      ))}
    </ContextMenu>
  )
}
