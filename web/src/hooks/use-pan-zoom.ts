import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type Touch as ReactTouch } from 'react'

const MIN_SCALE = 0.5
const MAX_SCALE = 4
const STEP = 0.25
const TOGGLE_SCALE = 2

type Point = { x: number; y: number }

type Gesture = {
  start: Point
  pan: Point
  moved: boolean
  pinchDistance?: number
  pinchScale?: number
}

function distance(a: ReactTouch, b: ReactTouch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function midpoint(a: ReactTouch, b: ReactTouch): Point {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }
}

export interface PanZoomOptions {
  minScale?: number
  maxScale?: number
  step?: number
  wheelSensitivity?: number
}

/**
 * Imperative pan/zoom controller for a single visual target. Gesture frames
 * write straight to its transform; React state is only the accessible zoom
 * announcement and is committed after each gesture.
 */
export function usePanZoom<T extends HTMLElement>(
  targetRef: RefObject<T | null>,
  { minScale = MIN_SCALE, maxScale = MAX_SCALE, step = STEP, wheelSensitivity }: PanZoomOptions = {},
) {
  const scaleRef = useRef(1)
  const panRef = useRef<Point>({ x: 0, y: 0 })
  const gestureRef = useRef<Gesture | null>(null)
  const mouseDraggingRef = useRef(false)
  const lastTouchTapRef = useRef(0)
  const [zoomPercent, setZoomPercent] = useState(100)

  const clampScale = useCallback((scale: number) => Math.min(maxScale, Math.max(minScale, scale)), [maxScale, minScale])

  const clampPan = useCallback((pan: Point, scale = scaleRef.current): Point => {
    const target = targetRef.current
    if (!target || scale <= 1) return { x: 0, y: 0 }
    const maxX = (target.clientWidth * (scale - 1)) / 2
    const maxY = (target.clientHeight * (scale - 1)) / 2
    return { x: Math.min(maxX, Math.max(-maxX, pan.x)), y: Math.min(maxY, Math.max(-maxY, pan.y)) }
  }, [targetRef])

  const paint = useCallback((scale = scaleRef.current, pan = panRef.current) => {
    const target = targetRef.current
    if (!target) return
    target.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`
    target.style.cursor = mouseDraggingRef.current ? 'grabbing' : scale > 1 ? 'grab' : 'zoom-in'
  }, [targetRef])

  useLayoutEffect(() => {
    paint()
  }, [paint])

  const commit = useCallback((scale: number, pan: Point) => {
    scaleRef.current = clampScale(scale)
    panRef.current = clampPan(pan, scaleRef.current)
    paint()
    setZoomPercent(Math.round(scaleRef.current * 100))
  }, [clampPan, clampScale, paint])

  const zoomAt = useCallback((scale: number, point?: Point) => {
    const next = clampScale(scale)
    const previous = scaleRef.current
    const target = targetRef.current
    let pan = panRef.current
    if (point && target && previous !== next) {
      const rect = target.getBoundingClientRect()
      const local = { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 }
      const ratio = next / previous
      pan = { x: local.x - (local.x - pan.x) * ratio, y: local.y - (local.y - pan.y) * ratio }
    }
    commit(next, pan)
  }, [clampScale, commit, targetRef])

  const reset = useCallback(() => {
    mouseDraggingRef.current = false
    gestureRef.current = null
    commit(1, { x: 0, y: 0 })
  }, [commit])
  const zoomIn = useCallback(() => zoomAt(scaleRef.current + step), [step, zoomAt])
  const zoomOut = useCallback(() => zoomAt(scaleRef.current - step), [step, zoomAt])
  const toggle = useCallback(() => zoomAt(scaleRef.current === 1 ? TOGGLE_SCALE : 1), [zoomAt])

  const onWheel = useCallback((event: React.WheelEvent<T>) => {
    event.preventDefault()
    if (event.deltaY === 0) return
    const delta = wheelSensitivity === undefined
      ? event.deltaY < 0 ? step : -step
      : -Math.max(-100, Math.min(100, event.deltaY)) * wheelSensitivity
    zoomAt(scaleRef.current + delta, { x: event.clientX, y: event.clientY })
  }, [step, wheelSensitivity, zoomAt])

  const onTouchStart = useCallback((event: React.TouchEvent<T>) => {
    if (event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]]
      if (!a || !b) return
      gestureRef.current = { start: midpoint(a, b), pan: panRef.current, moved: false, pinchDistance: distance(a, b), pinchScale: scaleRef.current }
      return
    }
    const touch = event.touches[0]
    if (touch) gestureRef.current = { start: { x: touch.clientX, y: touch.clientY }, pan: panRef.current, moved: false }
  }, [])

  const onTouchMove = useCallback((event: React.TouchEvent<T>) => {
    const gesture = gestureRef.current
    if (!gesture) return
    if (event.touches.length === 2 && gesture.pinchDistance && gesture.pinchScale) {
      const [a, b] = [event.touches[0], event.touches[1]]
      if (!a || !b) return
      gesture.moved = true
      const point = midpoint(a, b)
      const next = clampScale(gesture.pinchScale * distance(a, b) / gesture.pinchDistance)
      const ratio = next / scaleRef.current
      const target = targetRef.current
      const rect = target?.getBoundingClientRect()
      const local = rect ? { x: point.x - rect.left - rect.width / 2, y: point.y - rect.top - rect.height / 2 } : { x: 0, y: 0 }
      scaleRef.current = next
      panRef.current = { x: local.x - (local.x - panRef.current.x) * ratio, y: local.y - (local.y - panRef.current.y) * ratio }
      paint(next, panRef.current)
      event.preventDefault()
    } else if (event.touches.length === 1) {
      const touch = event.touches[0]
      if (!touch) return
      const dx = touch.clientX - gesture.start.x
      const dy = touch.clientY - gesture.start.y
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) gesture.moved = true
      if (scaleRef.current <= 1) return
      panRef.current = { x: gesture.pan.x + dx, y: gesture.pan.y + dy }
      paint()
      event.preventDefault()
    }
  }, [clampScale, paint, targetRef])

  const finishGesture = useCallback(() => {
    if (!gestureRef.current) return
    commit(scaleRef.current, panRef.current)
    gestureRef.current = null
  }, [commit])

  const finishTouchGesture = useCallback(() => {
    const gesture = gestureRef.current
    if (!gesture) return
    const wasTap = !gesture.moved && gesture.pinchDistance === undefined
    finishGesture()
    if (!wasTap) {
      lastTouchTapRef.current = 0
      return
    }
    const now = Date.now()
    if (now - lastTouchTapRef.current < 300) {
      lastTouchTapRef.current = 0
      toggle()
    } else {
      lastTouchTapRef.current = now
    }
  }, [finishGesture, toggle])

  const onMouseDown = useCallback((event: React.MouseEvent<T>) => {
    if (event.button !== 0 || scaleRef.current <= 1) return
    gestureRef.current = { start: { x: event.clientX, y: event.clientY }, pan: panRef.current, moved: false }
    mouseDraggingRef.current = true
    paint()
    event.preventDefault()
  }, [paint])

  const onMouseMove = useCallback((event: React.MouseEvent<T>) => {
    const gesture = gestureRef.current
    if (!gesture || scaleRef.current <= 1) return
    panRef.current = { x: gesture.pan.x + event.clientX - gesture.start.x, y: gesture.pan.y + event.clientY - gesture.start.y }
    paint()
  }, [paint])

  const finishMouseGesture = useCallback(() => {
    if (!mouseDraggingRef.current) return
    mouseDraggingRef.current = false
    finishGesture()
  }, [finishGesture])

  const onKeyDown = useCallback((event: React.KeyboardEvent<T>) => {
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomIn() }
    else if (event.key === '-') { event.preventDefault(); zoomOut() }
    else if (event.key === '0') { event.preventDefault(); reset() }
  }, [reset, zoomIn, zoomOut])

  return {
    zoomPercent,
    zoomIn,
    zoomOut,
    reset,
    toggle,
    bind: { onWheel, onTouchStart, onTouchMove, onTouchEnd: finishTouchGesture, onTouchCancel: finishGesture, onDoubleClick: toggle, onMouseDown, onMouseMove, onMouseUp: finishMouseGesture, onMouseLeave: finishMouseGesture, onKeyDown },
  }
}
