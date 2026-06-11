import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'

interface ResizableWidthOptions {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  edge: 'left' | 'right'
  disabled?: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  edge,
  disabled = false,
}: ResizableWidthOptions) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultWidth
    const stored = window.localStorage.getItem(storageKey)
    const parsed = stored ? Number(stored) : Number.NaN
    return Number.isFinite(parsed) ? clamp(parsed, minWidth, maxWidth) : defaultWidth
  })
  const clampedWidth = clamp(width, minWidth, maxWidth)

  useEffect(() => {
    if (disabled) return
    window.localStorage.setItem(storageKey, String(clampedWidth))
  }, [clampedWidth, disabled, storageKey])

  const resetWidth = useCallback(() => setWidth(defaultWidth), [defaultWidth])

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || event.pointerType === 'touch') return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = clampedWidth

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = edge === 'right' ? moveEvent.clientX - startX : startX - moveEvent.clientX
      setWidth(clamp(startWidth + delta, minWidth, maxWidth))
    }

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
  }, [clampedWidth, disabled, edge, maxWidth, minWidth])

  return { width: clampedWidth, startResize, resetWidth }
}
