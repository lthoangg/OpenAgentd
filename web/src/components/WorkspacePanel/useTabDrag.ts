/**
 * Drag dock tabs, editor style: pick a tab up and carry it.
 *
 * Handlers go on the scrolling strip and find the tab under the pointer by
 * ``data-dock-tab``, so every tab kind (terminals included) moves the same
 * way. A press becomes a drag after 4 px, so a click still activates and a
 * middle-click still closes. Mouse and pen only: touch keeps the strip's
 * native scrolling.
 *
 * Along its own strip the lifted tab follows the pointer (kept inside the
 * strip) and the tabs it passes slide aside to show where it will land;
 * nothing reorders until release, and the strip scrolls while the pointer
 * sits near an edge. Carried out of the strip (with ``onDrop``), it becomes
 * a floating copy under the pointer, and the place it would land
 * lights up: a caret between the tabs of another pane's strip, the whole of
 * a pane's body (its middle: move there), or the half a split would take (a
 * band along an edge, a fifth of the body's shorter side: split that pane).
 * Its own pane's middle, and its own edges when it is the pane's only tab,
 * are no target. Escape, a cancelled pointer or a release over nothing puts
 * it back.
 *
 * The motion is inline styles on the tab nodes and two floating elements on
 * ``<body>``, not React state, so a drag re-renders nothing until the drop.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { DOCK_PANE_MIN_HEIGHT, DOCK_PANE_MIN_WIDTH } from '@/lib/workbench-layout'
import { DOCK_DROP_CARET_CLASS, DOCK_DROP_ZONE_CLASS, DOCK_TAB_GHOST_CLASS } from './dock-tab-styles'
import type { SplitSide } from './dock-panes'
import type { TabDropTarget } from './useDockTabs'

const DRAG_THRESHOLD_PX = 4
const EDGE_PX = 24
const EDGE_SCROLL_PX = 8
/** How far past its strip the pointer may stray before the tab leaves it. */
const DETACH_PX = 12
/** A pane's split bands: this share of the body's shorter side. */
const SPLIT_BAND = 0.2
const SLIDE = 'transform var(--motion-fast) var(--ease-out)'

export const DOCK_TAB_ATTR = 'data-dock-tab'
const DRAGGING_ATTR = 'data-dragging'

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

interface Lift {
  nodes: HTMLElement[]
  rects: { left: number; right: number }[]
  from: number
  to: number
  scroll0: number
}

interface Carry {
  ghost: HTMLElement
  /** Pointer offset inside the tab where it was picked up. */
  dx: number
  dy: number
  marker: HTMLElement | null
  target: TabDropTarget | null
}

interface DragState {
  id: string
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  active: boolean
  lift: Lift | null
  /** Set while the tab is out of its strip. */
  carry: Carry | null
}

function tabNodes(strip: HTMLElement): HTMLElement[] {
  return Array.from(strip.querySelectorAll<HTMLElement>(`[${DOCK_TAB_ATTR}]`))
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function inside(rect: Rect, x: number, y: number, margin = 0): boolean {
  return x >= rect.left - margin && x <= rect.right + margin && y >= rect.top - margin && y <= rect.bottom + margin
}

function hasArea(rect: Rect): boolean {
  return rect.right > rect.left && rect.bottom > rect.top
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

/**
 * The split a pointer at (``x``, ``y``) asks for over a pane body ``rect``:
 * the nearest edge whose band it is in, if the pane has room for two there.
 */
export function splitSideAt(rect: Rect, x: number, y: number): SplitSide | null {
  const width = rect.right - rect.left
  const height = rect.bottom - rect.top
  const band = Math.min(width, height) * SPLIT_BAND
  const distances: [SplitSide, number, boolean][] = [
    ['left', x - rect.left, width >= DOCK_PANE_MIN_WIDTH * 2],
    ['right', rect.right - x, width >= DOCK_PANE_MIN_WIDTH * 2],
    ['up', y - rect.top, height >= DOCK_PANE_MIN_HEIGHT * 2],
    ['down', rect.bottom - y, height >= DOCK_PANE_MIN_HEIGHT * 2],
  ]
  const near = distances.filter(([, distance, room]) => room && distance <= band).sort((a, b) => a[1] - b[1])
  return near[0]?.[0] ?? null
}

/** The half of ``rect`` a split on ``side`` would take. */
function halfOf(rect: Rect, side: SplitSide): Rect {
  const midX = (rect.left + rect.right) / 2
  const midY = (rect.top + rect.bottom) / 2
  switch (side) {
    case 'left': return { ...rect, right: midX }
    case 'right': return { ...rect, left: midX }
    case 'up': return { ...rect, bottom: midY }
    case 'down': return { ...rect, top: midY }
  }
}

interface Hit {
  target: TabDropTarget
  /** The zone to light, or a caret at ``x`` from ``top`` to ``bottom``. */
  zone?: Rect
  caret?: { x: number; top: number; bottom: number }
}

/**
 * What lies under the pointer for a tab carried out of pane ``own`` (where it
 * is one of ``ownCount`` tabs): another pane's strip, or a pane's body.
 */
function hitTest(root: ParentNode, x: number, y: number, id: string, own: string | null, ownCount: number): Hit | null {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-dock-pane]'))) {
    const rect = node.getBoundingClientRect()
    if (!hasArea(rect) || !inside(rect, x, y)) continue
    const pane = node.getAttribute('data-dock-pane') ?? ''
    const strip = node.querySelector<HTMLElement>('[data-dock-strip]')?.getBoundingClientRect()
    if (strip && hasArea(strip) && inside(strip, x, y)) {
      if (pane === own) return null
      const tabs = Array.from(node.querySelectorAll<HTMLElement>(`[${DOCK_TAB_ATTR}]`)).filter((tab) => tab.getAttribute(DOCK_TAB_ATTR) !== id)
      const boxes = tabs.map((tab) => tab.getBoundingClientRect())
      const index = boxes.filter((box) => (box.left + box.right) / 2 < x).length
      const caretX = index < boxes.length ? boxes[index].left - 1 : boxes.length > 0 ? boxes[boxes.length - 1].right + 1 : strip.left + 4
      return { target: { kind: 'strip', pane, index }, caret: { x: caretX, top: strip.top + 6, bottom: strip.bottom - 6 } }
    }
    const body = node.querySelector<HTMLElement>('[data-dock-pane-body]')?.getBoundingClientRect()
    if (!body || !hasArea(body) || !inside(body, x, y)) return null
    const side = pane !== own || ownCount > 1 ? splitSideAt(body, x, y) : null
    if (side) return { target: { kind: 'split', pane, side }, zone: halfOf(body, side) }
    return pane === own ? null : { target: { kind: 'pane', pane }, zone: body }
  }
  return null
}

