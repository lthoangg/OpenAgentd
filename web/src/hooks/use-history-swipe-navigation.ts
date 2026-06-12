import { useEffect } from 'react'
import { getPlatform } from '@/hooks/use-platform'

const EDGE_ACTIVATION_WIDTH = 32
const NAVIGATION_THRESHOLD = 96
const MAX_VERTICAL_DRIFT = 80
const MIN_HORIZONTAL_DOMINANCE = 1.5

interface SwipeStart {
  pointerId: number
  x: number
  y: number
  edge: 'left' | 'right'
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))
}

function getStartEdge(x: number, viewportWidth: number): SwipeStart['edge'] | null {
  if (x <= EDGE_ACTIVATION_WIDTH) return 'left'
  if (x >= viewportWidth - EDGE_ACTIVATION_WIDTH) return 'right'
  return null
}

function getNavigationDelta(start: SwipeStart, x: number, y: number): number | null {
  const deltaX = x - start.x
  const deltaY = y - start.y
  const absX = Math.abs(deltaX)
  const absY = Math.abs(deltaY)

  if (absX < NAVIGATION_THRESHOLD) return null
  if (absY > MAX_VERTICAL_DRIFT) return null
  if (absX / Math.max(absY, 1) < MIN_HORIZONTAL_DOMINANCE) return null
  if (start.edge === 'left' && deltaX > 0) return -1
  if (start.edge === 'right' && deltaX < 0) return 1
  return null
}

export function useHistorySwipeNavigation(): void {
  useEffect(() => {
    const { isTauri, os } = getPlatform()
    if (!isTauri || os === 'ios' || os === 'android') return

    let start: SwipeStart | null = null
    let navigated = false

    function reset(): void {
      start = null
      navigated = false
    }

    function onPointerDown(event: PointerEvent): void {
      reset()
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
      if (!event.isPrimary || isEditableTarget(event.target)) return

      const edge = getStartEdge(event.clientX, window.innerWidth)
      if (!edge) return

      start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, edge }
      navigated = false
    }

    function onPointerMove(event: PointerEvent): void {
      if (!start || navigated || event.pointerId !== start.pointerId) return

      const direction = getNavigationDelta(start, event.clientX, event.clientY)
      if (direction === null) return

      navigated = true
      event.preventDefault()
      if (direction < 0) {
        window.history.back()
      } else {
        window.history.forward()
      }
    }

    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointermove', onPointerMove, { passive: false })
    window.addEventListener('pointerup', reset, { passive: true })
    window.addEventListener('pointercancel', reset, { passive: true })

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', reset)
      window.removeEventListener('pointercancel', reset)
    }
  }, [])
}
