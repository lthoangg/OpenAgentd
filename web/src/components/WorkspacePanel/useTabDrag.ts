/**
 * Drag dock tabs to reorder them, editor style: pick a tab up and carry it.
 *
 * Handlers go on the scrolling strip and find the tab under the pointer by
 * ``data-dock-tab``, so every tab kind (terminals included) moves the same
 * way. A press becomes a drag after 4 px, so a click still activates and a
 * middle-click still closes. While dragging, the lifted tab follows the
 * pointer (kept inside the strip) and the tabs it passes slide aside to
 * show where it will land; nothing reorders until release. Escape or a
 * cancelled pointer puts it back. The strip scrolls while the pointer sits
 * near an edge. Mouse and pen only: touch keeps the strip's native scrolling.
 *
 * The motion is inline ``transform`` on the tab nodes, not React state, so a
 * drag re-renders nothing until the drop.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

const DRAG_THRESHOLD_PX = 4
const EDGE_PX = 24
const EDGE_SCROLL_PX = 8
const SLIDE = 'transform var(--motion-fast) var(--ease-out)'

export const DOCK_TAB_ATTR = 'data-dock-tab'
const DRAGGING_ATTR = 'data-dragging'

interface Lift {
  nodes: HTMLElement[]
  rects: { left: number; right: number }[]
  from: number
  to: number
  scroll0: number
}

interface DragState {
  id: string
  pointerId: number
  startX: number
  x: number
  active: boolean
  lift: Lift | null
}

function tabNodes(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>(`[${DOCK_TAB_ATTR}]`))
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** Where the dragged tab belongs for a pointer at ``x``, or ``null`` to stay. */
export function dropIndex(rects: readonly { left: number; right: number }[], from: number, x: number): number | null {
  const mid = (i: number) => (rects[i].left + rects[i].right) / 2
  // Past a neighbour's midpoint, the tab takes its place.
  let to = from
  for (let i = from + 1; i < rects.length; i++) if (x > mid(i)) to = i
  if (to === from) for (let i = from - 1; i >= 0; i--) if (x < mid(i)) to = i
  return to === from ? null : to
}

/** Drop every inline style a drag set, without animating back. */
function settle(nodes: readonly HTMLElement[]): void {
  for (const node of nodes) {
    node.style.transition = 'none'
    node.style.transform = ''
    node.style.zIndex = ''
    node.removeAttribute(DRAGGING_ATTR)
  }
  requestAnimationFrame(() => {
    for (const node of nodes) node.style.transition = ''
  })
}

export function useTabDrag({ enabled, onMove }: { enabled: boolean; onMove: (id: string, toIndex: number) => void }) {
  const dragRef = useRef<DragState | null>(null)
  const stripRef = useRef<HTMLElement | null>(null)
  const frameRef = useRef(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const stop = useCallback((drop: boolean) => {
    const drag = dragRef.current
    dragRef.current = null
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    setDraggingId(null)
    const lift = drag?.lift
    if (!drag || !lift) return
    settle(lift.nodes)
    if (drop && lift.to !== lift.from) onMove(drag.id, lift.to)
  }, [onMove])
  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  // Escape puts a lifted tab back, as in an editor.
  useEffect(() => {
    if (!draggingId) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      stop(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [draggingId, stop])

  const place = useCallback(() => {
    const drag = dragRef.current
    const strip = stripRef.current
    const lift = drag?.lift
    if (!drag?.active || !strip || !lift) return
    const { nodes, rects, from } = lift
    // Rects were measured at pick-up; scrolling since moves the content.
    const x = drag.x + (strip.scrollLeft - lift.scroll0)
    const to = dropIndex(rects, from, x) ?? from
    lift.to = to
    const width = rects[from].right - rects[from].left
    const minDx = rects[0].left - rects[from].left
    const maxDx = rects[rects.length - 1].right - rects[from].right
    const dx = Math.max(minDx, Math.min(maxDx, x - drag.startX))
    const slide = reducedMotion() ? 'none' : SLIDE
    nodes.forEach((node, i) => {
      if (i === from) {
        node.style.transition = 'none'
        node.style.transform = `translateX(${dx}px)`
        return
      }
      const offset = from < to && i > from && i <= to ? -width : to < from && i >= to && i < from ? width : 0
      node.style.transition = slide
      node.style.transform = offset ? `translateX(${offset}px)` : ''
    })
  }, [])

  // Near an edge, keep scrolling (and re-placing) while the pointer rests.
  const edgeScroll = useCallback(() => {
    frameRef.current = 0
    const drag = dragRef.current
    const strip = stripRef.current
    if (!drag?.active || !strip) return
    const box = strip.getBoundingClientRect()
    const step = drag.x < box.left + EDGE_PX ? -EDGE_SCROLL_PX : drag.x > box.right - EDGE_PX ? EDGE_SCROLL_PX : 0
    if (step === 0) return
    const before = strip.scrollLeft
    strip.scrollLeft += step
    if (strip.scrollLeft === before) return
    place()
    frameRef.current = requestAnimationFrame(edgeScroll)
  }, [place])

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || event.pointerType === 'touch') return
    const target = event.target as Element
    // The close button is a click target, and a rename field selects text.
    if (target.closest('[data-dock-tab-close], input')) return
    const id = target.closest(`[${DOCK_TAB_ATTR}]`)?.getAttribute(DOCK_TAB_ATTR)
    if (!id) return
    stripRef.current = event.currentTarget
    dragRef.current = { id, pointerId: event.pointerId, startX: event.clientX, x: event.clientX, active: false, lift: null }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    const strip = stripRef.current
    if (!drag || !strip || drag.pointerId !== event.pointerId) return
    drag.x = event.clientX
    if (!drag.active) {
      if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return
      const nodes = tabNodes(strip)
      const from = nodes.findIndex((node) => node.getAttribute(DOCK_TAB_ATTR) === drag.id)
      if (from < 0) {
        dragRef.current = null
        return
      }
      drag.active = true
      drag.lift = {
        nodes,
        rects: nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return { left: rect.left, right: rect.right }
        }),
        from,
        to: from,
        scroll0: strip.scrollLeft,
      }
      nodes[from].setAttribute(DRAGGING_ATTR, '')
      nodes[from].style.zIndex = '10'
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setDraggingId(drag.id)
    }
    place()
    if (!frameRef.current) frameRef.current = requestAnimationFrame(edgeScroll)
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    stop(true)
  }
  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    stop(false)
  }

  return {
    draggingId,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  }
}
