/**
 * App menus for chat content: links, code blocks, messages.
 *
 * A transcript surface offers its own actions: Open / Copy link, Copy code,
 * Copy response, Copy / Edit a message. The same items open three ways:
 *
 * - Right-click (the desktop app and the browser alike) opens a floating menu
 *   at the pointer; Shift+F10 or the ContextMenu key opens it at the item.
 *   In the desktop app this also stands in for the webview's own menu
 *   (Reload, Inspect, "Open Link" inside the app), which
 *   ``lib/desktop-shell.ts`` suppresses.
 * - A long press (touch) opens the items as a bottom sheet, with a light
 *   haptic; the press is the house hold (``lib/chat-long-press``). In the
 *   iPhone and iPad app too: the app's sheet, not the system's action sheet.
 * - Selected text always keeps the system menu, which has Copy: a right-click
 *   or a long press over a selection opens nothing of ours.
 *
 * The innermost surface wins: a link inside a message opens the link menu,
 * and the message's handler sees the event already handled.
 */
import { Suspense, lazy, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'

import { CONTEXT_MENU_ITEM_CLASS, ContextMenu } from '@/components/ui/context-menu'
import { hasTextSelection } from '@/lib/desktop-shell'
import { isMenuKey, menuPointFor } from '@/lib/focus/item-keys'
import { registerLongPressSurface } from '@/lib/chat-long-press'
import { softHapticFeedback } from '@/lib/haptics'

export interface ChatMenuItem {
  label: string
  run: () => void
}

function coarsePointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
}

// Loaded on the first long press (or ahead of it on a touch device), not with
// every surface: the sheet pulls in the motion library.
const loadSheet = () => import('./ChatMenuSheet')
const ChatMenuSheet = lazy(loadSheet)

/** Text fields keep the system menu (Paste, Spelling). */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

// The menu is portalled, but React events still bubble through the tree:
// keep its clicks and keys from reaching the link or message that opened it.
const stop = (event: SyntheticEvent) => event.stopPropagation()

/**
 * Handlers for a surface plus the menu to render; ``items`` is read on open.
 *
 * Spread ``onContextMenu`` and ``onKeyDown`` on the surface and render
 * ``menu`` inside it: ``menu`` also carries a hidden marker whose parent is
 * the element the long press attaches to.
 */
export function useChatMenu(label: string, items: () => ChatMenuItem[]) {
  const [open, setOpen] = useState<{ x: number; y: number; items: ChatMenuItem[] } | null>(null)
  // Kept after it closes so the sheet can slide out; ``open`` says whether it is up.
  const [sheet, setSheet] = useState<{ items: ChatMenuItem[]; open: boolean } | null>(null)
  const sheetUp = useRef(false)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })

  const show = (x: number, y: number) => {
    const list = items()
    if (list.length > 0) setOpen({ x, y, items: list })
  }
  const showSheet = () => {
    if (sheetUp.current) return
    const list = itemsRef.current()
    if (list.length === 0) return
    sheetUp.current = true
    softHapticFeedback()
    setSheet({ items: list, open: true })
  }
  const closeSheet = () => {
    sheetUp.current = false
    setSheet((current) => (current ? { ...current, open: false } : current))
  }

  // The long press hangs on the surface the hidden marker sits in.
  const showSheetRef = useRef(showSheet)
  useEffect(() => {
    showSheetRef.current = showSheet
  })
  useEffect(() => {
    const surface = anchorRef.current?.parentElement
    // A touch device is about to long-press something: have the sheet ready.
    if (coarsePointer()) void loadSheet()
    return surface ? registerLongPressSurface(surface, () => showSheetRef.current()) : undefined
  }, [])

  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (event.isDefaultPrevented() || hasTextSelection() || isEditable(event.target)) return
    event.preventDefault()
    // A touch device's long press can arrive as a context menu event too
    // (Android): it opens the sheet, not a floating menu under a thumb.
    if (coarsePointer()) showSheet()
    else show(event.clientX, event.clientY)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.isDefaultPrevented() || !isMenuKey(event) || coarsePointer()) return
    event.preventDefault()
    const at = menuPointFor(event.target instanceof HTMLElement ? event.target : event.currentTarget)
    show(at.clientX, at.clientY)
  }

  const menu: ReactNode = (
    <>
      <span ref={anchorRef} hidden data-chat-menu-anchor="" />
      {open &&
        createPortal(
          <div className="contents" onClick={stop} onContextMenu={stop} onKeyDown={stop} onPointerDown={stop}>
            <ContextMenu at={open} label={label} onDismiss={() => setOpen(null)}>
              {open.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={CONTEXT_MENU_ITEM_CLASS}
                  onClick={() => {
                    setOpen(null)
                    item.run()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </ContextMenu>
          </div>,
          document.body,
        )}
      {sheet &&
        createPortal(
          <div className="contents" onClick={stop} onContextMenu={stop} onKeyDown={stop} onPointerDown={stop}>
            <Suspense fallback={null}>
              <ChatMenuSheet open={sheet.open} label={label} items={sheet.items} onClose={closeSheet} />
            </Suspense>
          </div>,
          document.body,
        )}
    </>
  )
  return { onContextMenu, onKeyDown, menu }
}

export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {})
}
