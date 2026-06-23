import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

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
  const [isResizing, setIsResizing] = useState(false)
  const frameRef = useRef<number | null>(null)
  const latestWidthRef = useRef(clamp(width, minWidth, maxWidth))
  const clampedWidth = clamp(width, minWidth, maxWidth)

  useEffect(() => {
    latestWidthRef.current = clampedWidth
  }, [clampedWidth])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  const persistWidth = useCallback((nextWidth: number) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(storageKey, String(nextWidth))
  }, [storageKey])

  const resetWidth = useCallback(() => {
    setWidth(defaultWidth)
    latestWidthRef.current = defaultWidth
    persistWidth(defaultWidth)
  }, [defaultWidth, persistWidth])

  const startResize = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (disabled || event.pointerType === 'touch') return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = latestWidthRef.current

    setIsResizing(true)

    const scheduleWidth = (nextWidth: number) => {
      latestWidthRef.current = nextWidth
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        setWidth(latestWidthRef.current)
      })
    }

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = edge === 'right' ? moveEvent.clientX - startX : startX - moveEvent.clientX
      scheduleWidth(clamp(startWidth + delta, minWidth, maxWidth))
    }

    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      setWidth(latestWidthRef.current)
      persistWidth(latestWidthRef.current)
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
  }, [disabled, edge, maxWidth, minWidth, persistWidth])

  return { width: clampedWidth, isResizing, startResize, resetWidth }
}
