/**
 * The bar between the Review panel's two groups: drag it to share the
 * height, double-click or Enter to go back to the default, arrows (Shift
 * for bigger steps) from the keyboard. Like the column separators, it is a
 * focusable ``role="separator"`` whose hairline lights up in the focus
 * colour; the drag area is 6px around a 1px line.
 */
import { useRef, useState } from 'react'

import {
  DOCK_GROUP_MIN_HEIGHT,
  RESIZE_KEY_STEP,
  RESIZE_KEY_STEP_LARGE,
  clampSplitRatio,
} from '@/lib/workbench-layout'
import { cn } from '@/lib/utils'

export function GroupSplitHandle({
  ratio,
  containerRef,
  onLive,
  onCommit,
  onReset,
}: {
  /** The upper group's share now (live while dragging). */
  ratio: number
  /** The element both groups share, to measure from. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Every move while dragging. */
  onLive: (ratio: number) => void
  /** The settled share (drag end, a key step). */
  onCommit: (ratio: number) => void
  onReset: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const latest = useRef(ratio)
  latest.current = ratio
  const height = () => containerRef.current?.getBoundingClientRect().height ?? 0

  const ratioAt = (clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return latest.current
    return clampSplitRatio((clientY - rect.top) / rect.height, rect.height)
  }

  const stepBy = (px: number) => {
    const h = height()
    if (h <= DOCK_GROUP_MIN_HEIGHT * 2) return
    onCommit(clampSplitRatio(latest.current + px / h, h))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize Review panel groups"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      data-group-split=""
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={(event) => {
        if (dragging) onLive(ratioAt(event.clientY))
      }}
      onPointerUp={(event) => {
        if (!dragging) return
        setDragging(false)
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        onCommit(ratioAt(event.clientY))
      }}
      onPointerCancel={() => {
        setDragging(false)
        onCommit(latest.current)
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? RESIZE_KEY_STEP_LARGE : RESIZE_KEY_STEP
        if (event.key === 'ArrowUp') stepBy(-step)
        else if (event.key === 'ArrowDown') stepBy(step)
        else if (event.key === 'Enter') onReset()
        else return
        event.preventDefault()
      }}
      className={cn(
        'group/split relative z-10 -my-[3px] h-[7px] shrink-0 cursor-row-resize touch-none outline-none',
        'before:absolute before:inset-x-0 before:top-[3px] before:h-px before:bg-(--color-border-subtle)',
        'hover:before:bg-(--focus-ring) focus-visible:before:bg-(--focus-ring)',
        dragging && 'before:bg-(--focus-ring)',
      )}
    />
  )
}
