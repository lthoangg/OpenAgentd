/**
 * ToolRow — the transcript's tool row with the same action menu a message or
 * a code block has (``ChatContextMenu``): right-click, Shift+F10 or the
 * ContextMenu key open a floating menu, a touch long press opens the items as
 * a bottom sheet.
 *
 * The long press hangs on the element that holds the menu's hidden marker, and
 * a row with details is a ``<button>`` whose children sit in a wrapper
 * (``MetaRow``): the marker would land on the wrapper and miss the meta
 * column. So the marker lives in an invisible layer covering the row. A press
 * on the layer is a press on the surface itself, and a tap on it still
 * reaches the row (its click bubbles up).
 *
 * The row is a ``div`` until it has details, then a ``button``: a new element
 * remounts the layer, and the menu registers its touch surface once, when it
 * mounts, so the caller keys this component on that change.
 *
 * Some touch browsers send a click when the finger lifts after a hold: a press
 * held for the long-press time swallows that click, so opening the sheet does
 * not also open the row behind it.
 */
import { useEffect, useRef, type ComponentProps, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

import { MetaRow } from '@/components/ui/meta-row'
import { LONG_PRESS_MOVE_TOLERANCE, LONG_PRESS_MS } from '@/hooks/use-long-press'
import { cn } from '@/lib/utils'
import { useChatMenu, type ChatMenuItem } from '../ChatContextMenu'

type ToolRowProps = ComponentProps<typeof MetaRow> & {
  /** Names the menu, e.g. ``Actions for shell``. */
  menuLabel: string
  /** The menu's items, read when it opens; with none, nothing opens. */
  menuItems: () => ChatMenuItem[]
}

export function ToolRow({ menuLabel, menuItems, className, children, ...row }: ToolRowProps) {
  const chatMenu = useChatMenu(menuLabel, menuItems)
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null; held: boolean } | null>(null)

  const endPress = () => {
    if (press.current?.timer) clearTimeout(press.current.timer)
    if (press.current) press.current.timer = null
  }
  useEffect(() => endPress, [])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    endPress()
    press.current = null
    // A mouse keeps right-click; a finger or a pen holds.
    if (event.pointerType === 'mouse') return
    const current = { x: event.clientX, y: event.clientY, held: false, timer: null as ReturnType<typeof setTimeout> | null }
    current.timer = setTimeout(() => {
      current.timer = null
      current.held = true
    }, LONG_PRESS_MS)
    press.current = current
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = press.current
    if (!current?.timer) return
    if (Math.abs(event.clientX - current.x) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(event.clientY - current.y) > LONG_PRESS_MOVE_TOLERANCE) {
      endPress()
    }
  }
  const onPointerCancel = () => {
    endPress()
    press.current = null
  }
  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    // The sheet is portalled but its events still pass through this row in
    // React's tree: only a click that landed on the row itself is the hold's.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return
    const held = press.current?.held
    press.current = null
    if (!held) return
    event.preventDefault()
    event.stopPropagation()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Enter on the row after a hold is a new action, not the hold's click.
    press.current = null
    if (menuItems().length > 0) chatMenu.onKeyDown(event)
  }
  // A row with nothing to copy yet leaves right-click to the browser, rather
  // than swallowing it for a menu that never opens.
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (menuItems().length > 0) chatMenu.onContextMenu(event)
  }

  return (
    <MetaRow
      {...row}
      // A held row opens the app's sheet, not the system callout.
      className={cn('relative [-webkit-touch-callout:none]', className)}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
    >
      <span aria-hidden="true" data-slot="tool-row-surface" className="absolute inset-0">
        {chatMenu.menu}
      </span>
      {children}
    </MetaRow>
  )
}
