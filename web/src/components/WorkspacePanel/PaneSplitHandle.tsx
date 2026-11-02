/**
 * The bar between two Review panel panes: drag it to share their room,
 * double-click or Enter to even out the split, arrows (Shift for bigger
 * steps) from the keyboard. Like the column separators, it is a focusable
 * ``role="separator"`` whose hairline lights up in the focus colour; the
 * drag area is 7px around a 1px line. The dock places it and turns pointer
 * positions into sizes (``sizesWithBarAt``).
 */
import { useState, type CSSProperties } from 'react'

import { RESIZE_KEY_STEP, RESIZE_KEY_STEP_LARGE } from '@/lib/workbench-layout'
import { cn } from '@/lib/utils'
import type { Axis } from './dock-panes'

export function PaneSplitHandle({
  axis,
  style,
  valueNow,
  onDrag,
  onStep,
  onReset,
}: {
  /** The split's axis: a ``row`` bar stands upright and moves sideways. */
  axis: Axis
  /** Where the bar sits over the panes. */
  style: CSSProperties
  /** The pane before the bar: its share of the two, in percent. */
  valueNow: number
  /** A pointer position while dragging (``done`` on release). */
  onDrag: (clientX: number, clientY: number, done: boolean) => void
  /** A keyboard step, in px (negative: towards the start). */
  onStep: (px: number) => void
  onReset: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const row = axis === 'row'
  const back = row ? 'ArrowLeft' : 'ArrowUp'
  const forth = row ? 'ArrowRight' : 'ArrowDown'
  return (
    <div
      role="separator"
      // A bar between side-by-side panes is vertical.
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize panes"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={valueNow}
      tabIndex={0}
      data-pane-split={axis}
      style={style}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={(event) => {
        if (dragging) onDrag(event.clientX, event.clientY, false)
      }}
      onPointerUp={(event) => {
        if (!dragging) return
        setDragging(false)
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        onDrag(event.clientX, event.clientY, true)
      }}
      onPointerCancel={(event) => {
        if (!dragging) return
        setDragging(false)
        onDrag(event.clientX, event.clientY, true)
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? RESIZE_KEY_STEP_LARGE : RESIZE_KEY_STEP
        if (event.key === back) onStep(-step)
        else if (event.key === forth) onStep(step)
        else if (event.key === 'Enter') onReset()
        else return
        event.preventDefault()
      }}
      className={cn(
        'group/split absolute z-10 touch-none outline-none',
        row
          ? 'w-[7px] cursor-col-resize before:absolute before:inset-y-0 before:left-[3px] before:w-px'
          : 'h-[7px] cursor-row-resize before:absolute before:inset-x-0 before:top-[3px] before:h-px',
        // Hover and drag darken the hairline (warm, not Signal Blue); keyboard
        // focus keeps the focus colour.
        'before:bg-(--color-border-subtle) hover:before:bg-(--color-border-strong) focus-visible:before:bg-(--focus-outline)',
        dragging && 'before:bg-(--color-text-muted)',
      )}
    />
  )
}
