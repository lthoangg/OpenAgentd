import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

import { RESIZE_KEY_STEP, RESIZE_KEY_STEP_LARGE } from '@/lib/workbench-layout'

/**
 * usePanelResize — controlled resize handle for a side panel.
 *
 * The owner keeps the committed width (usually in ``useLayoutStore``); this
 * hook only tracks the live width while a drag is in flight so a drag does
 * not write persisted state on every frame. The returned ``handleProps`` make
 * the separator reachable by keyboard (arrows ±16px, Shift ±64px, Home/End,
 * Enter or double-click to reset) as well as by pointer.
 */
export interface PanelResizeOptions {
  /** Committed width in px. */
  width: number
  min: number
  max: number
  /** Panel edge that carries the handle: ``right`` grows to the right. */
  edge: 'left' | 'right'
  onCommit: (width: number) => void
  onReset?: () => void
  disabled?: boolean
  label: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function usePanelResize({ width, min, max, edge, onCommit, onReset, disabled = false, label }: PanelResizeOptions) {
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const latestRef = useRef(width)
  const cleanupRef = useRef<(() => void) | null>(null)
  const upper = Math.max(min, max)
  const current = Math.round(clamp(dragWidth ?? width, min, upper))

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    cleanupRef.current?.()
  }, [])

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || event.pointerType === 'touch' || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const startX = event.clientX
    const startWidth = clamp(width, min, upper)
    latestRef.current = startWidth
    setDragWidth(startWidth)

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = edge === 'right' ? moveEvent.clientX - startX : startX - moveEvent.clientX
      latestRef.current = clamp(startWidth + delta, min, upper)
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setDragWidth(latestRef.current)
      })
    }

    const finish = () => {
      cleanup()
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      setDragWidth(null)
      onCommit(Math.round(latestRef.current))
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      cleanupRef.current = null
    }

    cleanupRef.current?.()
    cleanupRef.current = cleanup
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [disabled, edge, min, onCommit, upper, width])

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (disabled) return
    const step = event.shiftKey ? RESIZE_KEY_STEP_LARGE : RESIZE_KEY_STEP
    const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight'
    let next: number | null = null
    if (event.key === grow) next = current + step
    else if (event.key === shrink) next = current - step
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = upper
    else if (event.key === 'Enter') {
      event.preventDefault()
      onReset?.()
      return
    }
    if (next === null) return
    event.preventDefault()
    onCommit(Math.round(clamp(next, min, upper)))
  }, [current, disabled, edge, min, onCommit, onReset, upper])

  return {
    width: current,
    isResizing: dragWidth !== null,
    handleProps: {
      role: 'separator' as const,
      'aria-orientation': 'vertical' as const,
      'aria-label': label,
      'aria-valuemin': Math.round(min),
      'aria-valuemax': Math.round(upper),
      'aria-valuenow': current,
      tabIndex: disabled ? -1 : 0,
      title: 'Drag to resize · double-click to reset',
      onPointerDown: startResize,
      onDoubleClick: () => { if (!disabled) onReset?.() },
      onKeyDown: handleKeyDown,
    },
  }
}

/**
 * Shared separator geometry: a 6px hit area inside the panel's resizable
 * edge (panels clip overflow while their width animates) with a 1px line over
 * the border that lights up in the interaction color on hover, drag, or
 * keyboard focus.
 */
export function panelResizeHandleClass(edge: 'left' | 'right', active: boolean): string {
  return [
    'absolute top-0 z-20 flex h-full w-1.5 cursor-col-resize outline-none',
    edge === 'right' ? 'right-0 justify-end' : 'left-0 justify-start',
    'after:h-full after:w-px after:bg-transparent after:transition-colors after:duration-(--motion-fast)',
    'hover:after:w-0.5 hover:after:bg-(--color-border-strong) focus-visible:after:w-0.5 focus-visible:after:bg-(--focus-outline)',
    active ? 'after:w-0.5 after:bg-(--color-text-muted)' : '',
  ].join(' ')
}
