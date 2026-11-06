/**
 * TerminalTabButton — tab chip for a terminal session in
 * WorkspacePanel (terminal needs an attached workspace).
 *
 * Desktop: right-click opens a small menu (Rename / Clear / Close).
 * Mobile: long-press opens the same choice as a bottom sheet — no native
 * context menu on touch, matching the LongPressButton pattern used
 * elsewhere (Sidebar sessions, changed-files, commits). The × is on every
 * platform (36px on touch), the same ``DockTabCloseButton`` as on the dock's
 * other tabs. The menu spells the keys: F2 renames, ⌘W closes.
 * Rename edits the title in place, like a sidebar session; F2 or a
 * double-click on a desktop tab starts it too.
 * Both funnel into useTerminalStore.rename() / .clear() / .close().
 */

import { useState, type ReactNode } from 'react'
import { Eraser, Pencil, TerminalSquare, X } from 'lucide-react'

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  CONTEXT_MENU_ITEM_CLASS,
  CONTEXT_MENU_ITEM_DANGER_CLASS,
  ContextMenu,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { InlineTitleInput } from '@/components/ui/inline-title-input'
import { LongPressButton } from '@/components/ui/long-press-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { dockTabButtonClass, dockTabClass } from '@/components/WorkspacePanel/dock-tab-styles'
import { DockTabCloseButton } from '@/components/WorkspacePanel/DockTabCloseButton'
import { MenuKeys } from '@/components/WorkspacePanel/MenuKeys'
import { getPlatform, type OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { isMenuKey, isRenameKey, menuPointFor } from '@/lib/focus/item-keys'
import { cn } from '@/lib/utils'
import { useTerminalStore, type TerminalSessionMeta } from '@/stores/useTerminalStore'

interface TerminalTabButtonProps {
  meta: TerminalSessionMeta
  active: boolean
  mobile: boolean
  onActivate: () => void
  className?: string
  buttonRef?: (node: HTMLButtonElement | null) => void
  /** Tab-strip items (Close Others, …) appended to the desktop menu. */
  extraMenuItems?: (dismiss: () => void) => ReactNode
  /** Closes the tab through the dock, which picks the next active tab. */
  onClose?: () => void
  /** The dock strip's tab id, marking the wrapper as a drag handle. */
  dockTabId?: string
  /** Spells the keys in the menu and the × tooltip; read from the platform when omitted. */
  os?: OS
}

export function TerminalTabButton({
  meta,
  active,
  mobile,
  onActivate,
  className,
  buttonRef,
  extraMenuItems,
  onClose,
  dockTabId,
  os: osProp,
}: TerminalTabButtonProps) {
  const [desktopMenuAt, setDesktopMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const close = onClose ?? (() => useTerminalStore.getState().close(meta.id))
  const os = osProp ?? getPlatform().os

  const openRename = () => setRenaming(true)
  // The tab button remounts in place of the field; give it focus back so
  // the keyboard continues from the renamed tab.
  const endRename = () => {
    setRenaming(false)
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === document.body || active === null) {
        document.querySelector<HTMLElement>(`[data-terminal-tab="${CSS.escape(meta.id)}"]`)?.focus({ preventScroll: true })
      }
    })
  }

  return (
    <>
      {/* Same editor-tab chrome as the dock's file/diff/commit tabs: the
          wrapper carries the tab surface, the activate button and the close
          button are siblings (never a control nested inside a button). */}
      <div data-dock-tab={dockTabId} className={cn(dockTabClass(active), className)}>
        {renaming ? (
          <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2">
            <TerminalSquare size={12} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
            <InlineTitleInput
              initial={meta.title}
              label="Terminal name"
              maxLength={64}
              onSubmit={(title) => {
                useTerminalStore.getState().rename(meta.id, title)
                endRename()
              }}
              onCancel={endRename}
              className="h-5 w-32 flex-1 font-mono text-xs"
            />
          </div>
        ) : (
        <Tooltip className="h-full min-w-0 flex-1">
          <TooltipTrigger
            className="h-full min-w-0 flex-1"
            render={
              <LongPressButton
                ref={buttonRef}
                type="button"
                data-terminal-tab={meta.id}
                aria-current={active ? 'true' : undefined}
                enabled={mobile}
                onLongPress={() => {
                  setMobileSheetOpen(true)
                }}
                onContextMenu={(e) => {
                  if (mobile) return
                  e.preventDefault()
                  setDesktopMenuAt({ x: e.clientX, y: e.clientY })
                }}
                onKeyDown={(e) => {
                  if (mobile) return
                  if (isRenameKey(e)) {
                    e.preventDefault()
                    openRename()
                  } else if (isMenuKey(e)) {
                    e.preventDefault()
                    const at = menuPointFor(e.currentTarget)
                    setDesktopMenuAt({ x: at.clientX, y: at.clientY })
                  }
                }}
                onClick={onActivate}
                onDoubleClick={() => {
                  if (!mobile) openRename()
                }}
                onAuxClick={(e) => {
                  if (mobile || e.button !== 1) return
                  e.preventDefault()
                  close()
                }}
                className={cn(dockTabButtonClass(true), 'flex-1')}
              >
                <TerminalSquare size={12} className="shrink-0" aria-hidden="true" />
                <span className="truncate font-mono">{meta.title}</span>
              </LongPressButton>
            }
          />
          <TooltipContent>{meta.title}</TooltipContent>
        </Tooltip>
        )}
        {!renaming && (
          <DockTabCloseButton
            title={meta.title}
            active={active}
            os={os}
            onClick={(e) => {
              e.stopPropagation()
              close()
            }}
          />
        )}
      </div>

      {/* Desktop: right-click menu */}
      {desktopMenuAt && (
        <ContextMenu at={desktopMenuAt} label={`Actions for ${meta.title}`} onDismiss={() => setDesktopMenuAt(null)}>
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => { setDesktopMenuAt(null); openRename() }}
          >
            <Pencil size={12} aria-hidden="true" />
            <span className="flex-1">Rename</span>
            <MenuKeys>F2</MenuKeys>
          </button>
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_CLASS}
            onClick={() => {
              setDesktopMenuAt(null)
              useTerminalStore.getState().clear(meta.id)
            }}
          >
            <Eraser size={12} aria-hidden="true" />
            Clear
          </button>
          <button
            type="button"
            role="menuitem"
            className={CONTEXT_MENU_ITEM_DANGER_CLASS}
            onClick={() => {
              setDesktopMenuAt(null)
              close()
            }}
          >
            <X size={12} aria-hidden="true" />
            <span className="flex-1">Close</span>
            <MenuKeys>{shortcutLabel(APP_SHORTCUTS.closeTab, os)}</MenuKeys>
          </button>
          {extraMenuItems && (
            <>
              <ContextMenuSeparator />
              {extraMenuItems(() => setDesktopMenuAt(null))}
            </>
          )}
        </ContextMenu>
      )}

      {/* Mobile: long-press action sheet */}
      <Dialog open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate pr-8">{meta.title}</DialogTitle>
            <DialogDescription>Choose a terminal action.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col items-stretch gap-2 p-3 sm:flex-col">
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => { setMobileSheetOpen(false); openRename() }}
            >
              <Pencil size={14} aria-hidden="true" />
              Rename
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                setMobileSheetOpen(false)
                useTerminalStore.getState().clear(meta.id)
              }}
            >
              <Eraser size={14} aria-hidden="true" />
              Clear terminal
            </Button>
            <Button
              type="button"
              variant="danger-subtle"
              className="justify-start"
              onClick={() => {
                setMobileSheetOpen(false)
                close()
              }}
              aria-label="Close terminal"
            >
              <X size={14} aria-hidden="true" />
              Close terminal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
