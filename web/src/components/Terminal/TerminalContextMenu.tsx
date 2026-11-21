/**
 * TerminalContextMenu — right-click on the terminal surface with a pointer:
 * the same menu as the touch action sheet (``terminal-menu.ts``) with each
 * row's key, in place of the webview's text-field menu that xterm's hidden
 * input would otherwise get.
 */
import { Fragment } from 'react'

import { CONTEXT_MENU_ITEM_CLASS, ContextMenu, ContextMenuSeparator } from '@/components/ui/context-menu'
import { MenuKeys } from '@/components/WorkspacePanel/MenuKeys'
import type { OS } from '@/hooks/use-platform'
import { terminalMenuItems, type TerminalMenuAction } from './terminal-menu'

interface TerminalContextMenuProps {
  at: { x: number; y: number }
  onDismiss: () => void
  hasSelection: boolean
  os: OS
  onAction: (action: TerminalMenuAction) => void
}

export function TerminalContextMenu({ at, onDismiss, hasSelection, os, onAction }: TerminalContextMenuProps) {
  return (
    <ContextMenu at={at} label="Terminal" onDismiss={onDismiss} className="min-w-48">
      {terminalMenuItems({ hasSelection, os }).map(({ action, label, icon: Icon, disabled, separatorBefore, keys }) => (
        <Fragment key={action}>
          {separatorBefore && <ContextMenuSeparator />}
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => {
              onDismiss()
              onAction(action)
            }}
          >
            <Icon size={12} aria-hidden="true" />
            <span className="flex-1">{label}</span>
            {keys && <MenuKeys>{keys}</MenuKeys>}
          </button>
        </Fragment>
      ))}
    </ContextMenu>
  )
}