/** Drop every inline style a drag set, without animating back. */
function settle(nodes: readonly HTMLElement[]): void {
  for (const node of nodes) {
    node.style.transition = 'none'
    node.style.transform = ''
    node.style.zIndex = ''
    node.style.opacity = ''
    node.removeAttribute(DRAGGING_ATTR)
  }
  requestAnimationFrame(() => {
    for (const node of nodes) node.style.transition = ''
  })
}

function place(element: HTMLElement, rect: Rect): void {
  element.style.left = `${rect.left}px`
  element.style.top = `${rect.top}px`
  element.style.width = `${rect.right - rect.left}px`
  element.style.height = `${rect.bottom - rect.top}px`
}

export function useTabDrag({ enabled, onMove, onDrop }: {
  enabled: boolean
  onMove: (id: string, toIndex: number) => void
  /** Lets a tab leave its strip for another pane, or a pane's edge. */
  onDrop?: (id: string, target: TabDropTarget) => void
}) {
  const dragRef = useRef<DragState | null>(null)
  const stripRef = useRef<HTMLElement | null>(null)
  const frameRef = useRef(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const dropCarry = (drag: DragState) => {
    drag.carry?.ghost.remove()
    drag.carry?.marker?.remove()
    drag.carry = null
  }

  const stop = useCallback((drop: boolean) => {
    const drag = dragRef.current
    dragRef.current = null
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    setDraggingId(null)
    if (stripRef.current) stripRef.current.style.cursor = ''
    const lift = drag?.lift
    if (!drag || !lift) return
    const target = drag.carry?.target ?? null
    const carried = drag.carry !== null
    dropCarry(drag)
    settle(lift.nodes)
    if (!drop) return
    if (carried) {
      if (target) onDrop?.(drag.id, target)
    } else if (lift.to !== lift.from) {
      onMove(drag.id, lift.to)
    }
  }, [onMove, onDrop])
  useEffect(() => () => {
    cancelAnimationFrame(frameRef.current)
    const drag = dragRef.current
    if (drag) dropCarry(drag)
  }, [])

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

  /** Along the strip: the tab follows the pointer, the others make room. */
  const slide = useCallback(() => {
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
    const motion = reducedMotion() ? 'none' : SLIDE
    nodes.forEach((node, i) => {
      if (i === from) {
        node.style.transition = 'none'
        node.style.transform = `translateX(${dx}px)`
        node.style.opacity = ''
        return
      }
      const offset = from < to && i > from && i <= to ? -width : to < from && i >= to && i < from ? width : 0
      node.style.transition = motion
      node.style.transform = offset ? `translateX(${offset}px)` : ''
    })
  }, [])

  /** Out of the strip: the tabs close up behind it and a copy follows the pointer. */
  const carry = useCallback(() => {
    const drag = dragRef.current
    const strip = stripRef.current
    const lift = drag?.lift
    if (!drag?.active || !strip || !lift) return
    const source = lift.nodes[lift.from]
    if (!drag.carry) {
      lift.to = lift.from
      const motion = reducedMotion() ? 'none' : SLIDE
      lift.nodes.forEach((node, i) => {
        node.style.transition = i === lift.from ? 'none' : motion
        node.style.transform = ''
      })
      source.style.opacity = '0.4'
      const box = source.getBoundingClientRect()
      const ghost = source.cloneNode(true) as HTMLElement
      ghost.removeAttribute(DOCK_TAB_ATTR)
      ghost.removeAttribute(DRAGGING_ATTR)
      ghost.setAttribute('aria-hidden', 'true')
      ghost.setAttribute('data-dock-tab-ghost', '')
      ghost.classList.add(...DOCK_TAB_GHOST_CLASS.split(' '))
      Object.assign(ghost.style, { position: 'fixed', margin: '0', zIndex: '9999', pointerEvents: 'none', transform: '', transition: 'none', opacity: '' })
      place(ghost, box)
      document.body.appendChild(ghost)
      drag.carry = { ghost, dx: drag.startX - box.left, dy: Math.min(box.bottom - box.top, Math.max(0, drag.startY - box.top)), marker: null, target: null }
    }
    const held = drag.carry
    held.ghost.style.left = `${drag.x - held.dx}px`
    held.ghost.style.top = `${drag.y - held.dy}px`

    const root = strip.closest('[data-review-dock]') ?? document
    const own = strip.closest('[data-dock-pane]')?.getAttribute('data-dock-pane') ?? null
    const hit = hitTest(root, drag.x, drag.y, drag.id, own, lift.nodes.length)
    held.target = hit?.target ?? null
    const kind = hit?.caret ? 'caret' : hit?.zone ? 'zone' : null
    if (held.marker && held.marker.getAttribute('data-dock-drop') !== kind) {
      held.marker.remove()
      held.marker = null
    }
    if (!hit || !kind) return
    if (!held.marker) {
      held.marker = document.createElement('div')
      held.marker.setAttribute('data-dock-drop', kind)
      held.marker.setAttribute('aria-hidden', 'true')
      held.marker.className = kind === 'caret' ? DOCK_DROP_CARET_CLASS : DOCK_DROP_ZONE_CLASS
      document.body.appendChild(held.marker)
    }
    held.marker.setAttribute('data-dock-drop-target', hit.target.kind === 'split' ? `split:${hit.target.side}` : hit.target.kind)
    if (hit.caret) place(held.marker, { left: hit.caret.x - 1, right: hit.caret.x + 1, top: hit.caret.top, bottom: hit.caret.bottom })
    else if (hit.zone) place(held.marker, hit.zone)
  }, [])

  /** Back over its strip: the copy goes, and the tab slides again. */
  const settleCarry = useCallback(() => {
    const drag = dragRef.current
    if (!drag?.carry) return
    dropCarry(drag)
    if (drag.lift) drag.lift.nodes[drag.lift.from].style.opacity = ''
  }, [])

  // Near an edge, keep scrolling (and re-placing) while the pointer rests.
  const edgeScroll = useCallback(() => {
    frameRef.current = 0
    const drag = dragRef.current
    const strip = stripRef.current
    if (!drag?.active || !strip || drag.carry) return
    const box = strip.getBoundingClientRect()
    const step = drag.x < box.left + EDGE_PX ? -EDGE_SCROLL_PX : drag.x > box.right - EDGE_PX ? EDGE_SCROLL_PX : 0
    if (step === 0) return
    const before = strip.scrollLeft
    strip.scrollLeft += step
    if (strip.scrollLeft === before) return
    slide()
    frameRef.current = requestAnimationFrame(edgeScroll)
  }, [slide])

  /** Whether the pointer is still along the tab's own strip. */
  const alongStrip = (strip: HTMLElement, x: number, y: number) => {
    const scroller = strip.getBoundingClientRect()
    const row = strip.closest<HTMLElement>('[data-dock-strip]')?.getBoundingClientRect()
    const band = row && hasArea(row) ? row : scroller
    return y >= scroller.top - DETACH_PX && y <= scroller.bottom + DETACH_PX && x >= band.left - DETACH_PX && x <= band.right + DETACH_PX
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || event.pointerType === 'touch') return
    const target = event.target as Element
    // The close button is a click target, and a rename field selects text.
    if (target.closest('[data-dock-tab-close], input')) return
    const id = target.closest(`[${DOCK_TAB_ATTR}]`)?.getAttribute(DOCK_TAB_ATTR)
    if (!id) return
    stripRef.current = event.currentTarget
    dragRef.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, lift: null, carry: null }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    const strip = stripRef.current
    if (!drag || !strip || drag.pointerId !== event.pointerId) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.active) {
      const far = Math.abs(event.clientX - drag.startX) >= DRAG_THRESHOLD_PX || (onDrop !== undefined && Math.abs(event.clientY - drag.startY) >= DRAG_THRESHOLD_PX)
      if (!far) return
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
      strip.style.cursor = 'grabbing'
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setDraggingId(drag.id)
    }
    if (onDrop && !alongStrip(strip, drag.x, drag.y)) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
      carry()
      return
    }
    settleCarry()
    slide()
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
